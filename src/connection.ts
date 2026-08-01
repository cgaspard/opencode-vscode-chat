import * as vscode from 'vscode';
import { normalizeNewApiKey, resolveApiKeyEdit, type ApiKeyEdit } from './core/servers';
import { normalizeServerUrl } from './core/url';

// Re-exported so existing importers keep the same entry point; the
// implementation lives in the pure core module for unit testing.
export { normalizeServerUrl };

export interface LmServer {
  id: string;
  name: string;
  url: string; // normalized, ends in /vN
  /** The key itself lives in SecretStorage under `secretKey(id)` — never here. */
  hasApiKey?: boolean;
}

let counter = 0;
function genId(): string {
  return 'srv_' + Date.now().toString(36) + (counter++).toString(36);
}

const SERVERS_KEY = 'lmstudioCode.servers';
const ACTIVE_KEY = 'lmstudioCode.activeServer';

function secretKey(id: string): string {
  return `lmstudioCode.apiKey.${id}`;
}

/** Persisted registry of LM Studio servers the user can switch between. */
export class ServerRegistry {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly defaultUrl: string,
  ) {}

  list(): LmServer[] {
    let servers = this.context.globalState.get<LmServer[]>(SERVERS_KEY);
    if (!servers || !servers.length) {
      servers = [{ id: genId(), name: 'Local', url: normalizeServerUrl(this.defaultUrl) }];
      void this.context.globalState.update(SERVERS_KEY, servers);
    }
    return servers;
  }

  active(): LmServer {
    const servers = this.list();
    const id = this.context.globalState.get<string>(ACTIVE_KEY);
    return servers.find((s) => s.id === id) ?? servers[0];
  }

  async setActive(id: string): Promise<void> {
    await this.context.globalState.update(ACTIVE_KEY, id);
  }

  async add(name: string, url: string, apiKey?: string): Promise<LmServer> {
    const servers = this.list();
    const key = normalizeNewApiKey(apiKey);
    const server: LmServer = {
      id: genId(),
      name: (name || '').trim() || 'Server',
      url: normalizeServerUrl(url),
      ...(key ? { hasApiKey: true } : {}),
    };
    // Secret first, flag second — if the secret store fails, hasApiKey must
    // not claim a key that was never saved.
    if (key) {
      await this.context.secrets.store(secretKey(server.id), key);
    }
    servers.push(server);
    await this.context.globalState.update(SERVERS_KEY, servers);
    return server;
  }

  /**
   * `apiKey` is a tri-state edit: undefined keeps the stored key, null removes
   * it, a non-blank string replaces it (see core/servers.ts).
   */
  async update(id: string, name: string, url: string, apiKey?: ApiKeyEdit): Promise<void> {
    const current = this.list();
    if (!current.some((s) => s.id === id)) {
      return; // unknown id: no state to update, and never orphan a secret
    }
    const action = resolveApiKeyEdit(apiKey);
    // Secret first, flag second (see add()).
    if (action.kind === 'set') {
      await this.context.secrets.store(secretKey(id), action.value);
    } else if (action.kind === 'remove') {
      await this.context.secrets.delete(secretKey(id));
    }
    const servers = current.map((s) => {
      if (s.id !== id) {
        return s;
      }
      const hasApiKey =
        action.kind === 'set' ? true : action.kind === 'remove' ? false : !!s.hasApiKey;
      return {
        ...s,
        name: (name || '').trim() || s.name,
        url: normalizeServerUrl(url),
        hasApiKey,
      };
    });
    await this.context.globalState.update(SERVERS_KEY, servers);
  }

  /** The stored API key for a server, or undefined when it has none. */
  async apiKeyFor(id: string): Promise<string | undefined> {
    return (await this.context.secrets.get(secretKey(id))) || undefined;
  }

  async remove(id: string): Promise<void> {
    let servers = this.list().filter((s) => s.id !== id);
    if (!servers.length) {
      servers = [{ id: genId(), name: 'Local', url: normalizeServerUrl(this.defaultUrl) }];
    }
    await this.context.globalState.update(SERVERS_KEY, servers);
    await this.context.secrets.delete(secretKey(id));
    if (this.active().id === id) {
      await this.setActive(servers[0].id);
    }
  }
}

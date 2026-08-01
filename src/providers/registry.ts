import * as vscode from 'vscode';
import {
  BUILTIN_ZEN,
  slugifyProviderId,
  type LocalFlavor,
  type ProviderConnection,
} from '../core/providers';
import { normalizeNewApiKey, resolveApiKeyEdit, type ApiKeyEdit } from '../core/servers';
import { normalizeServerUrl } from '../core/url';

const CONNECTIONS_KEY = 'opencodeChat.providers';

function secretKey(id: string): string {
  return `opencodeChat.apiKey.${id}`;
}

let counter = 0;
function genId(): string {
  return 'prv_' + Date.now().toString(36) + (counter++).toString(36);
}

/**
 * The user's configured providers.
 *
 * Unlike the single-active LM Studio server registry this replaces, every
 * enabled connection is live at once: the OpenCode server is configured with
 * all of them and the model picker shows their models side by side, so
 * switching from a local model to Claude is a model choice, not a server
 * switch.
 *
 * Records live in globalState (they are machine-wide, not per-workspace); API
 * keys live in SecretStorage under `secretKey(id)` and never touch globalState
 * or the webview.
 */
export class ProviderRegistry {
  constructor(private readonly context: vscode.ExtensionContext) {}

  /**
   * Every connection, builtin first. The builtin is synthesized rather than
   * stored so it cannot be corrupted or lost, but the flags a user can set on
   * it — `disabled`, and `hasApiKey` for a paid Zen key — are persisted like
   * any other connection's.
   */
  list(): ProviderConnection[] {
    const stored = this.context.globalState.get<ProviderConnection[]>(CONNECTIONS_KEY) ?? [];
    const builtinOverride = stored.find((c) => c.id === BUILTIN_ZEN.id);
    const builtin: ProviderConnection = {
      ...BUILTIN_ZEN,
      disabled: builtinOverride?.disabled,
      hasApiKey: builtinOverride?.hasApiKey,
    };
    return [builtin, ...stored.filter((c) => c.id !== BUILTIN_ZEN.id)];
  }

  /** Connections that should be written into the OpenCode server config. */
  enabled(): ProviderConnection[] {
    return this.list().filter((c) => !c.disabled);
  }

  byId(id: string): ProviderConnection | undefined {
    return this.list().find((c) => c.id === id);
  }

  byProviderId(providerID: string): ProviderConnection | undefined {
    return this.list().find((c) => c.providerID === providerID);
  }

  /** Provider ids already spoken for, so a new local slug can avoid them. */
  private takenProviderIds(extra: Iterable<string> = []): Set<string> {
    return new Set([...this.list().map((c) => c.providerID), ...extra]);
  }

  /**
   * Add a catalog provider (anthropic, openai, …). One connection per provider
   * id: adding a provider that already exists updates its key instead, which is
   * what a user re-pasting a rotated key means.
   */
  async addCatalog(providerID: string, name: string, apiKey?: string): Promise<ProviderConnection> {
    const existing = this.list().find((c) => c.kind === 'catalog' && c.providerID === providerID);
    if (existing) {
      await this.update(existing.id, { name, apiKey });
      return this.byId(existing.id) ?? existing;
    }
    const key = normalizeNewApiKey(apiKey);
    const conn: ProviderConnection = {
      id: genId(),
      kind: 'catalog',
      providerID,
      name: (name || '').trim() || providerID,
      ...(key ? { hasApiKey: true } : {}),
    };
    // Secret first, flag second — if the secret store fails, hasApiKey must not
    // claim a key that was never saved.
    if (key) {
      await this.context.secrets.store(secretKey(conn.id), key);
    }
    await this.persist([...this.stored(), conn]);
    return conn;
  }

  /**
   * Add a local OpenAI-compatible endpoint. `flavor` is what the probe decided;
   * it only gates optional extras, so 'openai-compatible' is always safe.
   */
  async addLocal(
    name: string,
    url: string,
    opts: { apiKey?: string; flavor?: LocalFlavor } = {},
  ): Promise<ProviderConnection> {
    const key = normalizeNewApiKey(opts.apiKey);
    const displayName = (name || '').trim() || 'Local server';
    const conn: ProviderConnection = {
      id: genId(),
      kind: 'local',
      // The slug is the OpenCode provider id, so it must dodge every catalog id
      // already in play — a local endpoint called "OpenAI" must not become
      // provider.openai and clobber the real one.
      providerID: slugifyProviderId(displayName, this.takenProviderIds()),
      name: displayName,
      baseUrl: normalizeServerUrl(url),
      flavor: opts.flavor ?? 'openai-compatible',
      ...(key ? { hasApiKey: true } : {}),
    };
    if (key) {
      await this.context.secrets.store(secretKey(conn.id), key);
    }
    await this.persist([...this.stored(), conn]);
    return conn;
  }

  /**
   * Edit a connection. `apiKey` is a tri-state: undefined keeps the stored key,
   * null removes it, a non-blank string replaces it (see core/servers.ts).
   * `providerID` is deliberately immutable — it is baked into stored model
   * selections and into the running server's config.
   */
  async update(
    id: string,
    changes: { name?: string; url?: string; apiKey?: ApiKeyEdit; flavor?: LocalFlavor },
  ): Promise<void> {
    const stored = this.stored();
    const isBuiltin = id === BUILTIN_ZEN.id;
    if (!isBuiltin && !stored.some((c) => c.id === id)) {
      return; // unknown id: no state to update, and never orphan a secret
    }
    const action = resolveApiKeyEdit(changes.apiKey);
    // Secret first, flag second (see addCatalog).
    if (action.kind === 'set') {
      await this.context.secrets.store(secretKey(id), action.value);
    } else if (action.kind === 'remove') {
      await this.context.secrets.delete(secretKey(id));
    }
    // The builtin has no stored record until something is set on it. Materialize
    // one so the key flag survives — otherwise the secret is written but
    // `list()` keeps reporting the provider as keyless.
    const base =
      isBuiltin && !stored.some((c) => c.id === id) ? [...stored, { ...BUILTIN_ZEN }] : stored;
    const next = base.map((c) => {
      if (c.id !== id) {
        return c;
      }
      const hasApiKey =
        action.kind === 'set' ? true : action.kind === 'remove' ? false : !!c.hasApiKey;
      return {
        ...c,
        name: (changes.name ?? '').trim() || c.name,
        ...(c.kind === 'local' && changes.url !== undefined
          ? { baseUrl: normalizeServerUrl(changes.url, c.baseUrl) }
          : {}),
        ...(changes.flavor ? { flavor: changes.flavor } : {}),
        hasApiKey,
      };
    });
    await this.persist(next);
  }

  /** Park a connection without losing its settings (or bring it back). */
  async setDisabled(id: string, disabled: boolean): Promise<void> {
    const stored = this.stored();
    if (id === BUILTIN_ZEN.id) {
      // The builtin isn't stored, so materialize a record just to carry the flag.
      const existing = stored.find((c) => c.id === BUILTIN_ZEN.id);
      const rest = stored.filter((c) => c.id !== BUILTIN_ZEN.id);
      // Carry the key flag across a disable/enable cycle. The secret itself is
      // never touched here, so dropping the flag would strand a stored key:
      // the config would keep using it while the panel showed no key at all.
      const keyed = !!existing?.hasApiKey;
      const record = { ...BUILTIN_ZEN, ...(keyed ? { hasApiKey: true } : {}), disabled };
      await this.persist(disabled || keyed ? [...rest, record] : rest);
      return;
    }
    await this.persist(stored.map((c) => (c.id === id ? { ...c, disabled } : c)));
  }

  /** The stored API key for a connection, or undefined when it has none. */
  async apiKeyFor(id: string): Promise<string | undefined> {
    return (await this.context.secrets.get(secretKey(id))) || undefined;
  }

  /** Every enabled connection paired with its key, for building the server config. */
  async enabledWithKeys(): Promise<Array<{ conn: ProviderConnection; apiKey?: string }>> {
    return Promise.all(
      this.enabled().map(async (conn) => ({ conn, apiKey: await this.apiKeyFor(conn.id) })),
    );
  }

  /**
   * Remove a connection. The builtin cannot be removed — it has no stored
   * settings to delete — so removing it disables it instead.
   */
  async remove(id: string): Promise<void> {
    if (id === BUILTIN_ZEN.id) {
      await this.setDisabled(id, true);
      return;
    }
    await this.persist(this.stored().filter((c) => c.id !== id));
    await this.context.secrets.delete(secretKey(id));
  }

  /** The persisted records, excluding the synthesized builtin view. */
  private stored(): ProviderConnection[] {
    return this.context.globalState.get<ProviderConnection[]>(CONNECTIONS_KEY) ?? [];
  }

  private async persist(connections: ProviderConnection[]): Promise<void> {
    await this.context.globalState.update(CONNECTIONS_KEY, connections);
  }
}

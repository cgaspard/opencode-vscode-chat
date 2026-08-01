import type { ProbeStatus } from '../core/health';
import type { ProviderConnection } from '../core/providers';
import { logError } from '../logger';
import type { ProviderRegistry } from '../providers/registry';
import { LocalClient, type LocalModel } from './client';

/**
 * The pool of live clients for the user's local endpoints, one per connection.
 *
 * The single-server design this replaces held exactly one client in the bridge
 * deps and swapped its base URL on a server switch. With every enabled provider
 * live at once, the pool is keyed by connection id and reconciled against the
 * registry whenever it changes: clients survive unrelated edits (keeping their
 * probe caches warm) and are dropped only when their connection goes away.
 *
 * Cloud providers have no client here — they are reached through the OpenCode
 * server, which holds their credentials.
 */
export class LocalEndpoints {
  private readonly clients = new Map<string, LocalClient>();

  /**
   * Reconcile the pool with the registry. `keys` supplies the stored API key
   * per connection id (already read from SecretStorage by the caller, which is
   * the only component allowed to touch it).
   */
  sync(connections: ProviderConnection[], keys: Map<string, string | undefined>): void {
    const local = connections.filter((c) => c.kind === 'local');
    const live = new Set(local.map((c) => c.id));
    for (const id of [...this.clients.keys()]) {
      if (!live.has(id)) {
        this.clients.delete(id);
      }
    }
    for (const conn of local) {
      const existing = this.clients.get(conn.id);
      if (existing) {
        existing.setBaseUrl(conn.baseUrl ?? existing.getBaseUrl());
        existing.setFlavor(conn.flavor ?? 'openai-compatible');
        existing.setApiKey(keys.get(conn.id));
      } else {
        this.clients.set(
          conn.id,
          new LocalClient(conn.baseUrl ?? '', keys.get(conn.id), conn.flavor ?? 'openai-compatible'),
        );
      }
    }
  }

  get(connectionId: string): LocalClient | undefined {
    return this.clients.get(connectionId);
  }

  get size(): number {
    return this.clients.size;
  }

  ids(): string[] {
    return [...this.clients.keys()];
  }

  /** Probe every endpoint concurrently, returning a status per connection id. */
  async probeAll(maxAgeMs = 0, authAware = false): Promise<Map<string, ProbeStatus>> {
    const out = new Map<string, ProbeStatus>();
    await Promise.all(
      [...this.clients.entries()].map(async ([id, client]) => {
        try {
          out.set(id, await client.probeHealth(maxAgeMs, authAware));
        } catch (err) {
          logError(`probe failed for local endpoint ${id}`, err);
          out.set(id, 'unreachable');
        }
      }),
    );
    return out;
  }

  /**
   * Every endpoint's models, keyed by connection id. A failing endpoint yields
   * an empty list rather than failing the whole listing — one dead local server
   * must not blank out the model picker for the others.
   */
  async listAllModels(): Promise<Map<string, LocalModel[]>> {
    const out = new Map<string, LocalModel[]>();
    await Promise.all(
      [...this.clients.entries()].map(async ([id, client]) => {
        try {
          out.set(id, await client.listModels());
        } catch (err) {
          logError(`could not list models for local endpoint ${id}`, err);
          out.set(id, []);
        }
      }),
    );
    return out;
  }
}

/**
 * Reconcile the pool against the registry, reading each connection's key from
 * SecretStorage. Call after any registry mutation — and before spawning the
 * OpenCode server, whose config enumerates models through these clients.
 */
export async function syncEndpointsFromRegistry(
  registry: ProviderRegistry,
  endpoints: LocalEndpoints,
): Promise<void> {
  const withKeys = await registry.enabledWithKeys();
  endpoints.sync(
    withKeys.map(({ conn }) => conn),
    new Map(withKeys.map(({ conn, apiKey }) => [conn.id, apiKey])),
  );
}

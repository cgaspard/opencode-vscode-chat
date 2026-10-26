import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { ExtensionConfig, getConfig } from '../config';
import { declaredContext } from '../core/context';
import { variantsForModel } from '../core/effort';
import { augmentedPath, withLocalEnvironment } from '../core/mcp';
import { opencodePermission } from '../core/permission';
import type { ProviderConnection } from '../core/providers';
import type { LocalEndpoints } from '../local/endpoints';
import { log, logError } from '../logger';
import { discoverMcpServers } from '../mcp/discovery';
import type { ProviderRegistry } from '../providers/registry';
import { createHost, type SdkHost } from './embedded';
import { BUILD_PROMPT, PLAN_PROMPT } from './prompts';
import { OpencodeV2Client } from './v2client';

export interface ServerStartResult {
  /** Where the engine runs, for logs only: there is no network address. */
  baseUrl: string;
  client: OpencodeV2Client;
}

export interface Disposable {
  dispose(): void;
}

/** Shown in logs where a server URL used to be. */
const EMBEDDED_URL = 'embedded://opencode';

/**
 * Owns the embedded OpenCode engine (OpenCode 2, running in-process through
 * @opencode/sdk), configured with every provider the user has enabled. Config
 * is handed to the engine in memory, so nothing is written to the user's
 * workspace or global config.
 *
 * Still named a "server" manager: the bridge's lifecycle (start, stale-config
 * restart, dispose) is unchanged, only what it starts is.
 */
export class OpencodeServerManager {
  private host: SdkHost | undefined;
  private client: OpencodeV2Client | undefined;
  private starting: Promise<ServerStartResult> | undefined;
  /**
   * A fingerprint of the provider set the running engine's config was built
   * from. The config is baked into the host at creation, so if anything it
   * depends on changes afterwards (a provider added or removed, a key edited, a
   * base URL changed) the running instance is stale and start() must recreate
   * it instead of reusing it.
   */
  private bakedIdentity: string | undefined;
  private readonly exitListeners = new Set<() => void>();

  constructor(
    private readonly cfg: ExtensionConfig,
    private readonly registry: ProviderRegistry,
    private readonly endpoints: LocalEndpoints,
    /** Extension install dir — holds the bundled engine in `opencode-sdk/`. */
    private readonly extensionPath: string,
    /** Private data dir for the engine, isolated from the user's own OpenCode. */
    private readonly dataDir: string,
  ) {}

  get isRunning(): boolean {
    return !!this.client;
  }

  /**
   * Register a callback fired whenever the engine stops unexpectedly.
   * Multiple bridges (sidebar + secondary + editor tabs) share one manager, so
   * each registers its own listener and disposes it on teardown.
   */
  addExitListener(cb: () => void): Disposable {
    this.exitListeners.add(cb);
    return { dispose: () => this.exitListeners.delete(cb) };
  }

  /**
   * Fingerprint of everything the injected config depends on. Includes the key
   * *values*, not just their presence, so rotating a key recreates the engine —
   * a stale one would keep authenticating with the old key.
   */
  private async currentIdentity(): Promise<string> {
    const conns = await this.registry.enabledWithKeys();
    return JSON.stringify([
      conns
        .map(({ conn, apiKey }) => [
          conn.providerID,
          conn.kind,
          conn.baseUrl ?? null,
          conn.flavor ?? null,
          apiKey ?? null,
        ])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      // permissionMode is part of the identity for the same reason as keys and
      // urls: it's baked into the config at creation, so a running instance with
      // a different mode is stale and must be recreated on the next start().
      getConfig().permissionMode,
    ]);
  }

  /** Start (or return the in-flight start of) the engine. Idempotent. */
  async start(): Promise<ServerStartResult> {
    if (this.client) {
      if (this.bakedIdentity === (await this.currentIdentity())) {
        return { baseUrl: EMBEDDED_URL, client: this.client };
      }
      // The provider set changed since this instance was configured (a provider
      // added or removed, a key edited, a base URL changed, or a start that
      // raced ahead of key hydration) — reusing it would send chat requests
      // with stale credentials or miss a provider entirely.
      log('opencode config is stale (providers changed) — recreating the engine');
      this.dispose();
    }
    if (this.starting) {
      return this.starting;
    }
    this.starting = this.doStart().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async doStart(): Promise<ServerStartResult> {
    const bakedIdentity = await this.currentIdentity();
    const configContent = await this.buildConfigContent();
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
    const version = this.engineVersion();
    log(`starting embedded opencode ${version} (cwd=${cwd})`);
    const host = await createHost(this.extensionPath, { root: this.dataDir }, configContent);
    this.host = host;
    this.client = new OpencodeV2Client(host, cwd, version);
    this.bakedIdentity = bakedIdentity;
    log('embedded opencode ready');
    return { baseUrl: EMBEDDED_URL, client: this.client };
  }

  /** The bundled engine's version, from the stamp the build writes. */
  private engineVersion(): string {
    try {
      return fs.readFileSync(path.join(this.extensionPath, 'opencode-sdk', 'version'), 'utf8').split('\n')[0].trim();
    } catch {
      return 'unknown';
    }
  }

  /**
   * Build the engine config declaring every enabled provider.
   *
   * Three shapes, one per connection kind:
   *
   *   builtin  Nothing is emitted *unless* a key is stored. OpenCode serves its
   *            own hosted provider unconditionally on a free public key
   *            (verified: it answers prompts with no key), so declaring it
   *            keyless could only break it. A paid Zen key is the one reason to
   *            declare it — same `options.apiKey` shape as a catalog provider,
   *            which is what upgrades the session off the free tier.
   *   catalog  Just `options.apiKey`. Everything else — the model list, prices,
   *            context limits, reasoning variants — comes from OpenCode's own
   *            catalog, which is why 176 providers work with no per-provider
   *            code here. Verified: a bare config returns only the builtin,
   *            while injecting a key makes the provider and its full model list
   *            appear in GET /config/providers.
   *   local    A full openai-compatible declaration with the models enumerated
   *            from the endpoint itself, because no catalog knows what someone
   *            is running on their own machine.
   */
  private async buildConfigContent(): Promise<string> {
    const provider: Record<string, unknown> = {};
    let connections: Array<{ conn: ProviderConnection; apiKey?: string }> = [];
    try {
      connections = await this.registry.enabledWithKeys();
    } catch (err) {
      logError('could not read the provider registry for config', err);
    }
    this.pruneKeyFiles(connections.map(({ conn }) => conn.id));

    for (const { conn, apiKey } of connections) {
      if (conn.kind === 'builtin') {
        // Keyless is the normal case and must stay undeclared — the server
        // already serves Zen on its public key. With a key, declare it so the
        // paid tier is used instead.
        if (apiKey) {
          provider[conn.providerID] = { options: this.apiKeyOption(conn.id, apiKey) };
        }
        continue;
      }
      if (conn.kind === 'catalog') {
        if (!apiKey) {
          // A keyless catalog provider would be declared but unusable, and
          // would then show up in the picker as a provider with no models.
          continue;
        }
        provider[conn.providerID] = { options: this.apiKeyOption(conn.id, apiKey) };
        continue;
      }
      provider[conn.providerID] = {
        npm: '@ai-sdk/openai-compatible',
        name: conn.name,
        options: {
          baseURL: conn.baseUrl,
          includeUsage: true,
          // Same Bearer key discovery uses — for servers behind an auth proxy.
          ...this.apiKeyOption(conn.id, apiKey),
        },
        ...(await this.localModelsFor(conn)),
      };
    }

    // MCP servers discovered from .mcp.json / .vscode/mcp.json / VS Code user
    // settings / our own `opencodeChat.mcpServers`. Tokens like ${VAR} are
    // already resolved to literals (the injected config is not substituted by
    // OpenCode), so what we inject is ready to spawn as-is. Their tools flow
    // through OpenCode's existing tool-call + permission machinery for free.
    let mcp: ReturnType<typeof discoverMcpServers>['map'] = {};
    try {
      // stdio servers inherit the extension host's environment. When VS Code
      // was launched from a GUI context its PATH can be minimal (the #1 reason
      // npx/uvx-based servers fail to start), so add the usual install
      // locations; existing entries stay first so the user's toolchain wins.
      mcp = withLocalEnvironment(discoverMcpServers().map, {
        PATH: augmentedPath(process.env.PATH, os.homedir(), path.delimiter),
      });
    } catch (err) {
      logError('could not discover MCP servers', err);
    }

    // Override the build/plan agent prompts so the model identifies as
    // "OpenCode Agent" instead of OpenCode's built-in "You are opencode…".
    const config = {
      $schema: 'https://opencode.ai/config.json',
      // Only the providers configured here. OpenCode would otherwise also
      // enable any provider it can find a key for in the environment (an
      // exported OPENAI_API_KEY) and auto-discover local servers — and its
      // internal title/summary agents could then bill a key the user never
      // gave this extension.
      enabled_providers: connections.map(({ conn }) => conn.providerID),
      // Tool-approval posture (default / strict / bypass), read fresh so a
      // mode change applies on restart. Every mode keeps the built-in
      // `question` tool at "allow": the picker is the interaction (the bridge
      // relays `question.asked` and replies through the form API), so an
      // approval gate in front of it would be redundant.
      permission: opencodePermission(getConfig().permissionMode),
      agent: {
        build: { prompt: BUILD_PROMPT },
        plan: { prompt: PLAN_PROMPT },
      },
      ...(Object.keys(provider).length ? { provider } : {}),
      ...(Object.keys(mcp).length ? { mcp } : {}),
    };
    return JSON.stringify(config);
  }

  /**
   * The `models` block for a local endpoint, or {} when we could not enumerate
   * it (a server that is down at spawn time still gets its provider declared,
   * so it starts working as soon as it comes back).
   */
  private async localModelsFor(conn: ProviderConnection): Promise<Record<string, unknown>> {
    const models: Record<string, Record<string, unknown>> = {};
    const ctx = getConfig().minContextLength; // read fresh so context-size changes apply on restart
    try {
      const client = this.endpoints.get(conn.id);
      const list = (await client?.listModels()) ?? [];
      // Only a load lifecycle (LM Studio) makes the window ours to name. A
      // llama.cpp/vLLM/oMLX process fixed its window at launch, so `ctx` is not
      // a request there — it would only shrink a window we cannot grow back.
      const lifecycle = !!client?.supportsLifecycle;
      for (const m of list) {
        // OpenCode drops image attachments unless the model is declared with
        // attachment + image modality. Align the context limit with the window
        // the server actually serves so OpenCode compacts before it overflows —
        // and never declare more context than the model supports.
        const perModel = declaredContext(ctx, m.maxContextLength, lifecycle);
        models[m.id] = {
          name: m.displayName,
          attachment: !!m.vision,
          reasoning: true,
          tool_call: m.toolUse ?? true,
          modalities: {
            input: m.vision ? ['text', 'image'] : ['text'],
            output: ['text'],
          },
          // Output budget: generous enough for reasoning models that emit long
          // <think> blocks before answering (8192 truncated them mid-thought),
          // but still a fraction of the window so input isn't crowded out.
          limit: { context: perModel, output: Math.min(32768, Math.floor(perModel / 4)) },
          // Reasoning-effort levels, selectable per message via PromptBody.variant.
          // Declared unconditionally for every model — identical for all of them —
          // so this config never depends on a user setting and changing effort
          // never needs a server restart. Naming a variant the model doesn't
          // support is a verified silent no-op, so over-declaring is free.
          // Catalog models get no such table: they publish their own.
          variants: variantsForModel(),
        };
      }
    } catch (err) {
      logError(`could not enumerate models for local endpoint ${conn.name}`, err);
    }
    return Object.keys(models).length ? { models } : {};
  }

  /** Directory holding the per-connection key files. */
  private get keyDir(): string {
    return path.join(this.dataDir, 'keys');
  }

  /**
   * Provider `apiKey` option for the injected config. Each key is written to
   * its own 0600 file in our private dataDir and referenced via OpenCode's
   * `{file:...}` placeholder, substituted when the engine loads the config, so
   * the config text itself never carries a secret. Falls back to the literal
   * only if the file can't be written.
   */
  private apiKeyOption(connectionId: string, apiKey: string | undefined): Record<string, string> {
    const keyFile = path.join(this.keyDir, connectionId);
    if (!apiKey) {
      fs.rmSync(keyFile, { force: true });
      return {};
    }
    try {
      fs.mkdirSync(this.keyDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(keyFile, apiKey, { mode: 0o600 });
      fs.chmodSync(keyFile, 0o600); // writeFileSync mode only applies on create
      return { apiKey: `{file:${keyFile}}` };
    } catch (err) {
      logError('could not write api key file; passing key inline', err);
      return { apiKey };
    }
  }

  /**
   * Delete key files whose connection no longer exists. Without this, removing
   * a provider would leave its key readable on disk indefinitely — the registry
   * drops the SecretStorage entry, so this file would be the only copy left.
   */
  private pruneKeyFiles(liveIds: string[]): void {
    const live = new Set(liveIds);
    try {
      if (!fs.existsSync(this.keyDir)) {
        return;
      }
      for (const name of fs.readdirSync(this.keyDir)) {
        if (!live.has(name)) {
          fs.rmSync(path.join(this.keyDir, name), { force: true });
        }
      }
    } catch (err) {
      logError('could not prune stale api key files', err);
    }
  }

  async restart(): Promise<ServerStartResult> {
    this.dispose();
    return this.start();
  }

  dispose(): void {
    if (this.client) {
      log('stopping embedded opencode');
    }
    this.client?.dispose();
    const host = this.host;
    this.host = undefined;
    this.client = undefined;
    this.bakedIdentity = undefined;
    // Closing releases the engine's watchers, MCP children and database.
    void host?.close().catch((err: unknown) => logError('closing embedded opencode', err));
  }
}

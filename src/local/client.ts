import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { restRoot } from '../config';
import type { ReasoningCapability } from '../core/effort';
import { ProbeStatus } from '../core/health';
import type { LocalFlavor } from '../core/providers';
import { log, logError } from '../logger';

/**
 * Whether a fetch failure came from our own AbortSignal.timeout rather than a
 * connection-level error. Undici surfaces the signal's DOMException directly
 * (TimeoutError) or wrapped as the `cause` of a "fetch failed" TypeError.
 */
function isTimeoutError(err: unknown): boolean {
  if (!err || typeof err !== 'object') {
    return false;
  }
  const e = err as { name?: string; cause?: { name?: string } };
  return (
    e.name === 'TimeoutError' ||
    e.name === 'AbortError' ||
    e.cause?.name === 'TimeoutError' ||
    e.cause?.name === 'AbortError'
  );
}

export interface LocalModel {
  id: string;
  displayName: string;
  type: string; // llm | vlm | embedding | ...
  state?: string; // loaded | not-loaded
  maxContextLength?: number;
  loadedContextLength?: number;
  toolUse?: boolean;
  vision?: boolean;
  quantization?: string;
  arch?: string;
  publisher?: string; // e.g. "unsloth", "lmstudio-community" — disambiguates same-named models
  format?: string; // runtime format, e.g. "MLX" or "GGUF" (from compatibility_type)
  /**
   * Declared reasoning support, from LM Studio's `/api/v1/models`
   * capabilities.reasoning. `null` = the model explicitly reports none (hide the
   * effort control); `undefined` = unknown, because only LM Studio reports this
   * and a plain OpenAI-compatible server cannot. Unknown is never treated as
   * unsupported — see src/core/effort.ts.
   */
  reasoning?: ReasoningCapability | null;
}

/**
 * Discovery + lifecycle helper for one local, OpenAI-compatible inference
 * server (LM Studio, Ollama, vLLM, or anything else that speaks /v1).
 *
 * Everything here works against the plain OpenAI-compatible surface. LM Studio
 * additionally exposes a native REST API that reports real model metadata
 * (context windows, quantization, tool/vision/reasoning capability, load state)
 * and can load or eject models — a meaningful difference for local models,
 * where a too-small context window is the single most common failure. Those
 * extras are gated on `flavor === 'lmstudio'`; every other server degrades to
 * the generic path, which is always safe.
 */
export class LocalClient {
  constructor(
    private baseUrl: string,
    private apiKey?: string,
    private flavor: LocalFlavor = 'openai-compatible',
  ) {}

  /** Cached probe result so sibling panels' health ticks share one request. */
  private probe: { startedAt: number; authAware: boolean; promise: Promise<ProbeStatus> } | undefined;
  /** Whether this server answers the cheap /lmstudio-greeting liveness probe. */
  private greetingSupported: boolean | undefined;
  /** In-flight model listing, shared by concurrent callers. */
  private listing: Promise<LocalModel[]> | undefined;

  setBaseUrl(url: string): void {
    if (url !== this.baseUrl) {
      // A different server: forget everything we learned about the old one.
      this.probe = undefined;
      this.greetingSupported = undefined;
      this.listing = undefined;
    }
    this.baseUrl = url;
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  getFlavor(): LocalFlavor {
    return this.flavor;
  }

  setFlavor(flavor: LocalFlavor): void {
    if (flavor !== this.flavor) {
      this.listing = undefined; // a different flavor lists models differently
    }
    this.flavor = flavor;
  }

  /** True when this endpoint supports load/eject and context enforcement. */
  get supportsLifecycle(): boolean {
    return this.flavor === 'lmstudio';
  }

  /** Bearer key for servers behind an authenticating proxy. */
  setApiKey(key: string | undefined): void {
    const next = (key ?? '').trim() || undefined;
    if (next !== this.apiKey) {
      // A cached auth verdict — and a listing fetched under the old key — are
      // both stale under a new key.
      this.probe = undefined;
      this.listing = undefined;
    }
    this.apiKey = next;
  }

  getApiKey(): string | undefined {
    return this.apiKey;
  }

  private get rest(): string {
    return restRoot(this.baseUrl);
  }

  /**
   * Fetch headers for this server. Local servers are typically
   * unauthenticated; the key exists for instances behind a reverse proxy, sent
   * as a standard OpenAI-style `Authorization: Bearer` (the same scheme the
   * chat path uses via the provider's `apiKey` option, so discovery and
   * inference always authenticate identically).
   */
  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      ...(extra ?? {}),
      ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
    };
  }

  /**
   * Auth-aware connect-time probe. 'auth-required' means the server answered
   * but rejected our credentials (401/403) — a very different user problem
   * from 'unreachable', so callers can say "fix your key" instead of "start
   * the server". 'timeout' means it didn't answer in time — a saturated server
   * mid-generation looks like this, so callers must not treat it as proof the
   * server is gone. Used for deliberate connects; the periodic health loop uses
   * the cheaper `probeHealth` instead.
   */
  async checkConnectionStatus(): Promise<ProbeStatus> {
    try {
      const res = await fetch(`${this.baseUrl}/models`, {
        signal: AbortSignal.timeout(4000),
        headers: this.headers(),
      });
      if (res.status === 401 || res.status === 403) {
        return 'auth-required';
      }
      return res.ok ? 'ok' : 'unreachable';
    } catch (err) {
      return isTimeoutError(err) ? 'timeout' : 'unreachable';
    }
  }

  /**
   * Cheap liveness probe for the periodic health loop. On LM Studio the primary
   * is `/lmstudio-greeting` — the same endpoint the first-party `lms` CLI health
   * checks; it is auth-exempt and far lighter than a model listing. Servers that
   * don't serve it (other flavors, older builds, reverse proxies) permanently
   * fall back to the auth-aware `${baseUrl}/models` probe.
   *
   * Because the greeting bypasses auth, the cheap probe deliberately does NOT
   * detect a key going bad mid-session — that surfaces on the next user
   * action, and every reconnect path re-validates via `checkConnectionStatus`.
   * Pass `authAware: true` (the bridge does while disconnected) to force the
   * auth-aware /models probe — a greeting that answers 200 to a rejected key
   * must not convince the healer to spin doInit in a reconnect loop.
   *
   * `maxAgeMs` shares one probe across near-simultaneous callers (every open
   * panel runs its own health tick against this shared client): a result
   * younger than maxAgeMs — including one still in flight — is reused instead
   * of issuing another request. An auth-aware result satisfies a cheap
   * request, never the reverse. Deliberately does not log.
   */
  async probeHealth(maxAgeMs = 0, authAware = false): Promise<ProbeStatus> {
    const now = Date.now();
    if (
      this.probe &&
      now - this.probe.startedAt <= maxAgeMs &&
      (this.probe.authAware || !authAware)
    ) {
      return this.probe.promise;
    }
    this.probe = {
      startedAt: now,
      authAware,
      promise: authAware ? this.checkConnectionStatus() : this.probeHealthOnce(),
    };
    return this.probe.promise;
  }

  private async probeHealthOnce(): Promise<ProbeStatus> {
    // Snapshot the target: a probe still in flight across a server switch must
    // not write its verdicts onto the new server's state.
    const url = this.baseUrl;
    if (this.flavor === 'lmstudio' && this.greetingSupported !== false) {
      try {
        const res = await fetch(`${this.rest}/lmstudio-greeting`, {
          signal: AbortSignal.timeout(3000),
        });
        if (res.ok) {
          if (this.baseUrl === url) {
            this.greetingSupported = true;
          }
          return 'ok';
        }
        if (res.status === 404 && this.baseUrl === url) {
          // Definitively absent (older build / proxy route) — stop asking.
          // Other statuses (a proxy's transient 502/503) must NOT latch: fall
          // through to the /models probe just for this round.
          this.greetingSupported = false;
        }
      } catch (err) {
        if (isTimeoutError(err)) {
          return 'timeout'; // don't pile a second probe on a slow server
        }
        // Connection-level failure: fall through and let the /models probe
        // decide (it distinguishes auth-required from unreachable).
      }
    }
    return this.checkConnectionStatus();
  }

  /**
   * List chat-capable models (embeddings filtered out), richest metadata first.
   * LM Studio has a native catalog worth using; everything else goes through the
   * OpenAI-compatible `/v1/models`, which carries an id and nothing more.
   */
  async listModels(): Promise<LocalModel[]> {
    if (this.listing) {
      return this.listing;
    }
    const p = this.doListModels().finally(() => {
      if (this.listing === p) {
        this.listing = undefined;
      }
    });
    this.listing = p;
    return p;
  }

  private async doListModels(): Promise<LocalModel[]> {
    if (this.flavor === 'lmstudio') {
      const rich = await this.listLmStudioModels();
      if (rich.length) {
        return rich;
      }
    }
    // 'openai-compatible' is tried too, not just 'omlx': an endpoint the user
    // added by hand is stored under that flavor (the URL was typed, so nothing
    // probed it), and oMLX behind it would otherwise report no vision and no
    // context window. The request is a single localhost call that 404s
    // immediately on anything else, and listings are cached per key/flavor.
    if (this.flavor === 'omlx' || this.flavor === 'openai-compatible') {
      const rich = await this.listOmlxModels();
      if (rich.length) {
        return rich;
      }
    }
    return this.listOpenAiModels();
  }

  /**
   * LM Studio's native catalog.
   *
   * Primary source is `/api/v1/models`: it's the *canonical* keyed list (one
   * entry per model, keyed by e.g. "unsloth/qwen3.6-27b-mlx"), which LM Studio's
   * own UI uses. `/api/v0/models` is avoided as the primary because it can
   * surface a phantom duplicate of a loaded model under its bare instance id
   * (e.g. both "qwen3.6-27b-mlx" and "unsloth/qwen3.6-27b-mlx"). The `key`
   * doubles as the model id everywhere — LM Studio accepts it for load and for
   * `/v1/chat/completions` inference, resolving it to the loaded instance.
   */
  private async listLmStudioModels(): Promise<LocalModel[]> {
    try {
      const res = await fetch(`${this.rest}/api/v1/models`, {
        signal: AbortSignal.timeout(8000),
        headers: this.headers(),
      });
      if (res.ok) {
        const json = (await res.json()) as { models?: any[] };
        const arr = json.models ?? [];
        return arr
          .filter(
            (m) => m && typeof m.key === 'string' && !/embed/i.test(m.type ?? '') && !/embed/i.test(m.key),
          )
          .map((m): LocalModel => {
            const instance = (m.loaded_instances ?? [])[0];
            const caps = m.capabilities ?? {};
            return {
              id: m.key,
              displayName: prettyName(m.key),
              type: m.type ?? 'llm',
              state: instance ? 'loaded' : 'not-loaded',
              maxContextLength: m.max_context_length,
              loadedContextLength: instance?.config?.context_length,
              toolUse: !!(caps.trained_for_tool_use ?? caps.tool_use),
              vision: !!caps.vision,
              quantization: typeof m.quantization === 'object' ? m.quantization?.name : m.quantization,
              arch: m.architecture ?? m.arch,
              publisher: m.publisher,
              format: prettyFormat(m.format),
              // Observed shape: { allowed_options: ["off","on"], default: "on" },
              // absent/null on non-reasoning models. Only /api/v1 reports it.
              reasoning: caps.reasoning
                ? {
                    allowedOptions: Array.isArray(caps.reasoning.allowed_options)
                      ? caps.reasoning.allowed_options
                      : [],
                    default: caps.reasoning.default,
                  }
                : null,
            };
          });
      }
    } catch (err) {
      logError('listModels via /api/v1/models failed, falling back to /api/v0/models', err);
    }
    // Fallback: the v0 rich endpoint (may include phantom dup rows, but still
    // carries metadata) when v1 is unavailable on an older LM Studio.
    try {
      const res = await fetch(`${this.rest}/api/v0/models`, {
        signal: AbortSignal.timeout(8000),
        headers: this.headers(),
      });
      if (res.ok) {
        const json = (await res.json()) as { data?: any[] };
        const arr = json.data ?? [];
        return arr
          .filter((m) => m && !/embed/i.test(m.type ?? '') && !/embed/i.test(m.id ?? ''))
          .map((m): LocalModel => ({
            id: m.id,
            displayName: prettyName(m.id),
            type: m.type ?? 'llm',
            state: m.state,
            maxContextLength: m.max_context_length,
            loadedContextLength: m.loaded_context_length,
            toolUse: Array.isArray(m.capabilities) ? m.capabilities.includes('tool_use') : undefined,
            vision: m.type === 'vlm',
            quantization: m.quantization,
            arch: m.arch,
            publisher: m.publisher,
            format: prettyFormat(m.compatibility_type),
          }));
      }
    } catch (err) {
      logError('listModels via /api/v0/models failed, falling back to /v1/models', err);
    }
    return [];
  }

  /** The OpenAI-compatible listing every local server supports. */
  /**
   * oMLX's model catalog, from `/v1/models/status`.
   *
   * oMLX's OpenAI surface is deliberately minimal — `/v1/models` carries an id
   * and `max_model_len` and nothing else, so a model served through it looks
   * text-only even when it is a VLM. `/v1/models/status` is the same list with
   * the metadata attached: `model_type` ('vlm' for multimodal), the configured
   * `max_context_window`, and load state.
   *
   * Ids are reconciled deliberately: this endpoint reports the on-disk id
   * ("Qwen3.8-Flash-Next-oQ4e-mtp") *plus* `model_alias`, while `/v1/models`
   * and `/v1/chat/completions` speak the alias when one is set. The alias has
   * to win or the picker would offer an id inference then rejects.
   */
  private async listOmlxModels(): Promise<LocalModel[]> {
    try {
      const res = await fetch(`${this.baseUrl}/models/status`, {
        signal: AbortSignal.timeout(8000),
        headers: this.headers(),
      });
      if (res.ok) {
        const json = (await res.json()) as { models?: any[] };
        return (json.models ?? [])
          .filter((m) => m && !m.is_helper && !/embed/i.test(m.model_type ?? ''))
          .map((m): LocalModel => {
            const id = m.model_alias || m.id;
            return {
              id,
              displayName: prettyName(id),
              type: m.model_type ?? 'llm',
              state: m.loaded ? 'loaded' : 'not-loaded',
              // `model_context_length` is what the checkpoint supports;
              // `max_context_window` is what this server will actually accept,
              // so the smaller configured value is the honest ceiling.
              maxContextLength: m.max_context_window ?? m.model_context_length,
              loadedContextLength: m.loaded ? m.max_context_window : undefined,
              vision: m.model_type === 'vlm' || m.engine_type === 'vlm',
              // `reasoning` is deliberately left unset. oMLX reports only a
              // per-model `thinking_default` boolean, not the option names a
              // ReasoningCapability describes — declaring an empty
              // `allowedOptions` would assert the model offers no levels.
              // Unset means "unknown", which effort.ts already reads as
              // supported-with-our-own-variant-table rather than unsupported.
            };
          });
      }
    } catch (err) {
      logError('listModels via /v1/models/status failed, falling back to /v1/models', err);
    }
    return [];
  }

  private async listOpenAiModels(): Promise<LocalModel[]> {
    try {
      const res = await fetch(`${this.baseUrl}/models`, {
        signal: AbortSignal.timeout(8000),
        headers: this.headers(),
      });
      if (res.ok) {
        const json = (await res.json()) as { data?: any[] };
        return (json.data ?? [])
          .filter((m) => m && typeof m.id === 'string' && !/embed/i.test(m.id))
          .map(
            (m): LocalModel => ({
              id: m.id,
              displayName: prettyName(m.id),
              type: m.type ?? 'llm',
              // vLLM and oMLX both advertise the served context as
              // `max_model_len` here. Without it the picker falls back to the
              // `minContextLength` setting and reports a window that has
              // nothing to do with the server's actual limit.
              maxContextLength: m.max_model_len ?? m.max_context_length,
            }),
          );
      }
    } catch (err) {
      logError('listModels via /v1/models failed', err);
    }
    return [];
  }

  /** Find a single model's current metadata. */
  async getModel(modelId: string): Promise<LocalModel | undefined> {
    const models = await this.listModels();
    return models.find((m) => m.id === modelId);
  }

  /**
   * Ensure `modelId` is loaded with at least `minContext` tokens of context.
   * Uses LM Studio's native REST API (`/api/v1/models/load|unload`); falls back
   * to the `lms` CLI only if REST is unavailable. A no-op on servers that do not
   * expose a load lifecycle. Never throws.
   */
  async ensureContext(
    modelId: string,
    minContext: number,
    gpu: string,
    onProgress?: (msg: string) => void,
  ): Promise<{ reloaded: boolean; context?: number; note?: string }> {
    if (!this.supportsLifecycle) {
      return { reloaded: false };
    }
    try {
      const model = await this.getModel(modelId);
      if (!model) {
        return { reloaded: false, note: 'model not found on the server' };
      }
      const cap = model.maxContextLength ?? minContext;
      const target = Math.min(minContext, cap);
      const ctx = model.loadedContextLength ?? 0;
      if (model.state === 'loaded' && ctx >= target) {
        return { reloaded: false, context: ctx };
      }
      onProgress?.(`Loading ${prettyName(modelId)} with ${target.toLocaleString()} context…`);
      // Prefer the native REST API (no external CLI dependency).
      try {
        const instances = await this.loadedInstanceIds(modelId);
        for (const id of instances) {
          await this.unloadInstance(id).catch(() => undefined);
        }
        const loaded = await this.loadModel(modelId, target);
        return { reloaded: true, context: loaded.contextLength ?? target };
      } catch (restErr) {
        logError('REST model load failed, trying lms CLI fallback', restErr);
      }
      const lms = await resolveLmsCli();
      if (!lms) {
        return {
          reloaded: false,
          context: ctx || undefined,
          note: 'REST load failed and lms CLI not found; relying on JIT loading',
        };
      }
      log(`ensureContext: lms load ${modelId} -c ${target} --gpu ${gpu} -y`);
      await runLms(lms, ['load', modelId, '-c', String(target), '--gpu', gpu, '-y']);
      return { reloaded: true, context: target };
    } catch (err) {
      logError('ensureContext failed', err);
      return { reloaded: false, note: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Load a model with a context window via REST. Returns the instance id. */
  async loadModel(
    modelId: string,
    contextLength: number,
  ): Promise<{ instanceId?: string; contextLength?: number }> {
    const res = await fetch(`${this.rest}/api/v1/models/load`, {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        model: modelId,
        context_length: contextLength,
        flash_attention: true,
        echo_load_config: true,
      }),
      signal: AbortSignal.timeout(600000),
    });
    if (!res.ok) {
      throw new Error(`models/load ${res.status}: ${await res.text().catch(() => '')}`);
    }
    const j = (await res.json()) as { instance_id?: string; load_config?: { context_length?: number } };
    return { instanceId: j.instance_id, contextLength: j.load_config?.context_length };
  }

  /** Unload a specific loaded instance via REST. */
  async unloadInstance(instanceId: string): Promise<void> {
    const res = await fetch(`${this.rest}/api/v1/models/unload`, {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ instance_id: instanceId }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) {
      throw new Error(`models/unload ${res.status}`);
    }
  }

  /** Unload every loaded instance of a model (by model key). */
  async unloadModel(modelId: string): Promise<void> {
    const ids = await this.loadedInstanceIds(modelId);
    for (const id of ids) {
      await this.unloadInstance(id).catch(() => undefined);
    }
  }

  /**
   * Return the loaded instance ids for a model (empty if none / unsupported).
   * `modelId` (from /api/v0/models) can be a bare id like "qwen3.6-27b-mlx"
   * while /api/v1/models keys the same model as "unsloth/qwen3.6-27b-mlx" and
   * exposes the bare id only on the loaded *instance*. So match on the model
   * `key`/`id` OR any loaded instance id — otherwise an eject silently no-ops.
   */
  async loadedInstanceIds(modelId: string): Promise<string[]> {
    if (!this.supportsLifecycle) {
      return [];
    }
    try {
      const res = await fetch(`${this.rest}/api/v1/models`, {
        signal: AbortSignal.timeout(8000),
        headers: this.headers(),
      });
      if (!res.ok) {
        return [];
      }
      const j = (await res.json()) as { models?: any[]; data?: any[] };
      const arr = j.models ?? j.data ?? [];
      const ids: string[] = [];
      for (const x of arr) {
        const instances = (x?.loaded_instances ?? []) as Array<{ id?: string }>;
        const keyMatches = x.key === modelId || x.id === modelId;
        for (const inst of instances) {
          if (!inst?.id) {
            continue;
          }
          // Take the instance if its model matches, or the instance id itself is
          // the one we were asked to unload (the bare-id case).
          if (keyMatches || inst.id === modelId) {
            ids.push(inst.id);
          }
        }
      }
      return ids;
    } catch {
      return [];
    }
  }
}

/**
 * Work out what a local endpoint is, by asking it. Each vendor answers a
 * distinctive endpoint: LM Studio serves `/lmstudio-greeting`, Ollama serves
 * `/api/tags`, vLLM serves `/version`. Anything else that answers `/v1/models`
 * is a generic OpenAI-compatible server, which is a perfectly good outcome —
 * the flavor only unlocks extras, it never gates basic use.
 *
 * Returns null when nothing answers at all, which the autodetect treats as
 * "no server here".
 */
export async function detectFlavor(baseUrl: string, timeoutMs = 1500): Promise<LocalFlavor | null> {
  const root = restRoot(baseUrl);
  const ping = async (url: string): Promise<boolean> => {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      return res.ok;
    } catch {
      return false;
    }
  };
  if (await ping(`${root}/lmstudio-greeting`)) {
    return 'lmstudio';
  }
  if (await ping(`${root}/api/tags`)) {
    return 'ollama';
  }
  if (await isOmlx(root, timeoutMs)) {
    return 'omlx';
  }
  if (await ping(`${root}/version`)) {
    return 'vllm';
  }
  if (await ping(`${baseUrl}/models`)) {
    return 'openai-compatible';
  }
  return null;
}

/**
 * oMLX fingerprint. Checked before vLLM because both default to port 8000 and
 * `/health` is a name they could plausibly share — a bare 200 there proves
 * nothing, so this reads the body for oMLX's `engine_pool` block (its loaded/
 * ceiling accounting, which no other runtime reports). `/health` is one of the
 * few oMLX routes that answers unauthenticated, so this works before a key is
 * entered and can't be defeated by the API key it enforces everywhere else.
 */
async function isOmlx(root: string, timeoutMs: number): Promise<boolean> {
  try {
    const res = await fetch(`${root}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) {
      return false;
    }
    const json = (await res.json()) as { engine_pool?: unknown };
    return !!json && typeof json === 'object' && json.engine_pool !== undefined;
  } catch {
    return false;
  }
}

function prettyName(id: string): string {
  if (!id) {
    return 'unknown';
  }
  const base = id.split('/').pop() ?? id;
  return base;
}

// LM Studio's `compatibility_type` (e.g. "mlx", "gguf") → a clean badge label.
// Unknown values are upper-cased as-is so new runtimes still surface something.
function prettyFormat(compatibilityType?: string): string | undefined {
  if (!compatibilityType) {
    return undefined;
  }
  const known: Record<string, string> = { mlx: 'MLX', gguf: 'GGUF' };
  return known[compatibilityType.toLowerCase()] ?? compatibilityType.toUpperCase();
}

/** Run `lms` with args, capturing output; rejects on non-zero exit. */
function runLms(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { env: { ...process.env, NO_COLOR: '1' } });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(out);
      } else {
        reject(new Error(`lms exited ${code}: ${err || out}`));
      }
    });
    // Safety timeout: 10 minutes for very large model loads.
    setTimeout(() => {
      child.kill();
      reject(new Error('lms load timed out'));
    }, 600000);
  });
}

let cachedLms: string | null | undefined;

/** Locate the LM Studio `lms` CLI across platforms. */
export async function resolveLmsCli(): Promise<string | null> {
  if (cachedLms !== undefined) {
    return cachedLms;
  }
  const home = os.homedir();
  const candidates =
    process.platform === 'win32'
      ? [path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'LM Studio', 'resources', 'bin', 'lms.exe')]
      : [
          path.join(home, '.lmstudio', 'bin', 'lms'),
          path.join(home, '.cache', 'lm-studio', 'bin', 'lms'),
          '/Applications/LM Studio.app/Contents/Resources/lms',
        ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) {
      cachedLms = c;
      return c;
    }
  }
  // Fall back to PATH.
  cachedLms = await new Promise<string | null>((resolve) => {
    const which = process.platform === 'win32' ? 'where' : 'which';
    const child = spawn(which, ['lms']);
    let out = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.on('error', () => resolve(null));
    child.on('close', (code) => resolve(code === 0 && out.trim() ? out.trim().split('\n')[0] : null));
  });
  return cachedLms;
}

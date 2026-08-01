/**
 * The provider domain model — pure, so it unit-tests without vscode and can be
 * shared with the webview.
 *
 * OpenCode Agent talks to models through one embedded OpenCode server, and every
 * model it can reach comes from a *provider* declared in that server's injected
 * config. There are three kinds:
 *
 *   builtin  "OpenCode Zen" — OpenCode's own hosted provider. Verified to
 *            complete prompts with no key and no account, so a fresh install is
 *            usable before the user configures anything. Cannot be removed,
 *            only hidden.
 *   catalog  A provider from the models.dev catalog (anthropic, openai, google,
 *            openrouter, groq, …) that the user activates by pasting an API
 *            key. Its model list, prices, limits and reasoning variants all
 *            come back from the OpenCode server once the key is configured, so
 *            there is no per-provider code here.
 *   local    An OpenAI-compatible server the user runs (LM Studio, Ollama,
 *            vLLM, or anything else that speaks /v1). We enumerate its models
 *            ourselves and declare them into the config, because a local server
 *            is not in any catalog.
 *
 * A key never appears in this module: connections only carry `hasApiKey`, and
 * the secret itself lives in VS Code SecretStorage (see providers/registry.ts).
 */

export type ConnectionKind = 'builtin' | 'catalog' | 'local';

/**
 * What a local endpoint turns out to be. Detected by probing, not asked for —
 * it only gates optional extras (LM Studio's load/eject + context enforcement),
 * so guessing 'openai-compatible' is always a safe outcome.
 */
export type LocalFlavor = 'lmstudio' | 'ollama' | 'vllm' | 'openai-compatible';

export interface ProviderConnection {
  /** Stable internal id. For local endpoints this is also the OpenCode provider id. */
  id: string;
  kind: ConnectionKind;
  /**
   * The provider id OpenCode knows this by — a models.dev id for catalog
   * providers ('anthropic'), our own slug for local ones ('lmstudio-local').
   * This is what travels on every prompt as `model.providerID`.
   */
  providerID: string;
  /** Display name shown in the picker. */
  name: string;
  /** Local endpoints only: normalized base URL ending in /vN. */
  baseUrl?: string;
  /** Local endpoints only: what the probe decided this server is. */
  flavor?: LocalFlavor;
  /** Whether a key is stored for this connection. The key itself is never here. */
  hasApiKey?: boolean;
  /** Kept but not configured — the user parked it without losing the settings. */
  disabled?: boolean;
}

/**
 * OpenCode's own hosted provider. Always present in `GET /config/providers`
 * (with `options.apiKey: "public"`), so we never declare it in the config — we
 * only carry this record so it can be listed, labelled and hidden like any
 * other connection.
 */
export const BUILTIN_ZEN: ProviderConnection = {
  id: 'opencode-zen',
  kind: 'builtin',
  providerID: 'opencode',
  name: 'OpenCode Zen',
};

/** Well-known local inference endpoints, probed by the first-run autodetect. */
export const LOCAL_PROBE_TARGETS: Array<{ name: string; url: string; flavor: LocalFlavor }> = [
  { name: 'LM Studio', url: 'http://127.0.0.1:1234/v1', flavor: 'lmstudio' },
  { name: 'Ollama', url: 'http://127.0.0.1:11434/v1', flavor: 'ollama' },
  { name: 'vLLM', url: 'http://127.0.0.1:8000/v1', flavor: 'vllm' },
];

/**
 * Whether a connection can serve models right now. Catalog providers need a
 * key; local ones need only to be enabled (reachability is a separate, polled
 * concern — an unreachable endpoint is still configured); the builtin needs
 * nothing.
 */
export function isUsable(conn: ProviderConnection): boolean {
  if (conn.disabled) {
    return false;
  }
  return conn.kind === 'catalog' ? !!conn.hasApiKey : true;
}

/** Human-readable reason a connection is not usable, or null when it is. */
export function unusableReason(conn: ProviderConnection): string | null {
  if (conn.disabled) {
    return 'Disabled';
  }
  if (conn.kind === 'catalog' && !conn.hasApiKey) {
    return 'No API key';
  }
  return null;
}

/**
 * Mint an OpenCode provider id for a local endpoint from its display name.
 *
 * Two hard requirements, both load-bearing:
 *   - it is used as a JSON object key under `provider.<id>` in the injected
 *     config, so it must be a plain slug; and
 *   - it must never collide with a catalog id, or the local endpoint would
 *     silently overwrite that provider's real configuration (a local server
 *     named "OpenAI" must not become `provider.openai`).
 * Collisions with either catalog ids or ids already in use get a `-local`
 * suffix, then a numeric one.
 */
export function slugifyProviderId(name: string, taken: Iterable<string> = []): string {
  const used = new Set(taken);
  const base =
    (name || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'local';
  if (!used.has(base)) {
    return base;
  }
  const suffixed = `${base}-local`;
  if (!used.has(suffixed)) {
    return suffixed;
  }
  for (let i = 2; ; i++) {
    const candidate = `${base}-local-${i}`;
    if (!used.has(candidate)) {
      return candidate;
    }
  }
}

// ---- The models.dev catalog ------------------------------------------------
// Shape of https://models.dev/api.json, which the OpenCode server also caches
// to $XDG_CACHE_HOME/opencode/models.json. We only read the provider-level
// fields: once a key is configured the *models* come back from the server
// itself, richer and guaranteed to match what it will accept.

export interface CatalogProviderRaw {
  id?: string;
  name?: string;
  env?: string[];
  npm?: string;
  doc?: string;
  api?: string;
  models?: Record<string, unknown>;
}

export interface CatalogProvider {
  id: string;
  name: string;
  /** Env var names this provider reads, e.g. ["ANTHROPIC_API_KEY"]. */
  env: string[];
  /** Docs URL — the picker links it as "where do I get a key?". */
  doc?: string;
  /** The provider's base URL, when the catalog publishes one. */
  api?: string;
  modelCount: number;
}

/**
 * Whether a catalog entry is really a *local server* rather than a keyed cloud
 * provider — it advertises a loopback base URL (LMStudio ships as
 * `http://127.0.0.1:1234/v1`).
 *
 * These entries are the reason "LM Studio" turns up under "Add API key" asking
 * for a key that does not exist. They belong in the local-server flow, where
 * the address is editable: the catalog's loopback default is only right when
 * the server runs on this machine, and LM Studio or Ollama just as often lives
 * on another box on the LAN.
 *
 * Note "Ollama Cloud" (`https://ollama.com/v1`) is correctly *not* local — it
 * is a genuine hosted API that does need a key.
 */
export function isLocalCatalogEntry(entry: { api?: string } | undefined): boolean {
  const api = entry?.api?.trim();
  if (!api) {
    return false;
  }
  let host: string;
  try {
    host = new URL(api).hostname.toLowerCase();
  } catch {
    return false;
  }
  // Strip the brackets IPv6 literals carry in a URL ("[::1]").
  host = host.replace(/^\[|\]$/g, '');
  return (
    host === 'localhost' ||
    host === '::1' ||
    host === '0.0.0.0' ||
    host.endsWith('.localhost') ||
    /^127\./.test(host)
  );
}

/** Normalize a raw catalog blob into sorted, displayable provider entries. */
export function catalogEntries(raw: Record<string, CatalogProviderRaw> | null | undefined): CatalogProvider[] {
  if (!raw || typeof raw !== 'object') {
    return [];
  }
  const out: CatalogProvider[] = [];
  for (const [key, value] of Object.entries(raw)) {
    if (!value || typeof value !== 'object') {
      continue;
    }
    const id = (value.id ?? key).trim();
    if (!id) {
      continue;
    }
    out.push({
      id,
      name: (value.name ?? id).trim() || id,
      env: Array.isArray(value.env) ? value.env.filter((e) => typeof e === 'string') : [],
      doc: typeof value.doc === 'string' ? value.doc : undefined,
      api: typeof value.api === 'string' ? value.api : undefined,
      modelCount: value.models && typeof value.models === 'object' ? Object.keys(value.models).length : 0,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** A runtime offered as a one-click prefill in the "Add local server" tab. */
export interface LocalServerOption {
  name: string;
  /** The address to start from — a default to type over, not a constraint. */
  url: string;
}

/** "LM Studio" and "LMStudio" are the same product; compare them as one. */
const localKey = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * The local runtimes to offer as prefills, from two sources that each miss
 * something the other has:
 *
 *   - LOCAL_PROBE_TARGETS knows LM Studio, Ollama and vLLM with their real
 *     default ports. Ollama appears *only* here — the catalog's sole Ollama
 *     entry is "Ollama Cloud", a hosted API.
 *   - The catalog contributes anything else shipping a loopback URL (Atomic
 *     Chat, Lynkr, Privatemode AI, and LMStudio under its own spelling), so
 *     the list grows on its own as models.dev adds runtimes.
 *
 * An empty query returns just the probe targets, the same curated-head idea as
 * FEATURED_PROVIDER_IDS: nobody opens this panel looking for Lynkr, and a
 * seven-row default would push the keyed providers off the bottom of the list.
 * A query searches the merged set, so the long tail stays one search away.
 *
 * Probe targets win a name collision — same product, better label, and a port
 * we maintain.
 */
export function knownLocalServers(entries: CatalogProvider[], query = ''): LocalServerOption[] {
  const out: LocalServerOption[] = LOCAL_PROBE_TARGETS.map((t) => ({ name: t.name, url: t.url }));
  const q = localKey(query);
  if (!q) {
    return out;
  }
  const seen = new Set(out.map((o) => localKey(o.name)));
  for (const e of entries) {
    const key = localKey(e.name);
    if (!isLocalCatalogEntry(e) || !e.api || seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push({ name: e.name, url: e.api });
  }
  return out.filter((o) => localKey(o.name).includes(q));
}

/**
 * The providers to offer first in an empty search box. The catalog has 176
 * entries and no popularity signal, so this is a curated head — everything else
 * is one search away.
 */
export const FEATURED_PROVIDER_IDS = [
  'anthropic',
  'openai',
  'google',
  'openrouter',
  'xai',
  'groq',
  'deepseek',
  'mistral',
];

/**
 * Rank catalog providers for the add-provider picker. An empty query returns
 * the featured head; otherwise it is a prefix-beats-substring match on id and
 * name, so typing "ant" surfaces Anthropic above "Cerebras (instant)".
 */
export function searchCatalog(entries: CatalogProvider[], query: string, limit = 40): CatalogProvider[] {
  const q = (query || '').trim().toLowerCase();
  if (!q) {
    const featured = FEATURED_PROVIDER_IDS.map((id) => entries.find((e) => e.id === id)).filter(
      (e): e is CatalogProvider => !!e,
    );
    const rest = entries.filter((e) => !FEATURED_PROVIDER_IDS.includes(e.id));
    return [...featured, ...rest].slice(0, limit);
  }
  const scored: Array<{ entry: CatalogProvider; score: number }> = [];
  for (const entry of entries) {
    const id = entry.id.toLowerCase();
    const name = entry.name.toLowerCase();
    let score = -1;
    if (id === q || name === q) {
      score = 0;
    } else if (id.startsWith(q) || name.startsWith(q)) {
      score = 1;
    } else if (id.includes(q) || name.includes(q)) {
      score = 2;
    }
    if (score >= 0) {
      scored.push({ entry, score });
    }
  }
  return scored
    .sort((a, b) => a.score - b.score || a.entry.name.localeCompare(b.entry.name))
    .slice(0, limit)
    .map((s) => s.entry);
}

// ---- Model references ------------------------------------------------------
// With one provider, a model was identified by its bare id. With many, the same
// model id can exist under several providers (openrouter and anthropic both
// serve "claude-sonnet-4-6"), so a reference is "<providerID>/<modelID>".
// Model ids themselves contain slashes ("qwen/qwen3-coder-30b"), so the split
// is on the FIRST slash only.

export interface ModelRef {
  providerID: string;
  modelID: string;
}

export function formatModelRef(providerID: string, modelID: string): string {
  return `${providerID}/${modelID}`;
}

/**
 * Parse a "provider/model" reference. A bare string with no slash is treated as
 * a model id with an unknown provider, so a hand-written `defaultModel` setting
 * of just "claude-sonnet-4-6" still matches under whichever provider has it.
 */
export function parseModelRef(ref: string | null | undefined): { providerID?: string; modelID: string } | null {
  const value = (ref ?? '').trim();
  if (!value) {
    return null;
  }
  const slash = value.indexOf('/');
  if (slash <= 0 || slash === value.length - 1) {
    return { modelID: value };
  }
  return { providerID: value.slice(0, slash), modelID: value.slice(slash + 1) };
}

// ---- Assembling the model list --------------------------------------------

/**
 * The subset of `GET /config/providers` this module reads. Declared
 * structurally rather than imported so this stays free of the protocol module
 * (and of anything with a node dependency), keeping it unit-testable.
 */
export interface ProviderModelShape {
  name?: string;
  capabilities?: { reasoning?: boolean; toolcall?: boolean; attachment?: boolean; input?: { image?: boolean } };
  cost?: { input?: number; output?: number };
  limit?: { context?: number };
  variants?: Record<string, unknown>;
}

export interface ProviderShape {
  id: string;
  name: string;
  models: Record<string, ProviderModelShape>;
}

/** The extra metadata only a local endpoint can report about its own models. */
export interface LocalModelShape {
  id: string;
  displayName: string;
  state?: string;
  maxContextLength?: number;
  loadedContextLength?: number;
  toolUse?: boolean;
  vision?: boolean;
  publisher?: string;
  quantization?: string;
  format?: string;
  reasoning?: { allowedOptions: string[]; default?: string; declared?: boolean } | null;
}

/** One row of the model picker. Mirrors UiModel in src/shared.ts. */
export interface AssembledModel {
  id: string;
  providerID: string;
  providerName: string;
  providerKind: ConnectionKind;
  modelID: string;
  name: string;
  loaded?: boolean;
  lifecycle?: boolean;
  contextLength?: number;
  maxContextLength?: number;
  toolUse?: boolean;
  vision?: boolean;
  publisher?: string;
  quantization?: string;
  format?: string;
  cost?: { input?: number; output?: number };
  reasoning?: { allowedOptions: string[]; default?: string; declared?: boolean } | null;
}

/**
 * Build the model list from the server's provider response, enriched with what
 * the local endpoints know about their own models.
 *
 * The server response is the authority on *which* models exist and what the
 * server will accept — for catalog providers it also carries names, limits,
 * capabilities, prices and each model's own reasoning variants. Local models
 * get a second pass from their client, which knows the things no catalog can:
 * whether a model is in memory right now, the window it was loaded with, its
 * quantization and runtime format.
 *
 * Providers the server knows but the registry does not are dropped: those are
 * either just-removed connections or ones OpenCode picked up from ambient
 * environment variables, and neither is something the user configured here —
 * every row in the picker should map to a row in the Providers panel.
 *
 * Ordering is by the registry, then model name, so the picker is stable across
 * refreshes rather than following server order.
 */
export function assembleModels(
  providers: ProviderShape[],
  connections: ProviderConnection[],
  localByRef: Map<string, LocalModelShape> = new Map(),
): AssembledModel[] {
  const known = new Map(connections.map((c) => [c.providerID, c]));
  const out: AssembledModel[] = [];
  for (const provider of providers) {
    const conn = known.get(provider.id);
    if (!conn || conn.disabled) {
      continue;
    }
    for (const [modelID, info] of Object.entries(provider.models ?? {})) {
      const ref = formatModelRef(provider.id, modelID);
      const local = localByRef.get(ref);
      const caps = info.capabilities;
      const variants = Object.keys(info.variants ?? {});
      out.push({
        id: ref,
        providerID: provider.id,
        providerName: conn.name || provider.name,
        providerKind: conn.kind,
        modelID,
        name: local?.displayName ?? info.name ?? modelID,
        loaded: local ? local.state === 'loaded' : undefined,
        lifecycle: conn.kind === 'local' && conn.flavor === 'lmstudio',
        contextLength: local?.loadedContextLength,
        maxContextLength: local?.maxContextLength ?? info.limit?.context,
        toolUse: local?.toolUse ?? caps?.toolcall,
        vision: local?.vision ?? caps?.input?.image ?? caps?.attachment,
        publisher: local?.publisher,
        quantization: local?.quantization,
        format: local?.format,
        // Price is a property of buying tokens, so local endpoints never carry
        // one — the server reports 0/0 for the models we declare, and rendering
        // that as "free" would be noise on a model running on your own GPU.
        // A *cloud* provider priced at zero (a free tier) keeps its label.
        cost:
          conn.kind !== 'local' &&
          (info.cost?.input !== undefined || info.cost?.output !== undefined)
            ? { input: info.cost?.input, output: info.cost?.output }
            : undefined,
        // Local models use the variant table WE declared, so their granularity
        // comes from the endpoint's own capability report. Catalog models
        // publish their own variants, which are the exact names they accept.
        reasoning: local
          ? local.reasoning
          : caps?.reasoning
            ? { allowedOptions: variants, declared: true }
            : null,
      });
    }
  }
  const order = new Map([...known.keys()].map((id, i) => [id, i]));
  return out.sort(
    (a, b) =>
      (order.get(a.providerID) ?? 99) - (order.get(b.providerID) ?? 99) ||
      a.name.localeCompare(b.name),
  );
}

export interface SelectableRef {
  providerID: string;
  modelID: string;
  /** Local endpoints only: whether the model is currently loaded in memory. */
  loaded?: boolean;
}

/**
 * Pick the model to use from a preference list, generalizing the single-server
 * `pickModel` to provider-qualified references.
 *
 * A preference matches provider+model when it carries a provider, or any
 * provider's copy of that model id when it does not. Falls back to a loaded
 * local model (starting one that is already in memory beats cold-loading
 * another), then to the first model available. Undefined only when there are no
 * models at all.
 */
export function pickModelRef(
  preferences: Array<string | null | undefined>,
  models: SelectableRef[],
): ModelRef | undefined {
  for (const pref of preferences) {
    const parsed = parseModelRef(pref);
    if (!parsed) {
      continue;
    }
    const hit = models.find(
      (m) =>
        m.modelID === parsed.modelID &&
        (parsed.providerID === undefined || m.providerID === parsed.providerID),
    );
    if (hit) {
      return { providerID: hit.providerID, modelID: hit.modelID };
    }
  }
  const loaded = models.find((m) => m.loaded);
  const fallback = loaded ?? models[0];
  return fallback ? { providerID: fallback.providerID, modelID: fallback.modelID } : undefined;
}

import * as fs from 'node:fs';
import * as path from 'node:path';
import { catalogEntries, type CatalogProvider, type CatalogProviderRaw } from '../core/providers';
import { log, logError } from '../logger';

/**
 * The models.dev provider catalog — the list the "add a provider" picker is
 * built from.
 *
 * `GET /config/providers` on the OpenCode server only returns providers that
 * are already credentialed (verified against 1.18.4: a bare config returns just
 * the builtin), so it cannot answer "what could I add?". The catalog can.
 *
 * Three sources, in order, so the picker works offline and on first run:
 *
 *   1. The OpenCode server's own cache at <dataDir>/cache/opencode/models.json.
 *      It writes this on first start and it is byte-compatible with
 *      models.dev/api.json. Best source by definition — it is exactly the
 *      catalog the server will act on, and it costs no network.
 *   2. A direct fetch of https://models.dev/api.json, for the window before the
 *      server has ever run.
 *   3. A tiny built-in seed, so the picker is never empty — enough to add the
 *      major providers with no network at all.
 *
 * Results are memoized in-process with a TTL; the catalog changes on the order
 * of days, and every panel shares one loader.
 */

const CATALOG_URL = 'https://models.dev/api.json';
const TTL_MS = 6 * 60 * 60 * 1000; // 6h
const FETCH_TIMEOUT_MS = 10000;

/**
 * Minimal offline seed. Deliberately provider-level only (no model lists): the
 * models arrive from the OpenCode server once a key is stored, so all the
 * picker needs to get someone started is an id, a name and where to get a key.
 */
const SEED: Record<string, CatalogProviderRaw> = {
  anthropic: {
    id: 'anthropic',
    name: 'Anthropic',
    env: ['ANTHROPIC_API_KEY'],
    doc: 'https://console.anthropic.com/settings/keys',
  },
  openai: {
    id: 'openai',
    name: 'OpenAI',
    env: ['OPENAI_API_KEY'],
    doc: 'https://platform.openai.com/api-keys',
  },
  google: {
    id: 'google',
    name: 'Google',
    env: ['GOOGLE_GENERATIVE_AI_API_KEY', 'GEMINI_API_KEY'],
    doc: 'https://aistudio.google.com/apikey',
  },
  openrouter: {
    id: 'openrouter',
    name: 'OpenRouter',
    env: ['OPENROUTER_API_KEY'],
    doc: 'https://openrouter.ai/keys',
  },
  xai: { id: 'xai', name: 'xAI', env: ['XAI_API_KEY'], doc: 'https://console.x.ai' },
  groq: { id: 'groq', name: 'Groq', env: ['GROQ_API_KEY'], doc: 'https://console.groq.com/keys' },
  deepseek: {
    id: 'deepseek',
    name: 'DeepSeek',
    env: ['DEEPSEEK_API_KEY'],
    doc: 'https://platform.deepseek.com/api_keys',
  },
  mistral: {
    id: 'mistral',
    name: 'Mistral',
    env: ['MISTRAL_API_KEY'],
    doc: 'https://console.mistral.ai/api-keys',
  },
};

export class ProviderCatalog {
  private cached: CatalogProvider[] | undefined;
  private cachedAt = 0;
  private loading: Promise<CatalogProvider[]> | undefined;

  /** @param dataDir the managed OpenCode data dir (holds cache/opencode/models.json). */
  constructor(private readonly dataDir: string) {}

  /** The catalog, from cache when fresh. Never throws — falls back to the seed. */
  async load(): Promise<CatalogProvider[]> {
    if (this.cached && Date.now() - this.cachedAt < TTL_MS) {
      return this.cached;
    }
    if (this.loading) {
      return this.loading;
    }
    this.loading = this.doLoad().finally(() => {
      this.loading = undefined;
    });
    return this.loading;
  }

  /** Force the next load() to re-read; used by the picker's explicit refresh. */
  invalidate(): void {
    this.cached = undefined;
    this.cachedAt = 0;
  }

  private async doLoad(): Promise<CatalogProvider[]> {
    const fromDisk = this.readServerCache();
    if (fromDisk.length) {
      this.cached = fromDisk;
      this.cachedAt = Date.now();
      log(`provider catalog: ${fromDisk.length} providers from the OpenCode cache`);
      return fromDisk;
    }
    const fetched = await this.fetchCatalog();
    if (fetched.length) {
      this.cached = fetched;
      this.cachedAt = Date.now();
      log(`provider catalog: ${fetched.length} providers from ${CATALOG_URL}`);
      return fetched;
    }
    // Keep a stale-but-real catalog over the seed if we ever had one.
    const fallback = this.cached?.length ? this.cached : catalogEntries(SEED);
    log(`provider catalog: falling back to ${fallback.length} built-in entries`);
    return fallback;
  }

  /** The catalog the OpenCode server itself cached, if it has run at least once. */
  private readServerCache(): CatalogProvider[] {
    const file = path.join(this.dataDir, 'cache', 'opencode', 'models.json');
    try {
      if (!fs.existsSync(file)) {
        return [];
      }
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, CatalogProviderRaw>;
      return catalogEntries(raw);
    } catch (err) {
      logError('could not read the OpenCode model catalog cache', err);
      return [];
    }
  }

  private async fetchCatalog(): Promise<CatalogProvider[]> {
    try {
      const res = await fetch(CATALOG_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) {
        return [];
      }
      const raw = (await res.json()) as Record<string, CatalogProviderRaw>;
      return catalogEntries(raw);
    } catch (err) {
      logError('could not fetch the models.dev catalog', err);
      return [];
    }
  }
}

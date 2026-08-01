/**
 * URL helpers for local, OpenAI-compatible endpoints. Pure so they can be
 * shared (config, provider registry, local client) and unit-tested without
 * vscode.
 */

/**
 * Normalize a user-entered server URL to the OpenAI-compatible base that ends
 * in /vN (defaulting to /v1). Adds a scheme if missing and strips trailing
 * slashes. Empty input falls back to the local default.
 */
export function normalizeServerUrl(raw: string, fallback = 'http://127.0.0.1:1234/v1'): string {
  let u = (raw || '').trim().replace(/\/+$/, '');
  if (!u) {
    return fallback;
  }
  if (!/^https?:\/\//i.test(u)) {
    u = 'http://' + u;
  }
  if (!/\/v\d+$/.test(u)) {
    u = u + '/v1';
  }
  return u;
}

/**
 * The server root without the trailing /vN — where the vendor-native APIs live
 * alongside the OpenAI-compatible surface (LM Studio's /api/v1 and
 * /lmstudio-greeting, Ollama's /api/tags).
 */
export function restRoot(baseUrl: string): string {
  return (baseUrl || '').replace(/\/v\d+$/, '');
}

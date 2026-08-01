/**
 * Pure helpers for server API-key edits.
 *
 * A server's API key lives in VS Code SecretStorage (never in globalState,
 * never sent to the webview). The webview expresses an edit as:
 *   - undefined  → keep whatever key is stored (field left untouched)
 *   - null       → remove the stored key ("Remove key" checked)
 *   - string     → replace the stored key (whitespace-only counts as keep,
 *                  so an accidental space can't wipe a key)
 * This module normalizes that tri-state into an explicit action so the
 * vscode-bound registry stays a thin shell around it.
 */

export type ApiKeyEdit = string | null | undefined;

export type ApiKeyAction = { kind: 'keep' } | { kind: 'remove' } | { kind: 'set'; value: string };

export function resolveApiKeyEdit(edit: ApiKeyEdit): ApiKeyAction {
  if (edit === null) {
    return { kind: 'remove' };
  }
  const value = (edit ?? '').trim();
  if (!value) {
    return { kind: 'keep' };
  }
  return { kind: 'set', value };
}

/** Normalize the add-form value: a blank/whitespace key means "no key". */
export function normalizeNewApiKey(apiKey: string | undefined): string | undefined {
  const value = (apiKey ?? '').trim();
  return value || undefined;
}

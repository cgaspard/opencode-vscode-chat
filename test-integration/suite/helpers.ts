// Friendly wrappers around the extension's test commands, for driving and
// inspecting the live webview from inside the extension host.
import * as vscode from 'vscode';
import type { HostToWebview, UiModel, UiProvider } from '../../src/shared';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Open the chat panel and wait for the webview to boot + register itself.
 *
 * By default this first disables every provider. Suites that inject their own
 * models and assert on them need the host to have nothing to serve: the builtin
 * provider needs only a network connection, so a live host would post real
 * model lists over the fixtures mid-assertion. Pass `{ quiesce: false }` when
 * the suite deliberately drives a real connection (the polling e2e).
 */
export async function openPanel(opts: { quiesce?: boolean } = {}): Promise<void> {
  if (opts.quiesce !== false) {
    await vscode.commands.executeCommand('opencodeChat._test.quiesceProviders');
  }
  await vscode.commands.executeCommand('opencodeChat._test.openPanel');
  await sleep(800); // let the webview script load and install its test hook
}

/** Inject a host->webview message (drives the fake event stream). */
export async function post(msg: HostToWebview | Record<string, unknown>): Promise<void> {
  await vscode.commands.executeCommand('opencodeChat._test.post', msg);
}

async function exec(op: Record<string, unknown>): Promise<any> {
  return vscode.commands.executeCommand('opencodeChat._test.exec', op);
}

/** Number of elements matching a selector. */
export async function count(selector: string): Promise<number> {
  return (await exec({ __test__: 'query', selector, prop: 'text' })).count;
}

/** Trimmed textContent of the first match (null if none). */
export async function text(selector: string): Promise<string | null> {
  return (await exec({ __test__: 'query', selector, prop: 'text' })).value;
}

/** An attribute (or 'class') of the first match. */
export async function attr(selector: string, prop: string): Promise<string | null> {
  return (await exec({ __test__: 'query', selector, prop })).value;
}

/** className list of every match. */
export async function classes(selector: string): Promise<string[]> {
  return (await exec({ __test__: 'query', selector, prop: 'class' })).values;
}

/** Trimmed textContent of every match. */
export async function allText(selector: string): Promise<string[]> {
  return (await exec({ __test__: 'query', selector, prop: 'text' })).values;
}

/** Dispatch a real click on the first match. Returns false if nothing matched. */
export async function click(selector: string): Promise<boolean> {
  return (await exec({ __test__: 'click', selector })).ok;
}

/** Set the composer input value and fire its input event (drives autocomplete). */
export async function setInput(value: string): Promise<void> {
  await exec({ __test__: 'setInput', value });
}

/** Set a <select>'s value and fire change (drives picker controls). */
export async function setSelect(selector: string, value: string): Promise<boolean> {
  return (await exec({ __test__: 'setSelect', selector, value })).ok;
}

/** Poll until the predicate over a selector's count holds (or time out). */
export async function waitFor(
  selector: string,
  pred: (n: number) => boolean,
  timeoutMs = 4000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred(await count(selector))) {
      return;
    }
    await sleep(100);
  }
  throw new Error(`waitFor(${selector}) timed out`);
}

/**
 * Build a UiModel fixture the way a local LM Studio endpoint produces one.
 *
 * Models are provider-qualified now: `id` is "<providerID>/<modelID>", which is
 * what selection stores and what the picker groups on. Fixtures pass the bare
 * model id and this fills in the provider half, so a test says what it means
 * ("qwen/qwen3-27b") without repeating the provider everywhere.
 */
export function localModel(
  m: Partial<UiModel> & { id: string; name: string },
): UiModel {
  const providerID = m.providerID ?? 'lm-studio';
  const modelID = m.modelID ?? m.id;
  return {
    providerKind: 'local',
    providerName: 'LM Studio',
    lifecycle: true,
    loaded: false,
    ...m,
    providerID,
    modelID,
    id: `${providerID}/${modelID}`,
  };
}

/** The provider-qualified ref a `localModel` fixture ends up with. */
export function localRef(modelID: string, providerID = 'lm-studio'): string {
  return `${providerID}/${modelID}`;
}

/** A ready local provider, as the host would report it. */
export function localProvider(over: Partial<UiProvider> = {}): UiProvider {
  return {
    id: 'p-local',
    kind: 'local',
    providerID: 'lm-studio',
    name: 'LM Studio',
    url: 'http://127.0.0.1:1234/v1',
    flavor: 'lmstudio',
    hasApiKey: false,
    enabled: true,
    status: 'ready',
    modelCount: 0,
    ...over,
  };
}

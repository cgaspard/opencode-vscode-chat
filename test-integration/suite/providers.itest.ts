// Integration tests for the Providers panel: the configured-provider list and
// its badges, the add-provider catalog search + key prompt, the edit overlay's
// keep/replace/remove affordances, and the connection banner's three states.
// Driven against the live webview via the test hook; the provider list is
// injected, so no real registry state, network or local server is needed.
import * as assert from 'node:assert';
import * as helpers from './helpers';

const { openPanel, post, count, click, attr, waitFor, localProvider } = helpers;

const PROVIDERS = [
  // The builtin: usable with no key, and not removable.
  {
    id: 'opencode-zen',
    kind: 'builtin' as const,
    providerID: 'opencode',
    name: 'OpenCode Zen',
    hasApiKey: false,
    enabled: true,
    status: 'ready' as const,
    modelCount: 7,
  },
  // A cloud provider with a stored key.
  {
    id: 'prv_a',
    kind: 'catalog' as const,
    providerID: 'anthropic',
    name: 'Anthropic',
    hasApiKey: true,
    enabled: true,
    status: 'ready' as const,
    modelCount: 17,
  },
  // A local endpoint that isn't answering.
  localProvider({ id: 'prv_b', name: 'Workstation', url: 'https://lm.example.com/v1', status: 'offline' }),
];

const CATALOG = [
  { id: 'openai', name: 'OpenAI', doc: 'https://platform.openai.com/api-keys', modelCount: 48, configured: false },
  { id: 'anthropic', name: 'Anthropic', doc: 'https://console.anthropic.com', modelCount: 17, configured: true },
];

const online = (over: Record<string, unknown> = {}) =>
  post({
    type: 'init',
    models: [],
    currentModel: null,
    agent: 'build',
    cwd: '/tmp',
    serverReady: true,
    upstreamConnected: true,
    hasProviders: true,
    minContext: 32768,
    ...over,
  });

function postProviders() {
  return post({ type: 'providers', providers: PROVIDERS, connected: true });
}

describe('providers panel', function () {
  this.timeout(30000);

  before(async () => {
    await openPanel();
    await online();
    await postProviders();
    // Providers live in the combined model menu now; the list only renders
    // while the menu is open.
    assert.ok(await click('#model-btn'), 'model & providers button should be clickable');
    await waitFor('#model-menu:not(.hidden)', (n) => n === 1);
    await postProviders(); // re-render rows now that the menu is open
  });

  after(async () => {
    // The webview is shared across suites, and later ones assume the model menu
    // starts closed (their #model-btn click would otherwise toggle it shut).
    if ((await count('#model-menu:not(.hidden)')) === 1) {
      await click('#model-btn');
      await waitFor('#model-menu:not(.hidden)', (n) => n === 0);
    }
  });

  it('lists every configured provider', async () => {
    await waitFor('#server-menu-list .model-row', (n) => n === 3);
  });

  it('shows a key badge only on providers with a stored key', async () => {
    assert.strictEqual(await count('.server-key-badge'), 1, 'exactly one provider has a key');
  });

  it('the builtin cannot be edited or removed, but can be turned off', async () => {
    // Two of three rows are user-managed; all three can be enabled/disabled.
    assert.strictEqual(await count('#server-menu-list .server-edit'), 2);
    assert.strictEqual(await count('#server-menu-list .eject'), 2);
    assert.strictEqual(await count('#server-menu-list .provider-toggle'), 3);
  });

  it('"Add provider…" expands the catalog form inside the combined menu', async () => {
    assert.ok(await click('#provider-add-toggle'), 'the add-provider row should be clickable');
    await waitFor('#provider-add-form:not(.hidden)', (n) => n === 1);
    assert.strictEqual(await count('#catalog-search'), 1, 'the catalog search input should exist');
  });

  it('the catalog lists providers and marks the ones already added', async () => {
    await post({ type: 'catalog', query: '', providers: CATALOG, localServers: [], localMatches: [] });
    // Rows: the always-present "Custom server" local option + the two cloud
    // providers from the injected catalog page.
    await waitFor('#catalog-list .model-row', (n) => n === 3);
    assert.strictEqual(await count('#catalog-list .model-row.dimmed'), 1, 'the configured one is dimmed');
  });

  it('the local-server form offers a masked key field', async () => {
    // "Custom server" is always the local group's last (here: only) row; its
    // Set up button opens the local overlay with the optional auth-proxy key.
    assert.ok(await click('#catalog-list .model-row:nth-child(2) .model-action'), 'Set up should be clickable');
    await waitFor('#local-overlay:not(.hidden)', (n) => n === 1);
    assert.strictEqual(await count('#local-key'), 1, 'key input should exist');
    assert.strictEqual(await attr('#local-key', 'type'), 'password', 'key input must be masked');
    assert.ok(await click('#local-cancel'));
    await waitFor('#local-overlay:not(.hidden)', (n) => n === 0);
  });

  it('choosing a catalog provider opens a masked key prompt', async () => {
    // First cloud row (OpenAI) sits right after the cloud section head.
    assert.ok(await click('#catalog-list .model-row:nth-child(4) .model-action'));
    await waitFor('#key-overlay:not(.hidden)', (n) => n === 1);
    assert.strictEqual(await attr('#key-input', 'type'), 'password', 'the key must be masked');
    assert.strictEqual(await attr('#key-input', 'value'), '', 'the field starts empty');
    assert.ok(await click('#key-cancel'));
    await waitFor('#key-overlay:not(.hidden)', (n) => n === 0);
  });

  it('edit opens the overlay prefilled, with a keep-key placeholder for a keyed provider', async () => {
    // Row 2 is Anthropic, which has a key.
    assert.ok(await click('#server-menu-list .model-row:nth-child(2) .server-edit'), 'edit click should land');
    await waitFor('#server-edit-overlay:not(.hidden)', (n) => n === 1);
    assert.strictEqual(await attr('#server-edit-name', 'value'), 'Anthropic');
    assert.strictEqual(await attr('#server-edit-key', 'value'), '', 'key field must start empty — the key never reaches the webview');
    assert.match((await attr('#server-edit-key', 'placeholder'))!, /unchanged/i, 'placeholder explains an empty field keeps the key');
    assert.strictEqual(await count('#server-edit-remove-row:not(.hidden)'), 1, 'remove-key option visible for keyed provider');
    // A cloud provider has no URL to edit. (A reflected boolean attribute
    // reads back as the empty string, not "true".)
    assert.notStrictEqual(await attr('#server-edit-url', 'disabled'), null);
  });

  it('cancel closes the overlay', async () => {
    assert.ok(await click('#server-edit-cancel'));
    await waitFor('#server-edit-overlay:not(.hidden)', (n) => n === 0);
  });

  it('editing a keyless local endpoint hides the remove-key option and allows a URL', async () => {
    assert.ok(await click('#server-menu-list .model-row:nth-child(3) .server-edit'));
    await waitFor('#server-edit-overlay:not(.hidden)', (n) => n === 1);
    assert.strictEqual(await count('#server-edit-remove-row:not(.hidden)'), 0, 'no remove option without a stored key');
    assert.doesNotMatch((await attr('#server-edit-key', 'placeholder'))!, /unchanged/i);
    assert.strictEqual(await attr('#server-edit-url', 'value'), 'https://lm.example.com/v1');
    assert.strictEqual(await attr('#server-edit-url', 'disabled'), null, 'a local endpoint’s URL is editable');
    assert.ok(await click('#server-edit-close'));
    await waitFor('#server-edit-overlay:not(.hidden)', (n) => n === 0);
  });

  it('detected local servers are offered as one-click adds', async () => {
    await post({
      type: 'detectedLocal',
      servers: [{ name: 'LM Studio', url: 'http://127.0.0.1:1234/v1', flavor: 'lmstudio' }],
    });
    await waitFor('#detected-list .model-row', (n) => n === 1);
  });

  it('the banner tells the three failures apart', async () => {
    // 1. A rejected key is a fixable mistake, not an unreachable server.
    await online({ serverReady: false, upstreamConnected: false, upstreamAuthRequired: true });
    await waitFor('.conn-title', (n) => n === 1);
    assert.match((await helpers.text('.conn-title'))!, /rejected/i);
    assert.match((await helpers.text('.conn-sub'))!, /401/, 'sub line should name the rejection');

    // 2. Configured but nothing answering reads as unreachable.
    await online({ serverReady: false, upstreamConnected: false });
    await waitFor('.conn-title', (n) => n === 1);
    assert.match((await helpers.text('.conn-title'))!, /can't reach/i);

    // 3. Nothing configured at all is a different problem with a different fix.
    await online({ serverReady: false, upstreamConnected: false, hasProviders: false });
    await waitFor('.conn-title', (n) => n === 1);
    assert.match((await helpers.text('.conn-title'))!, /no provider configured/i);

    // restore the connected state for any suite that runs after this one
    await online();
  });
});

import * as vscode from 'vscode';
import { getConfig } from './config';
import { LocalEndpoints, syncEndpointsFromRegistry } from './local/endpoints';
import { initLogger, log, showLogs } from './logger';
import { OpencodeServerManager } from './opencode/serverManager';
import { BridgeDeps } from './panel/bridge';
import { ProviderCatalog } from './providers/catalog';
import { ProviderRegistry } from './providers/registry';
import { attachTestWebview, registerTestCommands } from './test-integration/testHook';
import { ChatViewProvider, openChatPanel } from './panel/chatViewProvider';

// Injected by esbuild `define`: true in test builds, false (dead-code-stripped)
// in production.
declare const __TEST__: boolean;

let server: OpencodeServerManager | undefined;

export function activate(context: vscode.ExtensionContext): void {
  initLogger(context);
  log('activating OpenCode Agent');

  const cfg = getConfig();
  const registry = new ProviderRegistry(context);
  const endpoints = new LocalEndpoints();
  // Hydrate the local endpoints' clients early (SecretStorage is async, activate
  // is not). Consumers that spawn OpenCode re-sync themselves; this only narrows
  // the window where a client is keyless.
  void syncEndpointsFromRegistry(registry, endpoints);
  // Bundled binary lives under the extension dir; the managed server's on-disk
  // state is sandboxed under globalStorage so it never collides with a user's
  // own OpenCode install.
  const dataDir = vscode.Uri.joinPath(context.globalStorageUri, 'opencode').fsPath;
  const catalog = new ProviderCatalog(dataDir);
  server = new OpencodeServerManager(cfg, registry, endpoints, context.extensionPath, dataDir);

  const deps: BridgeDeps = { context, server, registry, endpoints, catalog };

  // The `secondarySidebar` viewsContainers slot needs VS Code >= 1.106. On
  // older builds, flip this context key so the activitybar fallback shows
  // instead (same approach the Claude Code / Codex extensions use).
  const [major, minor] = vscode.version.split('.').map((n) => Number(n));
  const supportsSecondarySidebar = major > 1 || (major === 1 && minor >= 106);
  if (!supportsSecondarySidebar) {
    void vscode.commands.executeCommand(
      'setContext',
      'opencodeChat:doesNotSupportSecondarySidebar',
      true,
    );
  }

  // Register a provider for both the activitybar fallback view and the
  // secondary-sidebar view; only one is active at a time via `when` clauses.
  const providerPrimary = new ChatViewProvider(context.extensionUri, deps);
  const providerSecondary = new ChatViewProvider(context.extensionUri, deps);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('opencodeChat.chat', providerPrimary, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerWebviewViewProvider('opencodeChat.chatSecondary', providerSecondary, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );
  const provider = { newChat: () => { providerPrimary.newChat(); providerSecondary.newChat(); }, showHistory: () => { providerPrimary.showHistory(); providerSecondary.showHistory(); } };

  context.subscriptions.push(
    vscode.commands.registerCommand('opencodeChat.newChat', () => provider.newChat()),
    vscode.commands.registerCommand('opencodeChat.history', () => provider.showHistory()),
    vscode.commands.registerCommand('opencodeChat.focus', () =>
      vscode.commands.executeCommand('opencodeChat.chat.focus'),
    ),
    vscode.commands.registerCommand('opencodeChat.openInTab', () =>
      openChatPanel(context.extensionUri, deps),
    ),
    vscode.commands.registerCommand('opencodeChat.showLogs', () => showLogs()),
    vscode.commands.registerCommand('opencodeChat.restartServer', async () => {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Restarting OpenCode server…' },
        async () => {
          try {
            // Mirror doInit: the provider config is baked at spawn and
            // enumerates local models through the endpoint pool, which may not
            // have been hydrated yet if no panel has connected — reconcile it
            // against the registry first.
            await syncEndpointsFromRegistry(registry, endpoints);
            await server!.restart();
            vscode.window.showInformationMessage('OpenCode Agent: OpenCode server restarted.');
          } catch (err) {
            vscode.window.showErrorMessage(
              `OpenCode Agent: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        },
      );
    }),
  );

  // Restart the server if relevant settings change.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration('opencodeChat.opencodePath') ||
        e.affectsConfiguration('opencodeChat.serverPort') ||
        // MCP servers are baked into the injected config at spawn time, so a
        // change to ours — or VS Code's shared `mcp` setting — needs a respawn
        // to take effect. (On-disk .mcp.json / .vscode/mcp.json edits are picked
        // up by the "Restart OpenCode Server" command.)
        e.affectsConfiguration('opencodeChat.mcpServers') ||
        e.affectsConfiguration('mcp')
      ) {
        log('relevant configuration changed; restarting server on next use');
        server?.dispose();
      }
    }),
  );

  // Integration-test seam (stripped from production builds via __TEST__).
  // Opens a chat panel on demand and exposes it to the test commands so the
  // suite can drive + inspect the live webview.
  if (__TEST__) {
    registerTestCommands(context);
    context.subscriptions.push(
      vscode.commands.registerCommand('opencodeChat._test.openPanel', () => {
        const panel = openChatPanel(context.extensionUri, deps);
        attachTestWebview(panel.webview);
      }),
      // Disable every provider so the host cannot reach a model. The webview
      // suites inject their own state and assert on it; a live provider (the
      // builtin needs only a network) would post real model lists over those
      // fixtures mid-assertion.
      vscode.commands.registerCommand('opencodeChat._test.quiesceProviders', async () => {
        for (const conn of deps.registry.list()) {
          await deps.registry.setDisabled(conn.id, true);
        }
        await syncEndpointsFromRegistry(deps.registry, deps.endpoints);
      }),
      // Point the extension at a test-controlled endpoint (the e2e polling
      // suite runs a fake LM Studio in-process) as its ONLY provider, so the
      // upstream verdict depends solely on that server. Returns what
      // restoreServer needs to undo the mutation so state never leaks.
      vscode.commands.registerCommand('opencodeChat._test.useServer', async (url: string) => {
        for (const conn of deps.registry.list()) {
          await deps.registry.setDisabled(conn.id, true);
        }
        const added = await deps.registry.addLocal('E2E Fake', url, { flavor: 'lmstudio' });
        await syncEndpointsFromRegistry(deps.registry, deps.endpoints);
        return { id: added.id };
      }),
      vscode.commands.registerCommand(
        'opencodeChat._test.restoreServer',
        async (state: { id: string }) => {
          await deps.registry.remove(state.id);
          await syncEndpointsFromRegistry(deps.registry, deps.endpoints);
        },
      ),
    );
  }
}

export function deactivate(): void {
  server?.dispose();
}

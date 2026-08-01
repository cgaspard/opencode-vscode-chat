import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { getConfig } from '../config';
import { commandTakesArgs } from '../core/commands';
import { type AgentInfo, delegatableAgents, pickableAgents, resolveAgent } from '../core/agents';
import { clampContext } from '../core/context';
import {
  type EffortLevel,
  type ReasoningCapability,
  fallbackPromptText,
  resolveLevel,
  variantForLevel,
} from '../core/effort';
import {
  Goal,
  buildContinuePrompt,
  buildJudgePrompt,
  buildRevisionPrompt,
  decideNext,
  newGoal,
  parseJudgeVerdict,
  parseRevisionVerdict,
} from '../core/goal';
import { humanizeError, isConnectionError } from '../core/errors';
import { aggregateUpstream, type ProbeStatus } from '../core/health';
import {
  LOCAL_PROBE_TARGETS,
  formatModelRef,
  isUsable,
  parseModelRef,
  pickModelRef,
  searchCatalog,
  unusableReason,
  type ProviderConnection,
} from '../core/providers';
import { ConnectResult, SelfHealer } from '../core/reconnect';
import { selectionLabel } from '../core/selection';
import { emptySessionCandidates } from '../core/sessions';
import { classifySkills } from '../core/skills';
import { deriveTitle } from '../core/title';
import { detectFlavor, type LocalModel } from '../local/client';
import { syncEndpointsFromRegistry, type LocalEndpoints } from '../local/endpoints';
import { log, logError } from '../logger';
import { discoverMcpServers } from '../mcp/discovery';
import { OpencodeClient } from '../opencode/client';
import { OpencodeAgent, OpencodeEvent, PromptBody } from '../opencode/protocol';
import { Disposable, OpencodeServerManager } from '../opencode/serverManager';
import type { ProviderCatalog } from '../providers/catalog';
import type { ProviderRegistry } from '../providers/registry';
import {
  HostToWebview,
  UiAgent,
  UiCommand,
  UiGoal,
  UiImage,
  UiMcpServer,
  UiModel,
  UiProvider,
  UiSession,
  UiSkill,
  WebviewToHost,
} from '../shared';

/**
 * Health poll cadence while disconnected (ms). Kept fast so a restarted
 * local server is picked up promptly; the *connected* cadence is the configurable
 * `opencodeChat.healthCheckSeconds` (default 30s) — issue #7: a healthy idle
 * panel shouldn't flood a local server's developer log with model queries.
 */
const OFFLINE_HEALTH_INTERVAL_MS = 5000;
/** Refresh the model list every N health ticks while connected. */
const REFRESH_EVERY_TICKS = 3;
/** Fast model-list refresh cadence while the model picker is open (ms). */
const PICKER_REFRESH_MS = 4000;
/**
 * Consecutive probe timeouts before we believe an endpoint is gone. A single
 * slow probe (server saturated mid-generation) must not pop the offline
 * banner; a refused connection still flips immediately.
 */
const OFFLINE_AFTER_TIMEOUTS = 3;
/** globalState flag: the one-time empty-session migration has already run. */
const PRUNED_EMPTIES_KEY = 'opencodeChat.prunedEmptySessions';
/** workspaceState key: the last active session, restored on the next launch. */
const LAST_SESSION_KEY = 'opencodeChat.lastSessionID';
/**
 * Window-scoped claim so only the FIRST bridge to initialize (in practice the
 * sidebar view on launch) restores the persisted session — every panel shares
 * the one workspaceState slot, and siblings must not all open the same
 * conversation.
 */
let sessionRestoreClaimed = false;

export interface BridgeDeps {
  context: vscode.ExtensionContext;
  server: OpencodeServerManager;
  /** The user's configured providers (cloud keys + local endpoints). */
  registry: ProviderRegistry;
  /** Live clients for the local endpoints among them. */
  endpoints: LocalEndpoints;
  /** The models.dev provider list, for the add-provider picker. */
  catalog: ProviderCatalog;
}

/**
 * Connects one webview (sidebar view or editor tab) to the OpenCode server.
 * Owns the conversation state for that webview and relays the SSE event stream.
 */
export class ChatBridge {
  private client: OpencodeClient | undefined;
  private currentSessionID: string | null = null;
  private currentModel: string | null = null;
  private agent: string;
  /** Last agent roster from GET /agent, for the picker and overhead math. */
  private lastAgents: OpencodeAgent[] = [];
  private eventAbort: AbortController | undefined;
  private disposed = false;
  private connected = false;
  private connecting = false;
  private currentTitle = '';
  private agentsWarned = false;
  /** In-flight createSession promise, so concurrent first-sends share one. */
  private ensuringSession: Promise<void> | undefined;
  /** Whether this bridge already ran its one launch-time session restore. */
  private restoreAttempted = false;
  /**
   * The active goal loop, or null. `paused` keeps the goal pinned without
   * auto-continuing (user pressed Stop / pause, or a safety cap tripped).
   * Session-scoped: cleared on new chat / session switch.
   */
  private activeGoal: (Goal & { startedAt: number; paused: boolean }) | null = null;
  /** True while a judge check is in flight (prevents concurrent checks). */
  private goalChecking = false;
  /** True while a goal-revision check is in flight (prevents concurrent checks). */
  private revisionChecking = false;
  /** Last time the loop advanced — drives the health-tick watchdog. */
  private lastGoalActivity = 0;
  private activeFile: { abs: string; rel: string; chars: number } | null = null;
  /**
   * The current editor selection, tracked live like the active file. `text` is
   * the exact selected text (from getText, so multi-byte safe); start/end are
   * character offsets (from offsetAt) into the document; lines are 1-based for
   * display. Null whenever there's no non-empty file selection — which also
   * covers Markdown-preview panes (they aren't text editors, so no selection).
   */
  private activeSelection:
    | { abs: string; rel: string; text: string; start: number; end: number; startLine: number; endLine: number }
    | null = null;
  private editorSub: vscode.Disposable | undefined;
  private selectionSub: vscode.Disposable | undefined;
  private messageSub: vscode.Disposable | undefined;
  private healthTimer: ReturnType<typeof setInterval> | undefined;
  /** Next wall-clock time (ms) the upstream probe is due; 0 = due now. */
  private nextProbeDueAt = 0;
  /** Fast refresh loop while the webview's model picker is open. */
  private pickerTimer: ReturnType<typeof setInterval> | undefined;
  /** Whether this webview is currently visible (hidden panels stay alive). */
  private visible = true;
  /** JSON of the last 'models' payload posted — suppresses no-op refreshes. */
  private lastPostedModelsJson = '';
  /** Last probe result per local connection id, for the provider list's badges. */
  private lastProbes = new Map<string, ProbeStatus>();
  private titleSink: ((t: string) => void) | undefined;
  private lastModels: UiModel[] = [];
  private serverExitSub: Disposable | undefined;
  /** Pure self-heal policy (reconnect timing, backoff, reload-after-reconnect). */
  private readonly healer: SelfHealer = new SelfHealer(
    {
      // Share one probe across all panels' ticks (they use the same clients):
      // a result younger than ~80% of the cadence IN EFFECT is fresh enough to
      // reuse — while disconnected that cadence is the fast 5s one, so a
      // restarted local server really is noticed within ~5s. While disconnected
      // the probe is also auth-aware (LM Studio's greeting answers 200 even to
      // a rejected key, which would otherwise spin doInit in a reconnect loop).
      probeUpstream: () => this.probeUpstream(),
      serverHealthy: () => this.deps.server.isRunning && !!this.client,
      isConnected: () => this.connected,
      goOffline: () => this.markOffline(),
      connect: () => this.init(),
      reloadModels: () => this.refreshModelsToWebview('periodic'),
    },
    {
      refreshEvery: REFRESH_EVERY_TICKS,
      offlineAfterTimeouts: OFFLINE_AFTER_TIMEOUTS,
      backoff: { base: 2000, max: 30000 },
    },
  );

  constructor(
    private readonly webview: vscode.Webview,
    private readonly deps: BridgeDeps,
  ) {
    this.agent = getConfig().agent;
    // Keep the subscription so dispose() can detach it — a re-resolved view
    // would otherwise leave a second handler alive, fanning one send out to
    // multiple prompt requests (duplicate replies).
    this.messageSub = webview.onDidReceiveMessage((m: WebviewToHost) => this.onMessage(m));
    this.editorSub = vscode.window.onDidChangeActiveTextEditor((e) => {
      this.updateActiveFile(e);
      this.updateSelection(e);
    });
    this.selectionSub = vscode.window.onDidChangeTextEditorSelection((e) =>
      this.updateSelection(e.textEditor),
    );
    // Self-heal when the shared OpenCode server dies unexpectedly.
    this.serverExitSub = this.deps.server.addExitListener(() => this.onServerExit());
  }

  dispose(): void {
    this.disposed = true;
    this.messageSub?.dispose();
    this.eventAbort?.abort();
    this.editorSub?.dispose();
    this.selectionSub?.dispose();
    this.serverExitSub?.dispose();
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = undefined;
    }
    if (this.pickerTimer) {
      clearInterval(this.pickerTimer);
      this.pickerTimer = undefined;
    }
  }

  /** The connected-state poll cadence (ms), from user settings. */
  private healthIntervalMs(): number {
    return getConfig().healthCheckSeconds * 1000;
  }

  /**
   * One upstream verdict for the whole provider set: probe the local endpoints
   * (cheaply, sharing results across panels) and let `aggregateUpstream` fold
   * in the cloud providers, which are available whenever a key is stored and
   * are never probed — a liveness check against a metered API would bill the
   * user to learn something the next real request tells us for free.
   */
  private async probeUpstream(): Promise<ProbeStatus> {
    const cadence = this.connected ? this.healthIntervalMs() : OFFLINE_HEALTH_INTERVAL_MS;
    const connections = this.deps.registry.enabled();
    const probes = await this.deps.endpoints.probeAll(
      Math.floor(cadence * 0.8),
      !this.connected,
    );
    this.lastProbes = probes;
    return aggregateUpstream({
      probes: [...probes.values()],
      keyedProviders: connections.filter((c) => c.kind === 'catalog' && c.hasApiKey).length,
      builtinEnabled: connections.some((c) => c.kind === 'builtin'),
    });
  }

  /**
   * Poll so the panel self-heals. The policy (when to reconnect, how to back
   * off, when to reload models) lives in the pure, unit-tested `SelfHealer`.
   *
   * The timer is a fixed 5s metronome that only PROBES when due: every tick
   * while disconnected, every healthCheckSeconds while connected. A fixed
   * interval (rather than a rescheduled timeout) survives a tick that throws,
   * and reacts within 5s when some out-of-tick path flips us offline —
   * postServers(false) resets the due time. Config changes take effect on the
   * next due probe.
   */
  private startHealthPoll(): void {
    if (this.healthTimer || this.disposed) {
      return;
    }
    this.healthTimer = setInterval(() => void this.runHealthTick(), OFFLINE_HEALTH_INTERVAL_MS);
  }

  /**
   * Visibility changed (sidebar collapsed, tab moved to background). Hidden
   * panels keep their slow self-heal poll but skip model refreshes; on
   * becoming visible again, catch up immediately.
   */
  setVisible(visible: boolean): void {
    if (visible === this.visible) {
      return;
    }
    this.visible = visible;
    if (visible && this.connected) {
      void this.refreshModelsToWebview('periodic');
    }
  }

  private async runHealthTick(): Promise<void> {
    if (this.disposed || this.connecting) {
      return;
    }
    if (Date.now() >= this.nextProbeDueAt) {
      const started = Date.now();
      const before = this.probeFingerprint();
      try {
        await this.healer.tick();
        // A per-endpoint status change that does NOT move the aggregate still
        // matters: with a cloud provider (or the builtin) configured, a local
        // server dying leaves us "connected" — but the user's selected model
        // just became unusable, and their picker badge is now wrong. The healer
        // takes no action in that case, so publish the change ourselves.
        if (this.connected && this.probeFingerprint() !== before) {
          await this.postProviders(this.connected);
        }
      } finally {
        // While disconnected the next metronome tick (5s) probes again; while
        // connected wait out the configured cadence. Anchor to the tick START
        // (minus slack for timer drift) — anchoring to completion would push
        // the due time past the next tick whenever the cadence equals the
        // metronome period, silently halving the probe rate.
        this.nextProbeDueAt = this.connected ? started + this.healthIntervalMs() - 500 : 0;
      }
    }
    // Goal watchdog ("wake up on occasion"): if the loop lost its idle signal
    // (e.g. an error swallowed the event) re-check once things are quiet.
    if (
      this.activeGoal &&
      !this.activeGoal.paused &&
      !this.goalChecking &&
      Date.now() - this.lastGoalActivity > 120_000
    ) {
      this.lastGoalActivity = Date.now(); // back off between watchdog retries
      if (!(await this.isSessionBusy())) {
        void this.runGoalCheck();
      }
    }
  }

  /** Nothing upstream can serve — keep the live OpenCode server, just show the banner. */
  private markOffline(): void {
    this.connected = false;
    void this.postProviders(false);
    this.post({
      type: 'status',
      text: 'Lost connection to every provider — reconnecting…',
      kind: 'warn',
    });
  }

  /**
   * What to tell the user when nothing can serve a model. The distinction that
   * matters is whether they have configured anything at all — "add a provider"
   * and "your provider is down" are different problems with different fixes.
   */
  private offlineReason(upstream: ProbeStatus, usable: ProviderConnection[]): string {
    if (!usable.length) {
      return this.deps.registry.list().length > 1
        ? 'No usable provider — add an API key or enable one under Providers'
        : 'Add a provider to get started';
    }
    if (upstream === 'auth-required') {
      return 'A provider rejected the stored API key — update it under Providers';
    }
    const offline = usable
      .filter((c) => c.kind === 'local' && this.lastProbes.get(c.id) !== 'ok')
      .map((c) => c.name);
    return offline.length
      ? `Can't reach ${offline.join(', ')}`
      : 'No provider is responding — retrying…';
  }

  /** The shared OpenCode server crashed: drop our stale client + stream, reconnect. */
  private onServerExit(): void {
    if (this.disposed) {
      return;
    }
    log('opencode server exited unexpectedly — reconnecting');
    this.teardownConnection(false); // server is already gone
    this.healer.allowImmediate(); // permit an immediate reconnect
    this.post({ type: 'status', text: 'Reconnecting…', kind: 'warn' });
    void this.healer.reconnect(); // reconnects + reloads models on success
  }

  /**
   * Abort the event stream and drop the client so a fresh connect re-subscribes
   * cleanly. Only dispose the *shared* server when asked (and when it is ours to
   * dispose) — other panels may still be using it.
   */
  private teardownConnection(disposeServer: boolean): void {
    this.eventAbort?.abort();
    this.eventAbort = undefined;
    this.client = undefined;
    if (disposeServer) {
      this.deps.server.dispose();
    }
  }

  /** True when a provider is available and we have a live OpenCode client. */
  private isLive(): boolean {
    return this.connected && !!this.client && this.deps.server.isRunning;
  }

  /**
   * Re-establish the connection after a transient failure. If the OpenCode
   * process is gone we fully re-init (which respawns it); otherwise we just
   * re-verify the providers and reuse the running server. The healer reloads models
   * on success. Returns whether we are live afterwards.
   */
  private async reconnect(): Promise<boolean> {
    if (!this.deps.server.isRunning) {
      this.teardownConnection(false);
    }
    return this.healer.reconnect();
  }

  private updateActiveFile(editor: vscode.TextEditor | undefined): void {
    // Keep the last real file when focus moves to the webview/panel.
    if (!editor || editor.document.uri.scheme !== 'file') {
      return;
    }
    const abs = editor.document.uri.fsPath;
    this.activeFile = {
      abs,
      rel: vscode.workspace.asRelativePath(abs),
      chars: editor.document.getText().length,
    };
    this.post({ type: 'activeFile', path: this.activeFile.rel, chars: this.activeFile.chars });
  }

  /**
   * Track the current editor selection so it can be auto-attached as context,
   * the way Claude Code shares the highlighted code. Cleared (and the pill
   * removed) whenever the selection is empty or the editor isn't a real file —
   * which is also why a Markdown *preview* never produces a selection (it's not
   * a TextEditor). Uses getText() for the exact text (multi-byte safe) and
   * offsetAt() for character offsets, so the range we hand OpenCode lines up
   * with the text even with emoji/accented characters in the document.
   */
  private updateSelection(editor: vscode.TextEditor | undefined): void {
    // Keep the last real selection when focus moves to the webview/panel (the
    // editor goes undefined) — same as updateActiveFile. Otherwise the user's
    // highlighted code would vanish the instant they click into the composer to
    // type, which is the primary "highlight → ask about it" flow.
    if (!editor || editor.document.uri.scheme !== 'file') {
      return;
    }
    const sel = editor.selection;
    if (!sel || sel.isEmpty) {
      // A real file editor with no (longer a) selection — the user deselected.
      if (this.activeSelection) {
        this.activeSelection = null;
        this.post({ type: 'activeSelection', selection: null });
      }
      return;
    }
    const doc = editor.document;
    const abs = doc.uri.fsPath;
    const text = doc.getText(sel);
    this.activeSelection = {
      abs,
      rel: vscode.workspace.asRelativePath(abs),
      text,
      start: doc.offsetAt(sel.start),
      end: doc.offsetAt(sel.end),
      startLine: sel.start.line + 1, // 1-based for display (App.tsx#14-19)
      endLine: sel.end.line + 1,
    };
    this.post({
      type: 'activeSelection',
      selection: {
        path: this.activeSelection.rel,
        startLine: this.activeSelection.startLine,
        endLine: this.activeSelection.endLine,
        chars: text.length,
      },
    });
  }

  /** Start a fresh conversation (invoked by the New Chat command). */
  async requestNewChat(): Promise<void> {
    await this.newSession();
  }

  /** Ask the webview to run a UI command (e.g. open history overlay). */
  sendCommand(command: 'history' | 'newChat' | 'focusInput'): void {
    this.post({ type: 'command', command });
  }

  /** Provide a callback that sets the host view/tab title (the session name). */
  setTitleSink(fn: (t: string) => void): void {
    this.titleSink = fn;
  }

  private updateTitle(title: string): void {
    this.currentTitle = title || 'New chat';
    this.titleSink?.(this.currentTitle);
  }

  private post(msg: HostToWebview): void {
    if (!this.disposed) {
      void this.webview.postMessage(msg);
    }
  }

  private async onMessage(msg: WebviewToHost): Promise<void> {
    if (this.disposed) {
      return; // a superseded bridge must not handle messages
    }
    try {
      switch (msg.type) {
        case 'ready':
          // A fresh webview always starts with the picker closed — stop any
          // fast-poll loop a previous webview incarnation left running (iframe
          // reloads never send modelMenu open:false).
          this.setModelMenuOpen(false);
          await this.init();
          break;
        case 'send':
          // While a goal is set, quietly check (in the background — the send
          // must not wait on the local model) whether this message changes the
          // goal; if so the user gets a confirm card before it actually does.
          this.maybeOfferGoalRevision(msg.text);
          await this.handleSend(
            msg.text,
            msg.effort,
            msg.images ?? [],
            msg.includeActiveFile ?? false,
            msg.includeSelection ?? false,
          );
          break;
        case 'selectModel':
          // msg.modelID is a provider-qualified ref ("anthropic/claude-sonnet-4-6"),
          // which is what makes the same model id under two providers distinct.
          this.currentModel = msg.modelID;
          await this.deps.context.workspaceState.update('opencodeChat.model', msg.modelID);
          break;
        case 'loadModel':
          await this.handleLoadModel(msg.modelID);
          break;
        case 'unloadModel':
          await this.handleUnloadModel(msg.modelID);
          break;
        case 'setContextSize':
          await this.setContextSize(msg.tokens);
          break;
        case 'refreshModels':
          await this.refreshModelsToWebview();
          break;
        case 'modelMenu':
          this.setModelMenuOpen(msg.open);
          break;
        case 'listProviders':
          await this.postProviders(this.connected);
          break;
        case 'searchCatalog':
          await this.sendCatalog(msg.query ?? '');
          break;
        case 'addProvider':
          await this.deps.registry.addCatalog(msg.providerID, msg.name, msg.apiKey);
          await this.applyProviderChange();
          break;
        case 'addLocalProvider':
          await this.deps.registry.addLocal(msg.name, msg.url, {
            apiKey: msg.apiKey,
            flavor: msg.flavor,
          });
          await this.applyProviderChange();
          break;
        case 'updateProvider':
          await this.deps.registry.update(msg.id, {
            name: msg.name,
            url: msg.url,
            apiKey: msg.apiKey,
          });
          await this.applyProviderChange();
          break;
        case 'removeProvider':
          await this.deps.registry.remove(msg.id);
          await this.applyProviderChange();
          break;
        case 'setProviderEnabled':
          await this.deps.registry.setDisabled(msg.id, !msg.enabled);
          await this.applyProviderChange();
          break;
        case 'detectLocalProviders':
          await this.detectLocalProviders();
          break;
        case 'selectAgent':
          this.agent = msg.agent;
          break;
        case 'newChat':
          await this.newSession();
          break;
        case 'loadSessions':
          await this.sendSessions();
          break;
        case 'loadSession':
          await this.loadSession(msg.sessionID);
          break;
        case 'deleteSession': {
          const wasCurrent = msg.sessionID === this.currentSessionID;
          await this.client?.deleteSession(msg.sessionID);
          if (wasCurrent) {
            this.currentSessionID = null;
            await this.newSession(false);
          }
          await this.sendSessions();
          break;
        }
        case 'clearAllSessions':
          await this.clearAllSessions();
          break;
        case 'compact':
          await this.compactSession();
          break;
        case 'abort':
          // Stop means stop: pause the goal loop BEFORE aborting, so the abort's
          // session.idle event can't race in and immediately re-continue the
          // turn the user just killed (resume from the goal bar).
          if (this.activeGoal && !this.activeGoal.paused) {
            this.activeGoal.paused = true;
            this.postGoal();
            this.post({ type: 'status', text: 'Goal paused — resume from the goal bar.', kind: 'warn' });
          }
          if (this.currentSessionID) {
            await this.client?.abort(this.currentSessionID);
          }
          break;
        case 'permission':
          await this.client?.respondPermission(msg.sessionID, msg.permissionID, msg.response);
          break;
        case 'questionReply':
          await this.client?.replyQuestion(msg.requestID, msg.answers);
          break;
        case 'questionReject':
          await this.client?.rejectQuestion(msg.requestID);
          break;
        case 'openFile':
          await this.openFile(msg.path);
          break;
        case 'openInTab':
          await vscode.commands.executeCommand('opencodeChat.openInTab');
          break;
        case 'requestMcpStatus':
          await this.sendMcpStatus();
          break;
        case 'requestSkills':
          await this.sendSkills();
          break;
        case 'requestAgents':
          await this.sendAgents();
          break;
        case 'createAgent':
          await this.createAgent(msg.name);
          break;
        case 'runCommand':
          await this.handleRunCommand(msg.command, msg.arguments);
          break;
        case 'setGoal':
          await this.setGoal(msg.objective);
          break;
        case 'updateGoal': {
          // A confirmed revision: swap the objective in place. The revised goal
          // gets a fresh iteration budget, and old stall reasons no longer
          // apply; elapsed time and paused state carry over.
          const g = this.activeGoal;
          const obj = msg.objective.trim();
          if (g && obj) {
            g.objective = obj;
            g.iteration = 0;
            g.recentReasons = [];
            this.lastGoalActivity = Date.now();
            this.postGoal();
            this.post({ type: 'goalEvent', kind: 'updated', reason: obj });
          }
          break;
        }
        case 'pauseGoal':
          if (this.activeGoal) {
            this.activeGoal.paused = true;
            this.postGoal();
          }
          break;
        case 'resumeGoal':
          await this.resumeGoal();
          break;
        case 'clearGoal':
          this.activeGoal = null;
          this.postGoal();
          break;
        case 'retryConnect':
          await this.init();
          break;
      }
    } catch (err) {
      logError(`handling ${msg.type}`, err);
      this.post({ type: 'error', message: humanizeError(err, { subject: this.currentProviderName() }) });
      this.post({ type: 'busy', busy: false });
    }
  }

  private async init(): Promise<ConnectResult> {
    this.startHealthPoll();
    if (this.connecting) {
      return this.isLive() ? 'connected' : 'upstream-down';
    }
    this.connecting = true;
    try {
      return await this.doInit();
    } finally {
      this.connecting = false;
    }
  }

  private async doInit(): Promise<ConnectResult> {
    const cfg = getConfig();
    // Reconcile the local clients with the registry BEFORE anything reads them:
    // the server config enumerates local models through this pool, and a stale
    // client would bake the wrong URL or a superseded key into the spawn.
    await syncEndpointsFromRegistry(this.deps.registry, this.deps.endpoints);
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    const usable = this.deps.registry.enabled().filter(isUsable);

    this.post({ type: 'status', text: 'Connecting…' });
    const upstream = await this.probeUpstream();
    this.connected = upstream === 'ok';
    await this.postProviders(this.connected);

    // Nothing can serve a model: show the connection screen and wait for a
    // provider to be added, fixed or come back. The healer applies no backoff
    // for this — the poll recovers the moment something answers.
    if (!this.connected) {
      // 'timeout' lands here too: for a user-facing connect attempt a server
      // that won't answer is indistinguishable from one that's gone.
      const authRequired = upstream === 'auth-required';
      // The webview now shows models: [] — resync the periodic diff-guard so
      // the next healthy refresh always posts (a stale healthy snapshot here
      // would suppress it and freeze the picker on "No models found").
      this.lastPostedModelsJson = '';
      this.post({
        type: 'init',
        models: [],
        currentModel: null,
        agent: this.agent,
        cwd,
        serverReady: false,
        upstreamConnected: false,
        upstreamAuthRequired: authRequired,
        hasProviders: usable.length > 0,
        minContext: cfg.minContextLength,
        defaultEffort: cfg.defaultThinkingEffort,
        agents: [],
      });
      this.post({ type: 'status', text: this.offlineReason(upstream, usable), kind: 'warn' });
      log(`doInit: upstream ${upstream} across ${usable.length} usable provider(s)`);
      return 'upstream-down';
    }

    this.post({ type: 'status', text: 'Starting OpenCode server…' });
    let started;
    try {
      started = await this.deps.server.start();
    } catch (err) {
      // Upstream is fine but OpenCode failed to come up — report 'failed' so the
      // healer backs off instead of respawning a broken server every tick.
      logError('opencode server failed to start', err);
      this.post({ type: 'error', message: humanizeError(err, { subject: 'OpenCode' }) });
      this.lastPostedModelsJson = ''; // webview shows models: [] — resync diff-guard
      this.post({
        type: 'init',
        models: [],
        currentModel: null,
        agent: this.agent,
        cwd,
        serverReady: false,
        upstreamConnected: true,
        hasProviders: usable.length > 0,
        minContext: cfg.minContextLength,
        defaultEffort: cfg.defaultThinkingEffort,
        agents: [],
      });
      return 'failed';
    }
    this.client = started.client;

    const models = await this.loadModels();
    const stored = this.deps.context.workspaceState.get<string>('opencodeChat.model');
    // The live in-session selection wins over configuration: a self-heal
    // reconnect mid-conversation must never silently switch the user's model
    // back to defaultModel. defaultModel only decides on a fresh panel.
    const picked = pickModelRef(
      [this.currentModel ?? '', cfg.defaultModel, stored ?? ''],
      models.map((m) => ({ providerID: m.providerID, modelID: m.modelID, loaded: m.loaded })),
    );
    this.currentModel = picked ? formatModelRef(picked.providerID, picked.modelID) : null;

    this.startEventStream();

    // Agents come from the server (built-ins + anything the user defined on
    // disk). A stored selection that no longer exists falls back to build, so a
    // renamed or deleted agent can't leave the composer pointing at nothing.
    const agents = await this.loadAgents();
    this.agent = resolveAgent(this.agent, this.lastAgents as AgentInfo[]);

    this.lastPostedModelsJson = JSON.stringify({ models, currentModel: this.currentModel });
    this.post({
      type: 'init',
      models,
      currentModel: this.currentModel,
      agent: this.agent,
      cwd,
      serverReady: true,
      upstreamConnected: true,
      hasProviders: usable.length > 0,
      minContext: cfg.minContextLength,
      defaultEffort: cfg.defaultThinkingEffort,
      agents,
    });

    await this.sendSessions();
    // Restore the last active conversation — idea contributed by
    // @AlessandroPerazzetta (PR #8), reworked to run only on a bridge's FIRST
    // init: doInit also runs on every self-heal reconnect, where re-posting
    // sessionLoaded would wipe and re-render a live transcript.
    await this.maybeRestoreLastSession();
    // No eager session: a fresh chat stays null until the first message creates
    // it lazily (handleSend), so an empty "New chat" never shows in history.
    if (!this.currentSessionID) {
      this.updateTitle('New chat');
      this.post({ type: 'cleared' });
    }
    // One-time migration: clean up empty sessions created before sessions went
    // lazy. Gated behind a PERSISTED flag (not a per-instance one) so it runs
    // once per install — every panel re-resolve / editor tab spins up a new
    // ChatBridge, and re-running this destructive scan each time is both wasteful
    // and widens the race window against sibling bridges' in-flight sessions.
    if (!this.deps.context.globalState.get(PRUNED_EMPTIES_KEY)) {
      void this.deps.context.globalState.update(PRUNED_EMPTIES_KEY, true);
      void this.pruneEmptySessions();
    }
    // Populate the slash menu with the server's commands + skills.
    void this.sendCommands();
    this.updateActiveFile(vscode.window.activeTextEditor);
    this.updateSelection(vscode.window.activeTextEditor);
    this.warnIfAgentsLarge();
    // Clean connect — clear any reconnect backoff held by the healer.
    this.healer.noteConnected();
    this.post({ type: 'status', text: '' });
    return 'connected';
  }

  /** Warn once if AGENTS.md/CLAUDE.md (auto-loaded by OpenCode) is large. */
  private warnIfAgentsLarge(): void {
    if (this.agentsWarned) {
      return;
    }
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {
      return;
    }
    let bytes = 0;
    const found: string[] = [];
    for (const name of ['AGENTS.md', 'CLAUDE.md']) {
      try {
        const st = fs.statSync(path.join(root, name));
        if (st.isFile()) {
          bytes += st.size;
          found.push(name);
        }
      } catch {
        // not present
      }
    }
    if (!found.length) {
      return;
    }
    const estTokens = Math.round(bytes / 4);
    const win = getConfig().minContextLength;
    if (estTokens >= win * 0.4) {
      this.agentsWarned = true;
      const pct = Math.round((estTokens / win) * 100);
      const over = estTokens >= win;
      vscode.window.showWarningMessage(
        `OpenCode Chat: ${found.join(' + ')} is ~${Math.round(estTokens / 1000)}k tokens (~${pct}% of your ${Math.round(win / 1000)}k context)${over ? ' — larger than the context window' : ''}. It's auto-included on every request and may crowd out the conversation. Consider trimming it or raising opencodeChat.minContextLength.`,
      );
    }
  }

  /**
   * Gather MCP server status for the `/mcp` panel: the live connection state
   * from the server (GET /mcp) cross-referenced with the discovered config so
   * each row also shows its transport + command/url — even a failed or disabled
   * server the live map might report tersely. Posts an `mcpStatus` message;
   * `servers: []` means none are configured.
   */
  private async sendMcpStatus(): Promise<void> {
    // Configured servers (for transport + detail), keyed by name.
    let configured: ReturnType<typeof discoverMcpServers>['map'] = {};
    try {
      configured = discoverMcpServers().map;
    } catch (err) {
      logError('mcp discovery for /mcp panel', err);
    }

    // Live status from the running server, if reachable. Failure to fetch
    // (server down) just means we show the configured set without live state.
    let live: Record<string, { status?: string; error?: string }> = {};
    if (this.client) {
      try {
        live = (await this.client.listMcp()) as typeof live;
      } catch (err) {
        logError('GET /mcp failed', err);
      }
    }

    // Union the two key sets so a configured-but-not-yet-reported server still
    // shows, and a live server we somehow didn't configure isn't hidden.
    const names = new Set<string>([...Object.keys(configured), ...Object.keys(live)]);
    const servers: UiMcpServer[] = [...names].sort().map((name) => {
      const cfg = configured[name];
      const transport: 'local' | 'remote' | undefined = cfg
        ? cfg.type === 'remote'
          ? 'remote'
          : 'local'
        : undefined;
      let detail: string | undefined;
      if (cfg?.type === 'remote') {
        detail = cfg.url;
      } else if (cfg?.type === 'local') {
        detail = cfg.command.join(' ');
      }
      // A configured-but-disabled server may not appear in the live map; reflect
      // its config state so the panel still shows it as disabled.
      const status = live[name]?.status ?? (cfg?.enabled === false ? 'disabled' : 'pending');
      return { name, status, error: live[name]?.error, transport, detail };
    });

    this.post({ type: 'mcpStatus', servers });
  }

  /**
   * Gather the skills OpenCode discovered (GET /skill) for the `/skills` panel,
   * classifying each by where it came from so the user can confirm their
   * project/global/Claude-Code skills are being found. Posts a `skills`
   * message; `skills: []` means none were discovered.
   */
  private async sendSkills(): Promise<void> {
    let skills: UiSkill[] = [];
    if (this.client) {
      try {
        const raw = await this.client.listSkills();
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
        // Classification (project / global / built-in) is pure — see core/skills.
        skills = classifySkills(raw, root);
      } catch (err) {
        logError('GET /skill failed', err);
      }
    }
    this.post({ type: 'skills', skills });
  }

  /**
   * Both halves of the agent roster for the `/agents` panel: the ones the user
   * can select, and the ones only the model can reach by delegating through the
   * `task` tool. They are different sets — `mode: subagent` never appears in the
   * picker, `mode: primary` is never delegated to — and showing both is the
   * point, since a subagent is invisible in the composer yet still costs the
   * primary session context.
   */
  private async sendAgents(): Promise<void> {
    await this.loadAgents(); // refresh this.lastAgents
    const toUi = (a: AgentInfo): UiAgent => ({
      name: a.name,
      description: a.description,
      mode: a.mode,
      native: a.native,
      modelID: a.model?.modelID ?? undefined,
    });
    const all = this.lastAgents as AgentInfo[];
    this.post({
      type: 'agents',
      agents: pickableAgents(all).map(toUi),
      delegatable: delegatableAgents(all).map(toUi),
    });
  }

  /**
   * Scaffold `.opencode/agent/<name>.md` and open it in the editor. OpenCode
   * discovers agents from disk only at startup — there is no runtime CRUD, and
   * a PATCH /config carrying an agent silently no-ops — so the server has to be
   * restarted before the new agent exists. We write the file and tell the user;
   * the restart happens on their next explicit restart or reload, which keeps a
   * half-written definition from tearing down a live session.
   */
  private async createAgent(rawName: string): Promise<void> {
    const name = rawName.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
    if (!name) {
      this.post({ type: 'error', message: 'Agent name must contain a letter or number.' });
      return;
    }
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) {
      this.post({ type: 'error', message: 'Open a folder before creating an agent.' });
      return;
    }
    const file = vscode.Uri.joinPath(root, '.opencode', 'agent', `${name}.md`);
    try {
      let exists = true;
      try {
        await vscode.workspace.fs.stat(file);
      } catch {
        exists = false;
      }
      if (!exists) {
        const template = [
          '---',
          `description: Describe when this agent should be used. The model reads this verbatim to decide whether to delegate here, so be specific.`,
          '# primary = you pick it in the composer; subagent = the model delegates to it; all = both',
          'mode: subagent',
          '# Optional: pin a model, restrict tools, set reasoning effort',
          '# model: anthropic/claude-sonnet-4-6',
          '# variant: high',
          '# tools:',
          '#   bash: false',
          '---',
          '',
          `You are ${name}. Replace this body with the system prompt for this agent.`,
          '',
        ].join('\n');
        await vscode.workspace.fs.writeFile(file, Buffer.from(template, 'utf8'));
      }
      const doc = await vscode.workspace.openTextDocument(file);
      await vscode.window.showTextDocument(doc, { preview: false });
      this.post({
        type: 'status',
        text: exists
          ? `Opened existing agent "${name}".`
          : `Created .opencode/agent/${name}.md — restart the OpenCode server to load it.`,
        kind: 'info',
      });
    } catch (err) {
      logError('createAgent failed', err);
      this.post({ type: 'error', message: `Could not create agent: ${humanizeError(err)}` });
    }
  }

  /**
   * Send the server's slash commands (custom/built-in commands AND skills) to
   * the webview so they appear in the composer's slash menu. Skills carry
   * source:'skill' so the menu can badge them.
   */
  private async sendCommands(): Promise<void> {
    if (!this.client) {
      return;
    }
    try {
      const raw = await this.client.listCommands();
      const commands: UiCommand[] = raw.map((c) => ({
        name: c.name,
        description: c.description ?? '',
        source: c.source === 'skill' ? 'skill' : 'command',
        takesArgs: commandTakesArgs(c.hints),
      }));
      this.post({ type: 'commands', commands });
    } catch (err) {
      logError('GET /command failed', err);
    }
  }

  /**
   * Run a server command or skill (e.g. the user typed "/fibonacci-helper x").
   * Creates the session lazily if needed (a command is real activity, so it
   * earns a history entry), ensures the model context, then hands off to
   * OpenCode which expands the template and streams the result like a prompt.
   */
  private async handleRunCommand(command: string, args?: string): Promise<void> {
    if (!this.client) {
      throw new Error('OpenCode server is not running.');
    }
    if (!this.currentModel) {
      throw new Error('No model selected.');
    }
    await this.ensureSession();
    const cfg = getConfig();
    if (cfg.autoEnsureContext) {
      await this.ensureModelContext(this.currentModel, cfg.minContextLength, cfg.gpuOffload, (m) =>
        this.post({ type: 'status', text: m }),
      ).catch((err) => logError('ensureContext for command', err));
      this.post({ type: 'status', text: '' });
    }
    this.post({ type: 'busy', busy: true });
    await this.client.runCommand(this.currentSessionID!, {
      command,
      ...(args ? { arguments: args } : {}),
      agent: this.agent,
      model: this.currentModel,
    });
    // A command counts as the first turn of a fresh chat — refresh history so it
    // shows up (and gets its session title from the run).
    await this.sendSessions();
  }

  // ---- Goal loop -----------------------------------------------------------
  // /goal <objective> sets an autonomous goal: after every turn goes idle, an
  // isolated LLM judge decides MET / NOT_MET; NOT_MET auto-continues the agent
  // with the judge's feedback until the goal is met or an unreasonable endpoint
  // is hit (iteration cap or no-progress stall — see core/goal). The judge runs
  // in a throwaway session that is deleted after each check so it never touches
  // the conversation or the history list.

  private postGoal(): void {
    const g = this.activeGoal;
    const goal: UiGoal | null = g
      ? {
          objective: g.objective,
          iteration: g.iteration,
          maxIterations: g.maxIterations,
          startedAt: g.startedAt,
          state: g.paused ? 'paused' : 'active',
        }
      : null;
    this.post({ type: 'goal', goal });
  }

  /** Set (or replace) the goal and kick off pursuit immediately. */
  private async setGoal(objective: string): Promise<void> {
    const obj = objective.trim();
    if (!obj) {
      return;
    }
    this.activeGoal = { ...newGoal(obj), startedAt: Date.now(), paused: false };
    this.lastGoalActivity = Date.now();
    this.postGoal();
    // Kick off right away (like Codex's "Pursuing goal…"): the first turn tells
    // the agent the goal; the idle→judge→continue loop sustains it from there.
    await this.handleSend(
      `Work toward this goal until it is fully met: ${obj}`,
      'auto', // leave depth to the model's own default, as this always has
      [],
      false,
      false,
    );
  }

  /** Un-pause the loop; if the session is already idle, get moving again now. */
  private async resumeGoal(): Promise<void> {
    if (!this.activeGoal) {
      return;
    }
    this.activeGoal.paused = false;
    this.lastGoalActivity = Date.now();
    this.postGoal();
    if (!(await this.isSessionBusy())) {
      void this.runGoalCheck();
    }
  }

  /** Whether the current session has a turn in flight (server-side truth). */
  private async isSessionBusy(): Promise<boolean> {
    try {
      const st = await this.client?.sessionStatus();
      return !!(st && this.currentSessionID && st[this.currentSessionID]);
    } catch {
      return false;
    }
  }

  /** The user-facing identity override (shared by sends + goal continues). */
  private identitySystem(): string {
    return 'You are "OpenCode Chat", an agentic coding assistant running in the user\'s editor against the model provider they chose. If asked your name or what you are, identify as "OpenCode Chat". Never identify yourself as "opencode".';
  }

  /** The goal directive appended to the agent's system prompt while active. */
  private goalSystemSuffix(): string {
    const g = this.activeGoal;
    if (!g || g.paused) {
      return '';
    }
    return (
      `\n\nACTIVE GOAL: ${g.objective}\n` +
      'Keep working toward this goal across turns until it is fully met. ' +
      'Prefer taking the next concrete action over asking for confirmation.'
    );
  }

  /** session.idle hook — run one judge check (debounced by the checking flag). */
  private async onTurnIdle(): Promise<void> {
    if (!this.activeGoal || this.activeGoal.paused || this.goalChecking || this.disposed) {
      return;
    }
    await new Promise((r) => setTimeout(r, 600)); // let final parts persist
    void this.runGoalCheck();
  }

  /** One loop step: transcript → judge → met / continue / stop. */
  private async runGoalCheck(): Promise<void> {
    const goal = this.activeGoal;
    if (
      !goal ||
      goal.paused ||
      this.goalChecking ||
      !this.client ||
      !this.currentSessionID ||
      !this.currentModel
    ) {
      return;
    }
    this.goalChecking = true;
    this.post({ type: 'goalEvent', kind: 'checking' });
    try {
      const transcript = await this.transcriptTail(this.currentSessionID);
      const verdict = await this.judgeGoal(goal.objective, transcript);
      // The goal may have been cleared/edited/paused while the judge ran.
      if (this.activeGoal !== goal || goal.paused) {
        return;
      }
      const action = decideNext(goal, verdict);
      this.lastGoalActivity = Date.now();
      if (action.kind === 'met') {
        this.activeGoal = null;
        this.postGoal();
        this.post({ type: 'goalEvent', kind: 'met', reason: action.reason });
      } else if (action.kind === 'continue') {
        goal.iteration = action.iteration;
        goal.recentReasons = [...goal.recentReasons, action.reason].slice(-5);
        this.postGoal();
        this.post({
          type: 'goalEvent',
          kind: 'continued',
          reason: action.reason,
          iteration: action.iteration,
        });
        await this.continueGoal(goal.objective, action.reason);
      } else {
        // Unreasonable endpoint (cap or stall): pause, keep the goal pinned so
        // the user can see why and resume/raise the cap if they want.
        goal.paused = true;
        this.postGoal();
        this.post({ type: 'goalEvent', kind: 'stopped', why: action.why, reason: action.reason });
      }
    } catch (err) {
      logError('goal check failed', err);
    } finally {
      this.goalChecking = false;
    }
  }

  /** Judge in an isolated throwaway session; always delete it afterwards. */
  private async judgeGoal(
    objective: string,
    transcript: string,
  ): Promise<{ met: boolean; reason: string }> {
    const reply = await this.askThrowaway(
      'goal-judge',
      buildJudgePrompt(objective, transcript),
      'You are a strict goal-completion judge. Answer directly and concisely. ' +
        'Do not produce chain-of-thought.',
    );
    if (!reply.trim()) {
      return { met: false, reason: 'judge timed out' };
    }
    return parseJudgeVerdict(reply);
  }

  /**
   * Ask the current model one question in an isolated throwaway session and
   * return its raw reply text ('' on timeout or disposal). The session never
   * touches chat history — it is always deleted afterwards.
   */
  private async askThrowaway(title: string, prompt: string, system: string): Promise<string> {
    const client = this.client!;
    const session = await client.createSession(title);
    try {
      // Judge verdicts want speed, not deliberation: pin reasoning off via the
      // variant rather than the old qwen-only `/no_think` string, so it works
      // across families and leaves the prompt itself clean. Falls back to a
      // system nudge on models that declare no reasoning support.
      const reasoning = this.modelReasoning(this.currentModel);
      const level = resolveLevel('off', reasoning);
      const nudge = fallbackPromptText(level, reasoning);
      await client.promptAsync(session.id, {
        model: this.modelSelection()!,
        system: nudge ? `${system}\n\n${nudge}` : system,
        ...(variantForLevel(level) ? { variant: variantForLevel(level) } : {}),
        parts: [{ type: 'text', text: prompt }],
      });
      // Poll for the completed assistant reply (local models can be slow).
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1500));
        if (this.disposed) {
          return '';
        }
        const msgs = await client.getMessages(session.id);
        const done = [...msgs]
          .reverse()
          .find((m) => m.info.role === 'assistant' && m.info.time?.completed);
        if (done) {
          return (done.parts ?? [])
            .filter((p): p is Extract<typeof p, { type: 'text' }> => p.type === 'text')
            .map((p) => (p as { text?: string }).text ?? '')
            .join('\n');
        }
      }
      return '';
    } finally {
      void client.deleteSession(session.id).catch(() => undefined);
    }
  }

  /**
   * While a goal is set, ask the model whether a message the user just typed
   * changes the goal itself. If it does, offer the revised objective for
   * confirmation — the goal only changes when the user accepts (updateGoal).
   * Fire-and-forget: the message already went to the agent as a send/steer.
   */
  private maybeOfferGoalRevision(text: string): void {
    const goal = this.activeGoal;
    const trimmed = (text ?? '').trim();
    if (!goal || this.revisionChecking || !this.client || !this.currentModel) {
      return;
    }
    // Slash commands and trivial acks ("ok", "go") can't redefine a goal.
    if (!trimmed || trimmed.startsWith('/') || trimmed.length < 4) {
      return;
    }
    this.revisionChecking = true;
    void (async () => {
      try {
        const reply = await this.askThrowaway(
          'goal-revise',
          buildRevisionPrompt(goal.objective, trimmed),
          'You decide whether a user message changes an agent\'s goal. ' +
            'Answer directly and concisely. Do not produce chain-of-thought.',
        );
        const verdict = parseRevisionVerdict(reply, goal.objective);
        // The goal may have been cleared or replaced while the model thought.
        if (!verdict.revise || !verdict.objective || this.activeGoal !== goal) {
          return;
        }
        this.post({ type: 'goalRevision', proposed: verdict.objective });
      } catch (err) {
        logError('goal revision check failed', err);
      } finally {
        this.revisionChecking = false;
      }
    })();
  }

  /** The tail of the conversation, as plain text for the judge (~4k chars). */
  private async transcriptTail(sessionID: string): Promise<string> {
    const msgs = await this.client!.getMessages(sessionID);
    const lines: string[] = [];
    for (const m of msgs.slice(-8)) {
      const text = (m.parts ?? [])
        .map((p) => {
          if (p.type === 'text') {
            return (p as { text?: string }).text ?? '';
          }
          if (p.type === 'tool') {
            const t = p as { tool?: string; state?: { title?: string } };
            return `[tool: ${t.tool ?? '?'} ${t.state?.title ?? ''}]`;
          }
          return '';
        })
        .filter(Boolean)
        .join('\n');
      if (text.trim()) {
        lines.push(`${m.info.role.toUpperCase()}:\n${text.trim()}`);
      }
    }
    const full = lines.join('\n\n');
    return full.length > 4000 ? full.slice(-4000) : full;
  }

  /** Auto-continue the working agent with the judge's feedback. */
  private async continueGoal(objective: string, reason: string): Promise<void> {
    this.post({ type: 'busy', busy: true });
    await this.sendPrompt({
      model: this.modelSelection()!,
      agent: this.agent,
      system: this.identitySystem() + this.goalSystemSuffix(),
      parts: [{ type: 'text', text: buildContinuePrompt(objective, reason) }],
    });
  }

  /**
   * The selected model split into what the wire wants. Every prompt, summarize
   * and command carries this; `null` only when nothing is selected, which the
   * callers check first.
   */
  private modelSelection(): { providerID: string; modelID: string } | null {
    const parsed = parseModelRef(this.currentModel);
    if (!parsed?.providerID) {
      return null;
    }
    return { providerID: parsed.providerID, modelID: parsed.modelID };
  }

  /** Stable summary of the last probe results, to detect a change cheaply. */
  private probeFingerprint(): string {
    return [...this.lastProbes.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([id, status]) => `${id}:${status}`)
      .join(',');
  }

  /** Display name of the selected model's provider, for error messages. */
  private currentProviderName(): string {
    const sel = this.modelSelection();
    const conn = sel ? this.deps.registry.byProviderId(sel.providerID) : undefined;
    return conn?.name ?? 'the provider';
  }

  /** The local client that owns a model ref, or undefined for a cloud model. */
  private clientForRef(ref: string | null): ReturnType<LocalEndpoints['get']> {
    const parsed = parseModelRef(ref);
    if (!parsed?.providerID) {
      return undefined;
    }
    const conn = this.deps.registry.byProviderId(parsed.providerID);
    return conn && conn.kind === 'local' ? this.deps.endpoints.get(conn.id) : undefined;
  }

  /**
   * Ensure a model has an adequate context window before prompting. Only LM
   * Studio can do this (it is the one flavor exposing a load lifecycle), and
   * only for its own models — for a cloud model the context window is whatever
   * the provider says it is, so this is a no-op rather than an error.
   */
  private async ensureModelContext(
    ref: string,
    minContext: number,
    gpu: string,
    onProgress?: (msg: string) => void,
  ): Promise<{ reloaded: boolean; context?: number; note?: string }> {
    const client = this.clientForRef(ref);
    if (!client?.supportsLifecycle) {
      return { reloaded: false };
    }
    const parsed = parseModelRef(ref);
    return client.ensureContext(parsed!.modelID, minContext, gpu, onProgress);
  }

  /** Push the provider list (with live status badges) to the webview. */
  private async postProviders(connected: boolean): Promise<void> {
    this.connected = connected;
    if (!connected) {
      // Some flips to offline happen outside a health tick (a failed send's
      // reconnect, removing the last provider) — make the next 5s metronome
      // tick probe immediately instead of waiting out the connected cadence.
      this.nextProbeDueAt = 0;
    }
    const connections = this.deps.registry.list();
    const providers: UiProvider[] = connections.map((c) => ({
      id: c.id,
      kind: c.kind,
      providerID: c.providerID,
      name: c.name,
      url: c.baseUrl,
      flavor: c.flavor,
      hasApiKey: !!c.hasApiKey,
      enabled: !c.disabled,
      status: this.providerStatus(c),
      detail: unusableReason(c) ?? undefined,
      modelCount: this.lastModels.filter((m) => m.providerID === c.providerID).length,
    }));
    this.post({ type: 'providers', providers, connected });
  }

  /**
   * A connection's live state for its badge. Only local endpoints have a probed
   * status; a cloud provider is 'ready' once it holds a key, because we never
   * spend a request to find out (see aggregateUpstream).
   */
  private providerStatus(conn: ProviderConnection): UiProvider['status'] {
    if (conn.disabled) {
      return 'disabled';
    }
    if (conn.kind !== 'local') {
      return isUsable(conn) ? 'ready' : 'needs-key';
    }
    const probe = this.lastProbes.get(conn.id);
    if (probe === 'ok') {
      return 'ready';
    }
    if (probe === 'auth-required') {
      return 'needs-key';
    }
    return probe ? 'offline' : 'unknown';
  }

  /**
   * Apply a change to the provider set. The OpenCode server's config is baked
   * at spawn, so any change to what it can reach means a respawn — but the
   * conversation is not the server's, so unlike the old server switch this
   * keeps the current session and transcript intact.
   */
  private async applyProviderChange(): Promise<void> {
    await syncEndpointsFromRegistry(this.deps.registry, this.deps.endpoints);
    this.healer.allowImmediate(); // a deliberate change shouldn't wait on backoff
    this.teardownConnection(true);
    await this.init();
    await this.postProviders(this.connected);
  }

  /** Send the add-provider picker its (searchable) catalog page. */
  private async sendCatalog(query: string): Promise<void> {
    const entries = await this.deps.catalog.load();
    const configured = new Set(this.deps.registry.list().map((c) => c.providerID));
    this.post({
      type: 'catalog',
      query,
      providers: searchCatalog(entries, query).map((e) => ({
        id: e.id,
        name: e.name,
        doc: e.doc,
        modelCount: e.modelCount,
        configured: configured.has(e.id),
      })),
    });
  }

  /**
   * Probe the well-known local inference ports and report which answered, so
   * someone already running LM Studio or Ollama can add it with one click
   * instead of typing a URL. Purely loopback; nothing is added automatically.
   */
  private async detectLocalProviders(): Promise<void> {
    const known = new Set(
      this.deps.registry
        .list()
        .filter((c) => c.kind === 'local')
        .map((c) => c.baseUrl),
    );
    const found = await Promise.all(
      LOCAL_PROBE_TARGETS.map(async (t) => {
        if (known.has(t.url)) {
          return null; // already configured — don't offer a duplicate
        }
        const flavor = await detectFlavor(t.url);
        return flavor ? { name: t.name, url: t.url, flavor } : null;
      }),
    );
    this.post({ type: 'detectedLocal', servers: found.filter((f) => !!f) });
  }

  /**
   * Push a fresh model list to the webview.
   *
   * 'action' (user did something: load/eject/rescan/reconnect) always posts —
   * the webview uses the reply to clear load spinners and dismiss the menu.
   * 'periodic' (health cadence / picker loop / visibility catch-up) is
   * best-effort: skipped while hidden or disconnected, and suppressed when
   * nothing changed so the webview isn't re-rendered every cycle for no reason.
   */
  private async refreshModelsToWebview(reason: 'action' | 'periodic' = 'action'): Promise<void> {
    if (reason === 'periodic' && (!this.visible || !this.connected)) {
      return;
    }
    const models = await this.loadModels();
    if (reason === 'periodic' && models.length === 0) {
      // A transient listing failure surfaces as [] — never blank a populated
      // picker from a background refresh; an 'action' post stays authoritative.
      return;
    }
    const payload = { models, currentModel: this.currentModel };
    const json = JSON.stringify(payload);
    if (reason === 'periodic' && json === this.lastPostedModelsJson) {
      return;
    }
    this.lastPostedModelsJson = json;
    this.post({ type: 'models', ...payload, reason });
  }

  /** The webview's model picker opened/closed: run a fast refresh loop while open. */
  private setModelMenuOpen(open: boolean): void {
    if (open) {
      if (!this.pickerTimer && !this.disposed) {
        void this.refreshModelsToWebview('periodic');
        this.pickerTimer = setInterval(
          () => void this.refreshModelsToWebview('periodic'),
          PICKER_REFRESH_MS,
        );
      }
    } else if (this.pickerTimer) {
      clearInterval(this.pickerTimer);
      this.pickerTimer = undefined;
    }
  }

  private async handleLoadModel(modelID: string): Promise<void> {
    const cfg = getConfig();
    this.post({ type: 'status', text: `Loading ${modelID}…` });
    const result = await this.ensureModelContext(
      modelID,
      cfg.minContextLength,
      cfg.gpuOffload,
      (m) => this.post({ type: 'status', text: m }),
    );
    if (result.note) {
      this.post({ type: 'status', text: result.note, kind: 'warn' });
      setTimeout(() => this.post({ type: 'status', text: '' }), 4000);
    } else {
      this.post({ type: 'status', text: '' });
    }
    await this.refreshModelsToWebview();
  }

  /** Persist a new context window and restart OpenCode so it takes effect. */
  private async setContextSize(tokens: number): Promise<void> {
    // Never persist more context than the selected model actually supports.
    const model = this.lastModels.find((m) => m.id === this.currentModel);
    const clamped = clampContext(tokens, model?.maxContextLength);
    try {
      await vscode.workspace
        .getConfiguration('opencodeChat')
        .update('minContextLength', clamped, vscode.ConfigurationTarget.Global);
    } catch (err) {
      logError('update minContextLength', err);
    }
    this.post({
      type: 'status',
      text: `Setting context to ${Math.round(clamped / 1024)}K — restarting…`,
    });
    // Restart the OpenCode server so num_ctx / limit.context rebuild; keep the
    // current session (sessions persist on disk).
    this.teardownConnection(true);
    await this.init();
    this.post({ type: 'status', text: '' });
  }

  private async handleUnloadModel(modelID: string): Promise<void> {
    this.post({ type: 'status', text: `Unloading ${modelID}…` });
    try {
      await this.clientForRef(modelID)?.unloadModel(modelID.slice(modelID.indexOf('/') + 1));
    } catch (err) {
      logError(`unload ${modelID}`, err);
    }
    this.post({ type: 'status', text: '' });
    await this.refreshModelsToWebview();
  }

  /**
   * The model list, assembled from two sources.
   *
   * `GET /config/providers` is the base and the authority: it returns exactly
   * the providers the running server accepted and, for each, the models it will
   * take — with names, context limits, capabilities, prices and the model's own
   * reasoning `variants`. That covers all 176 catalog providers with no
   * per-provider code, and it covers our local endpoints too, since we declared
   * them into the same config.
   *
   * Local endpoints then get a second pass from their own client, which knows
   * things no catalog can: whether a model is loaded in memory right now, the
   * context window it was loaded with, its quantization and runtime format.
   * That metadata drives the load/eject controls, so it is merged on top.
   */
  private async loadModels(): Promise<UiModel[]> {
    if (!this.client) {
      return [];
    }
    let providers: Awaited<ReturnType<OpencodeClient['listProviders']>>;
    try {
      providers = await this.client.listProviders();
    } catch (err) {
      logError('GET /config/providers failed', err);
      return this.lastModels;
    }
    // Local metadata, keyed by "<providerID>/<modelID>" so the merge is a lookup.
    const localByRef = new Map<string, LocalModel>();
    const localConnByProvider = new Map<string, ProviderConnection>();
    for (const conn of this.deps.registry.enabled()) {
      if (conn.kind === 'local') {
        localConnByProvider.set(conn.providerID, conn);
      }
    }
    if (localConnByProvider.size) {
      const byConn = await this.deps.endpoints.listAllModels();
      for (const [connId, models] of byConn) {
        const conn = this.deps.registry.byId(connId);
        if (!conn) {
          continue;
        }
        for (const m of models) {
          localByRef.set(formatModelRef(conn.providerID, m.id), m);
        }
      }
    }

    const known = new Map(this.deps.registry.list().map((c) => [c.providerID, c]));
    const out: UiModel[] = [];
    for (const provider of providers.providers) {
      const conn = known.get(provider.id);
      // A provider the server knows but the registry does not is one the user
      // removed a moment ago (or one OpenCode picked up from the environment) —
      // either way it is not ours to offer.
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
          cost: info.cost?.input !== undefined || info.cost?.output !== undefined
            ? { input: info.cost?.input, output: info.cost?.output }
            : undefined,
          // Local models use the variant table WE declared, so their granularity
          // comes from LM Studio's capability report. Catalog models publish
          // their own variants, which are the exact names they accept.
          reasoning: local
            ? local.reasoning
            : caps?.reasoning
              ? { allowedOptions: variants, declared: true }
              : null,
        });
      }
    }
    // Group by provider (registry order), models alphabetical within each, so
    // the picker is stable across refreshes rather than following server order.
    const order = new Map([...known.keys()].map((id, i) => [id, i]));
    out.sort(
      (a, b) =>
        (order.get(a.providerID) ?? 99) - (order.get(b.providerID) ?? 99) ||
        a.name.localeCompare(b.name),
    );
    this.lastModels = out;
    return out;
  }

  /**
   * Agents the server knows, filtered to the ones a user can actually select.
   * User-defined agents come from .opencode/agent/*.md (and the global
   * ~/.config/opencode/agent/), discovered by OpenCode at startup — so a newly
   * added agent appears after the next server restart, not immediately.
   */
  private async loadAgents(): Promise<UiAgent[]> {
    if (!this.client) {
      return [];
    }
    try {
      this.lastAgents = await this.client.listAgents();
    } catch (err) {
      // Never fatal: an older server or a transient failure just means the
      // picker falls back to the built-in pair.
      logError('could not enumerate agents', err);
      this.lastAgents = [];
    }
    return pickableAgents(this.lastAgents as AgentInfo[]).map((a) => ({
      name: a.name,
      description: a.description,
      mode: a.mode,
      native: a.native,
      modelID: a.model?.modelID ?? undefined,
    }));
  }

  /**
   * Declared reasoning capability for a model id, from the last enumeration.
   * `undefined` when we've never seen the model or the endpoint couldn't report
   * it — which the effort logic treats as "unknown", not "unsupported".
   */
  private modelReasoning(modelID: string | null): ReasoningCapability | null | undefined {
    if (!modelID) {
      return undefined;
    }
    return this.lastModels.find((m) => m.id === modelID)?.reasoning;
  }

  /**
   * Start a fresh chat WITHOUT creating a server session yet. The actual
   * OpenCode session is created lazily on the first send (see handleSend), so an
   * untouched "New chat" never lands in history — only conversations with real
   * back-and-forth do. Resets to a null session and clears the view.
   */
  private async newSession(announce = true): Promise<void> {
    this.currentSessionID = null;
    this.persistSession(null);
    // A goal is scoped to its conversation — leaving it ends the loop.
    this.activeGoal = null;
    this.postGoal();
    this.updateTitle('New chat');
    this.post({ type: 'cleared' });
    if (announce) {
      await this.sendSessions();
    }
  }

  /**
   * Ensure a server session exists for the current chat, creating one on demand.
   * Called right before the first prompt of a fresh chat — this is the moment a
   * "New chat" actually becomes a real session (and thus a history entry).
   */
  private async ensureSession(): Promise<void> {
    if (this.currentSessionID || !this.client) {
      return;
    }
    if (this.ensuringSession) {
      return this.ensuringSession;
    }
    const client = this.client;
    this.ensuringSession = (async () => {
      try {
        const session = await client.createSession('New chat');
        if (this.currentSessionID) {
          // A concurrent loadSession won the race — don't clobber it; discard
          // the session we just created so it doesn't linger as an empty entry.
          void client.deleteSession(session.id).catch(() => undefined);
          return;
        }
        this.currentSessionID = session.id;
        this.persistSession(session.id);
      } finally {
        this.ensuringSession = undefined;
      }
    })();
    return this.ensuringSession;
  }

  private async sendSessions(): Promise<void> {
    if (!this.client) {
      return;
    }
    const sessions = await this.client.listSessions();
    const ui: UiSession[] = sessions.map((s) => ({
      id: s.id,
      title: s.title || 'Untitled',
      updated: s.time?.updated ?? 0,
    }));
    const current = ui.find((s) => s.id === this.currentSessionID);
    if (current) {
      this.updateTitle(current.title);
    }
    this.post({ type: 'sessions', sessions: ui, currentSessionID: this.currentSessionID });
  }

  /**
   * One-time cleanup of empty sessions left over from before sessions went lazy.
   * Going forward none are created, but a user upgrading has a pile of zero-
   * message "New chat" entries. A session that never had a message keeps
   * time.created === time.updated (verified: the first prompt bumps `updated`);
   * we confirm zero messages before deleting so a real session is never removed.
   * Best-effort and quiet — failures here must never block startup.
   */
  private async pruneEmptySessions(): Promise<void> {
    if (!this.client) {
      return;
    }
    let removed = 0;
    try {
      const sessions = await this.client.listSessions();
      // Two guards keep this from deleting a session another open view is using:
      // an age floor (skip very recent sessions — likely a sibling's in-flight
      // new chat) and a workspace scope (only prune sessions in our directory,
      // since the OpenCode store is shared across projects). Leftover empties
      // from before lazy sessions are old + in-workspace, so still get cleaned.
      const candidates = emptySessionCandidates(sessions, {
        currentSessionID: this.currentSessionID,
        directory: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '',
        now: Date.now(),
      });
      for (const s of candidates) {
        try {
          const messages = await this.client.getMessages(s.id);
          if (Array.isArray(messages) && messages.length === 0) {
            await this.client.deleteSession(s.id);
            removed++;
          }
        } catch {
          // skip this one — never let cleanup throw
        }
      }
    } catch (err) {
      logError('pruneEmptySessions', err);
    }
    if (removed > 0) {
      log(`pruned ${removed} empty session(s)`);
      await this.sendSessions();
    }
  }

  private async clearAllSessions(): Promise<void> {
    if (!this.client) {
      return;
    }
    this.post({ type: 'status', text: 'Clearing sessions…' });
    const sessions = await this.client.listSessions();
    for (const s of sessions) {
      await this.client.deleteSession(s.id).catch(() => undefined);
    }
    this.currentSessionID = null;
    await this.newSession(false);
    this.post({ type: 'cleared' });
    this.post({ type: 'status', text: '' });
    await this.sendSessions();
  }

  /**
   * Compact the current conversation via OpenCode's summarize endpoint — the
   * `/compact` slash command. Blocks input for the duration (`compacting`),
   * then hands the webview the summary text OpenCode produced so it can be shown
   * in the compaction chip. The reduced token count only lands on the next real
   * turn (the summarizer turn reports no usable usage), so we don't fake it here.
   */
  private async compactSession(): Promise<void> {
    if (!this.client || !this.currentSessionID) {
      this.post({ type: 'status', text: 'Nothing to compact yet.', kind: 'warn' });
      return;
    }
    if (!this.currentModel) {
      this.post({ type: 'status', text: 'Select a model before compacting.', kind: 'warn' });
      return;
    }
    this.post({ type: 'compacting', active: true });
    this.post({ type: 'status', text: 'Compacting conversation…' });
    let summary = '';
    try {
      const sel = this.modelSelection();
      await this.client.summarize(this.currentSessionID, sel!.providerID, sel!.modelID);
      summary = await this.latestSummary(this.currentSessionID);
    } finally {
      // Always release the input, even if summarize threw (onMessage's catch
      // surfaces the error). A stuck "compacting" lock would be worse.
      this.post({ type: 'compacting', active: false, summary });
      this.post({ type: 'status', text: '' });
    }
  }

  /**
   * The summary text from the most recent compaction: the assistant turn that
   * immediately follows a `compaction`-part message. Empty string if none found.
   */
  private async latestSummary(sessionID: string): Promise<string> {
    try {
      const messages = await this.client!.getMessages(sessionID);
      let pending = false;
      let summary = '';
      for (const m of messages) {
        const isMarker = (m.parts ?? []).some((part) => part.type === 'compaction');
        if (isMarker) {
          pending = true;
          continue;
        }
        if (pending && m.info.role === 'assistant') {
          summary = (m.parts ?? [])
            .filter((part): part is Extract<typeof part, { type: 'text' }> => part.type === 'text')
            .map((part) => (part as { text?: string }).text ?? '')
            .join('')
            .trim();
          pending = false;
        }
      }
      return summary;
    } catch {
      return '';
    }
  }

  /** Remember (or forget) the active session so the next launch can restore it. */
  private persistSession(id: string | null): void {
    void this.deps.context.workspaceState.update(LAST_SESSION_KEY, id ?? undefined);
  }

  /**
   * On the first init of a fresh bridge, reopen the conversation that was
   * active when the window closed. Never on reconnects (restoreAttempted), and
   * only one panel per window may claim the restore (sessionRestoreClaimed).
   */
  private async maybeRestoreLastSession(): Promise<void> {
    if (this.restoreAttempted || this.currentSessionID || sessionRestoreClaimed || !this.client) {
      this.restoreAttempted = true;
      return;
    }
    this.restoreAttempted = true;
    const stored = this.deps.context.workspaceState.get<string>(LAST_SESSION_KEY);
    if (!stored) {
      return;
    }
    sessionRestoreClaimed = true;
    try {
      // Validate against the real session list — getMessages on a deleted id
      // can return an empty transcript rather than throwing.
      const sessions = await this.client.listSessions();
      const match = sessions.find((s) => s.id === stored);
      if (!match) {
        this.persistSession(null); // deleted elsewhere — forget the stale id
        return;
      }
      const messages = await this.client.getMessages(stored);
      this.currentSessionID = stored;
      const title = match.title || 'Chat';
      this.updateTitle(title);
      this.post({ type: 'sessionLoaded', sessionID: stored, title, messages });
    } catch (err) {
      // Restore is best-effort — fall back to the normal fresh-chat path.
      logError('restore last session', err);
      this.currentSessionID = null;
    }
  }

  private async loadSession(sessionID: string): Promise<void> {
    if (!this.client) {
      return;
    }
    // A goal is scoped to its conversation — switching sessions ends the loop.
    this.activeGoal = null;
    this.postGoal();
    this.currentSessionID = sessionID;
    this.persistSession(sessionID);
    const messages = await this.client.getMessages(sessionID);
    const sessions = await this.client.listSessions();
    const title = sessions.find((s) => s.id === sessionID)?.title ?? 'Chat';
    this.updateTitle(title);
    this.post({ type: 'sessionLoaded', sessionID, title, messages });
  }

  private async handleSend(
    text: string,
    effort: EffortLevel,
    images: UiImage[],
    includeActiveFile: boolean,
    includeSelection: boolean,
  ): Promise<void> {
    if (!this.client) {
      throw new Error('OpenCode server is not running.');
    }
    if (!this.currentModel) {
      throw new Error('No model selected.');
    }
    // Lazily create the server session on the first message of a fresh chat, so
    // an untouched "New chat" never exists server-side (and never shows in
    // history).
    await this.ensureSession();
    const cfg = getConfig();

    if (cfg.autoEnsureContext) {
      const result = await this.ensureModelContext(
        this.currentModel,
        cfg.minContextLength,
        cfg.gpuOffload,
        (m) => this.post({ type: 'status', text: m }),
      );
      if (result.note) {
        log(`ensureContext: ${result.note}`);
      }
      if (result.reloaded) {
        await this.refreshModelsToWebview('periodic');
      }
      this.post({ type: 'status', text: '' });
    }

    // Identity: OpenCode's base prompt makes the model call itself "opencode".
    // Our system text is appended, so this overrides the user-facing identity.
    let system = this.identitySystem() + this.goalSystemSuffix();

    // Reasoning effort. The real lever is the `variant` on the prompt body,
    // which OpenCode resolves to the provider's own reasoning field —
    // engine-level, and it doesn't pollute the user's message the way the old
    // `/no_think` suffix did. Clamp to what this model actually declares, so a
    // level carried over from a different model can't be sent blindly.
    const reasoning = this.modelReasoning(this.currentModel);
    const level = resolveLevel(effort, reasoning);
    const variant = variantForLevel(level);
    // Only for models that declare no reasoning capability at all is there
    // nothing to send — there, a text nudge is the one remaining lever.
    const nudge = fallbackPromptText(level, reasoning);
    if (nudge) {
      system += `\n\n${nudge}`;
    }

    const parts: PromptBody['parts'] = [{ type: 'text', text }];
    for (const img of images) {
      parts.push({ type: 'file', mime: img.mime, url: img.dataUrl, filename: img.name });
    }
    // Attach the currently open file as context (excludable from the UI).
    if (includeActiveFile && this.activeFile) {
      try {
        const MAX = 80 * 1024;
        let content = fs.readFileSync(this.activeFile.abs, 'utf8');
        if (content.length > MAX) {
          content = content.slice(0, MAX) + '\n\n…[truncated]';
        }
        parts.push({
          type: 'file',
          mime: 'text/plain',
          filename: this.activeFile.rel,
          url: `file://${this.activeFile.abs}`,
          source: { type: 'file', path: this.activeFile.abs, text: { value: content, start: 0, end: content.length } },
        });
      } catch (err) {
        logError('attach active file failed', err);
      }
    }

    // Attach the current editor selection as context (auto-included, excludable
    // from the UI). Shared as a file part scoped to the selection's range, so
    // the model sees exactly the highlighted code plus where it lives. The
    // filename carries the line range (e.g. app.js#14-19) so it's self-labeling.
    if (includeSelection && this.activeSelection) {
      const s = this.activeSelection;
      const label = selectionLabel(s.rel, s.startLine, s.endLine);
      parts.push({
        type: 'file',
        mime: 'text/plain',
        filename: label,
        url: `file://${s.abs}`,
        source: { type: 'file', path: s.abs, text: { value: s.text, start: s.start, end: s.end } },
      });
    }

    this.post({ type: 'busy', busy: true });
    await this.sendPrompt({
      model: this.modelSelection()!,
      agent: this.agent,
      ...(system ? { system } : {}),
      ...(variant ? { variant } : {}),
      parts,
    });

    // Auto-name the session from the first user prompt.
    if ((this.currentTitle === 'New chat' || this.currentTitle === '') && text.trim()) {
      const title = deriveTitle(text);
      if (title) {
        try {
          await this.client.updateSession(this.currentSessionID!, { title });
        } catch (err) {
          logError('auto-title failed', err);
        }
        this.updateTitle(title);
        await this.sendSessions();
      }
    }
  }

  /**
   * Send a prompt with one transparent self-heal: if the request fails because
   * the OpenCode server is unreachable, reconnect (respawning it if it died)
   * and retry once before surfacing a friendly error.
   */
  private async sendPrompt(body: PromptBody): Promise<void> {
    try {
      await this.client!.promptAsync(this.currentSessionID!, body);
    } catch (err) {
      if (!isConnectionError(err)) {
        throw err;
      }
      logError('prompt failed on a connection error — reconnecting and retrying', err);
      this.post({ type: 'status', text: 'Reconnecting…', kind: 'warn' });
      const live = await this.reconnect();
      if (live && this.client && this.currentSessionID) {
        await this.client.promptAsync(this.currentSessionID, body);
        this.post({ type: 'status', text: '' });
        return;
      }
      throw new Error(
        'Lost the connection to your model provider. If it is a local server, start it and try again; I’ll keep reconnecting in the background.',
      );
    }
  }

  private startEventStream(): void {
    if (this.eventAbort || !this.client) {
      return;
    }
    this.eventAbort = new AbortController();
    void this.client.subscribeEvents((event) => this.relayEvent(event), this.eventAbort.signal);
  }

  /** Forward only events that belong to the active session (plus globals). */
  private relayEvent(event: OpencodeEvent): void {
    const sid = sessionIdOf(event);
    // Drop a session-scoped event unless it's for the active session. Also drop
    // it when no session is active yet (sid set, currentSessionID null) so a
    // stray event mid-init can't leak into the webview.
    if (sid && sid !== this.currentSessionID) {
      return;
    }
    // Goal loop: a finished turn on the active session triggers one judge check.
    if (event.type === 'session.idle' && sid && sid === this.currentSessionID) {
      void this.onTurnIdle();
    }
    this.post({ type: 'event', event });
  }

  private async openFile(p: string): Promise<void> {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    const abs = path.isAbsolute(p) ? p : path.join(cwd, p);
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(abs));
      await vscode.window.showTextDocument(doc, { preview: true });
    } catch (err) {
      logError(`openFile ${abs}`, err);
    }
  }
}

function sessionIdOf(event: OpencodeEvent): string | undefined {
  const p = event.properties as any;
  return (
    p?.sessionID ??
    p?.info?.sessionID ??
    p?.part?.sessionID ??
    undefined
  );
}

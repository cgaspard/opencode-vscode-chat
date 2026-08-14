// Message protocol shared between the extension host and the webview.
import type { EffortLevel, ReasoningCapability } from './core/effort';
import type { PermissionMode } from './core/permission';
import type { ConnectionKind, LocalFlavor, LocalServerOption } from './core/providers';
import type { MessageWithParts, OpencodeEvent, PermissionResponse } from './opencode/protocol';

export type { ConnectionKind, EffortLevel, LocalFlavor, LocalServerOption, PermissionMode, ReasoningCapability };

export interface UiModel {
  /** Provider-qualified reference, "<providerID>/<modelID>" — unique, and what selection stores. */
  id: string;
  /** The provider this model is served by. */
  providerID: string;
  /** That provider's display name, for the picker's grouping header. */
  providerName: string;
  providerKind: ConnectionKind;
  /** The bare model id the provider knows it by. */
  modelID: string;
  name: string;
  /** Whether the model is loaded in memory. Only local endpoints report this. */
  loaded?: boolean;
  /** True when this model can be loaded/ejected from the picker (LM Studio only). */
  lifecycle?: boolean;
  contextLength?: number;
  maxContextLength?: number;
  toolUse?: boolean;
  vision?: boolean;
  publisher?: string; // disambiguates same-named models (e.g. unsloth vs lmstudio-community)
  quantization?: string; // e.g. "8bit", "Q8_0"
  format?: string; // runtime format, e.g. "MLX" or "GGUF"
  /** USD per million tokens, when the catalog prices the model. */
  cost?: { input?: number; output?: number };
  /**
   * Declared reasoning support. `null` = model reports none (hide the effort
   * control); `undefined` = unknown (offer every level — sending an
   * unsupported one is a no-op). Drives the picker in src/core/effort.ts.
   */
  reasoning?: ReasoningCapability | null;
}

export interface UiSession {
  id: string;
  title: string;
  updated: number;
}

/** One configured provider, as shown in the Providers panel. */
export interface UiProvider {
  id: string;
  kind: ConnectionKind;
  /** The id OpenCode knows it by — 'anthropic', or our slug for a local endpoint. */
  providerID: string;
  name: string;
  /** Local endpoints only. */
  url?: string;
  flavor?: LocalFlavor;
  /** Whether a key is stored — the key itself never reaches the webview. */
  hasApiKey: boolean;
  enabled: boolean;
  /**
   * 'ready' = can serve models; 'needs-key' = configured but unusable without
   * one; 'offline' = a local endpoint that isn't answering; 'disabled' = parked
   * by the user; 'unknown' = not probed yet.
   */
  status: 'ready' | 'needs-key' | 'offline' | 'disabled' | 'unknown';
  /** Short explanation for the badge, when there is one. */
  detail?: string;
  /** How many models this provider is currently contributing to the picker. */
  modelCount: number;
}

/** One provider from the models.dev catalog, offered in the add-provider picker. */
export interface UiCatalogProvider {
  id: string;
  name: string;
  /** Docs URL — "where do I get a key?". */
  doc?: string;
  modelCount: number;
  /** True when the user already has this provider configured. */
  configured: boolean;
}

/** A local inference server found by the autodetect probe. */
export interface UiDetectedServer {
  name: string;
  url: string;
  flavor: LocalFlavor;
}

/** A server-provided slash command (a user/built-in command, or a skill). */
export interface UiCommand {
  name: string;
  description: string;
  /** 'command' or 'skill' — lets the menu badge skills. */
  source: 'command' | 'skill';
  /** True if the command template takes arguments ($ARGUMENTS). */
  takesArgs: boolean;
}

/** One skill, as shown in the /skills panel. */
export interface UiSkill {
  name: string;
  description: string;
  /** 'project' (.opencode/skill or .claude/skills), 'global' (~/.claude), or 'built-in'. */
  source: 'project' | 'global' | 'built-in';
  /** Absolute SKILL.md path for disk skills (omitted for built-ins). */
  path?: string;
  /** Whether the skill is also invocable as a slash command. */
  slash?: boolean;
}

/**
 * One agent the user can select. Mirrors `GET /agent`, filtered to the pickable
 * set (mode primary/all, non-hidden). Subagents are excluded — the model
 * delegates to those via the task tool, the user never drives them directly.
 */
export interface UiAgent {
  name: string;
  description?: string;
  /** 'primary' | 'subagent' | 'all'. */
  mode?: string;
  /** False for user-defined agents, so the picker can badge them. */
  native?: boolean;
  /** Set when the agent pins its own model rather than inheriting the session's. */
  modelID?: string;
}

/** The active goal, as shown in the pinned goal bar. */
export interface UiGoal {
  objective: string;
  /** Auto-continue rounds completed so far. */
  iteration: number;
  maxIterations: number;
  /** Epoch ms when the goal was set (drives the elapsed display). */
  startedAt: number;
  /** 'active' = loop running; 'paused' = kept but not auto-continuing. */
  state: 'active' | 'paused';
}

/** One MCP server's status, as shown in the /mcp panel. */
export interface UiMcpServer {
  name: string;
  /** 'connected' | 'disabled' | 'failed' | 'pending' (or any future status). */
  status: string;
  /** Failure reason, when status is 'failed'. */
  error?: string;
  /** 'local' (stdio) or 'remote' (http/sse), when known from the config. */
  transport?: 'local' | 'remote';
  /** The command (local) or url (remote) it was configured with, for display. */
  detail?: string;
}

// ---- Host -> Webview -----------------------------------------------------
export type HostToWebview =
  | {
      type: 'init';
      models: UiModel[];
      currentModel: string | null;
      /** Name of the active agent — no longer a fixed enum; see UiAgent. */
      agent: string;
      /** Agents the user can select (mode primary/all, non-hidden). */
      agents: UiAgent[];
      cwd: string;
      serverReady: boolean;
      /** Whether any provider can currently serve a model. */
      upstreamConnected: boolean;
      /** Set when a provider answered 401/403 — reachable, but the request was rejected. */
      upstreamAuthRequired?: boolean;
      /** Whether the user has any usable provider configured (drives onboarding). */
      hasProviders: boolean;
      minContext: number;
      /** Fallback effort for models with no per-model choice stored yet. */
      defaultEffort: EffortLevel;
      /** Current tool-approval posture (drives the composer's permissions picker). */
      permissionMode: PermissionMode;
    }
  // reason 'action' = reply to something the user did (load/eject/rescan) and
  // may clear load spinners / dismiss the picker; 'periodic' = background
  // refresh that must not touch in-flight UI state. Absent = 'action'.
  | { type: 'models'; models: UiModel[]; currentModel: string | null; reason?: 'action' | 'periodic' }
  | { type: 'providers'; providers: UiProvider[]; connected: boolean }
  // Reply to searchCatalog: the matching page of the models.dev provider list.
  // `providers` is key-needing providers only — local runtimes are split out so
  // each tab lists one kind. `localServers` is the full prefill list for the
  // local tab; `localMatches` is the subset matching `query`, for the "that's a
  // local server" hint in the API-key tab.
  | {
      type: 'catalog';
      query: string;
      providers: UiCatalogProvider[];
      localServers: LocalServerOption[];
      localMatches: LocalServerOption[];
    }
  // Reply to detectLocalProviders: local servers that answered a probe.
  | { type: 'detectedLocal'; servers: UiDetectedServer[] }
  | { type: 'sessions'; sessions: UiSession[]; currentSessionID: string | null }
  | { type: 'sessionLoaded'; sessionID: string; title: string; messages: MessageWithParts[] }
  | { type: 'cleared' }
  | { type: 'event'; event: OpencodeEvent }
  | { type: 'busy'; busy: boolean }
  // A /compact run is in flight (block input) or has finished (with the summary
  // text, if OpenCode produced one). `summary` is only set when done === true.
  | { type: 'compacting'; active: boolean; summary?: string }
  | { type: 'activeFile'; path: string | null; chars: number }
  // The current editor selection (or null when nothing is selected). Drives the
  // excludable "selection" pill in the composer; the raw text is attached as
  // context on send, not echoed here.
  | {
      type: 'activeSelection';
      selection: { path: string; startLine: number; endLine: number; chars: number } | null;
    }
  | { type: 'status'; text: string; kind?: 'info' | 'warn' | 'error' }
  | { type: 'command'; command: 'history' | 'newChat' | 'focusInput' }
  // Result of a /mcp request: the configured MCP servers and their live status.
  // `servers` is empty when none are configured.
  | { type: 'mcpStatus'; servers: UiMcpServer[] }
  // Result of a /skills request: the discovered skills (empty if none).
  | { type: 'skills'; skills: UiSkill[] }
  // Result of an /agents request: every agent the server knows, both the ones
  // the user can pick and the ones only the model can delegate to.
  | { type: 'agents'; agents: UiAgent[]; delegatable: UiAgent[] }
  // Server-provided slash commands (skills + custom/built-in commands) to merge
  // into the composer's slash menu.
  | { type: 'commands'; commands: UiCommand[] }
  // The active goal (pinned bar), or null when none.
  | { type: 'goal'; goal: UiGoal | null }
  // Loop lifecycle notices: judging, auto-continued, met, stopped (with why),
  // or the objective was revised by a confirmed goalRevision offer.
  | {
      type: 'goalEvent';
      kind: 'checking' | 'continued' | 'met' | 'stopped' | 'updated';
      reason?: string;
      iteration?: number;
      why?: 'max-iterations' | 'stalled';
    }
  // A message the user typed looks like it changes the active goal; `proposed`
  // is the model's revised objective. The goal only changes if the user
  // confirms (which sends `updateGoal` back).
  | { type: 'goalRevision'; proposed: string }
  // Ack that the permission mode was persisted (also syncs the picker when the
  // change came from another panel or settings.json).
  | { type: 'permissionMode'; mode: PermissionMode }
  | { type: 'error'; message: string };

// ---- Webview -> Host -----------------------------------------------------
export interface UiImage {
  mime: string;
  dataUrl: string;
  name?: string;
}

export type WebviewToHost =
  | { type: 'ready' }
  | {
      type: 'send';
      text: string;
      /** Reasoning depth for this turn. Replaces the old `thinking` boolean. */
      effort: EffortLevel;
      images?: UiImage[];
      includeActiveFile?: boolean;
      includeSelection?: boolean;
    }
  | { type: 'selectModel'; modelID: string }
  | { type: 'loadModel'; modelID: string }
  | { type: 'unloadModel'; modelID: string }
  | { type: 'setContextSize'; tokens: number }
  | { type: 'refreshModels' }
  // The model picker opened/closed — the host fast-polls the list while open.
  | { type: 'modelMenu'; open: boolean }
  | { type: 'listProviders' }
  // Page the add-provider picker; '' returns the featured head.
  | { type: 'searchCatalog'; query?: string }
  | { type: 'addProvider'; providerID: string; name: string; apiKey?: string }
  | { type: 'addLocalProvider'; name: string; url: string; apiKey?: string; flavor?: LocalFlavor }
  // apiKey is a tri-state edit: undefined keeps the stored key, null removes it,
  // a non-blank string replaces it.
  | { type: 'updateProvider'; id: string; name?: string; url?: string; apiKey?: string | null }
  | { type: 'removeProvider'; id: string }
  | { type: 'setProviderEnabled'; id: string; enabled: boolean }
  | { type: 'detectLocalProviders' }
  | { type: 'selectAgent'; agent: string }
  // Persist a new tool-approval posture (settings) — the server picks it up on
  // its next spawn; the host acks with 'permissionMode'.
  | { type: 'setPermissionMode'; mode: PermissionMode }
  | { type: 'requestAgents' }
  /** Scaffold a new agent definition on disk and open it for editing. */
  | { type: 'createAgent'; name: string }
  | { type: 'newChat' }
  | { type: 'loadSessions' }
  | { type: 'loadSession'; sessionID: string }
  | { type: 'deleteSession'; sessionID: string }
  | { type: 'clearAllSessions' }
  | { type: 'compact' }
  | { type: 'abort' }
  | { type: 'permission'; sessionID: string; permissionID: string; response: PermissionResponse }
  | { type: 'questionReply'; requestID: string; answers: string[][] }
  | { type: 'questionReject'; requestID: string }
  | { type: 'openFile'; path: string }
  | { type: 'openInTab' }
  | { type: 'requestMcpStatus' }
  | { type: 'requestSkills' }
  // Run a server command/skill (e.g. typed "/fibonacci-helper some args").
  | { type: 'runCommand'; command: string; arguments?: string }
  // Goal loop controls (the /goal command + the pinned bar's buttons).
  | { type: 'setGoal'; objective: string }
  // Confirmed goal revision: replace the objective, keep the goal running.
  | { type: 'updateGoal'; objective: string }
  | { type: 'pauseGoal' }
  | { type: 'resumeGoal' }
  | { type: 'clearGoal' }
  | { type: 'retryConnect' };

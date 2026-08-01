/**
 * Reasoning-effort ("thinking effort") math, shared by the OpenCode server
 * config, the bridge (send path) and the webview (picker). Pure so it is
 * unit-testable and browser-safe.
 *
 * How the chain works, end to end — all of this was verified on the wire against
 * OpenCode 1.18.4 + LM Studio 0.4.19, not inferred from docs:
 *
 *   UI level ──▶ PromptBody.variant ──▶ provider.<id>.models.<model>.variants
 *                                                  │
 *                                                  ▼
 *                        the provider's own wire field (e.g. LM Studio's
 *                        /v1/chat/completions { "reasoning_effort": … })
 *
 * The variant table comes from one of two places depending on the provider:
 *
 *   local endpoints   we declare it ourselves (variantsForModel below), because
 *                     an arbitrary OpenAI-compatible server is in no catalog.
 *   catalog providers the model publishes its own `variants` and the OpenCode
 *                     server hands them to us verbatim in GET /config/providers
 *                     — Anthropic low/medium/high/max, OpenAI medium/high/xhigh
 *                     (with provider-specific payloads like `thinking` budgets
 *                     that we must not try to synthesize). Those arrive with
 *                     `declared: true` and are offered exactly as published.
 *
 * Three findings shape the local half:
 *
 * 1. The variant option key MUST be camelCase `reasoningEffort`. That is the AI
 *    SDK provider-option name, which the openai-compatible provider renames to
 *    the wire field `reasoning_effort`. Declaring snake_case `reasoning_effort`
 *    is *silently dropped* — the request goes out with no effort field at all
 *    and the feature looks like it works while doing nothing. (Wrapping it in
 *    `options`/`providerOptions` is worse: those get serialized verbatim as
 *    junk top-level body keys.) OpenCode's own built-in gpt-oss variants use
 *    the camelCase form, which is the corroborating evidence.
 *
 * 2. Sending a variant name the model does not declare is a silent no-op (202,
 *    no effort field, no error). So we may send optimistically when a model's
 *    capabilities are unknown — the downside is nil.
 *
 * 3. On every LM Studio reasoning model available today except gpt-oss, the
 *    scale is *binary*: `none` yields zero reasoning tokens, and every other
 *    value produces byte-identical output. Offering low/medium/high on such a
 *    model would be a lie, so the visible levels are derived per model from
 *    `capabilities.reasoning.allowed_options` rather than hardcoded.
 */

/** What the user picks. `auto` = send nothing, let the model use its default. */
export type EffortLevel = 'auto' | 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** LM Studio's accepted `reasoning_effort` values (from the server's own 400 body). */
export type ApiEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

/**
 * A model's reasoning scale, normalized from whichever source described it.
 *
 * Two sources, distinguished by `declared`:
 *   - LM Studio's `/api/v1/models` `capabilities.reasoning` for local models,
 *     where `allowedOptions` describes granularity ("off"/"on" = binary) and
 *     the *variant table is ours* (see variantsForModel);
 *   - the model's own `variants` from the OpenCode catalog for cloud providers,
 *     where `allowedOptions` IS the exact set of variant names the model
 *     accepts (Anthropic low/medium/high/max, OpenAI medium/high/xhigh).
 *
 * Absent entirely on non-reasoning models; `undefined` also covers "we came in
 * via the /api/v0 fallback, which cannot report capabilities".
 */
export interface ReasoningCapability {
  allowedOptions: string[];
  default?: string;
  /**
   * True when `allowedOptions` are the model's own declared variant names, so
   * they must be offered verbatim rather than interpreted as granularity.
   */
  declared?: boolean;
}

/**
 * The variant table we declare for local models, in ascending order of effort.
 * Not the set of levels a *catalog* model can offer — those come from the model
 * itself and may include levels absent here (see EFFORT_ORDER).
 */
export const ALL_LEVELS: EffortLevel[] = ['auto', 'off', 'low', 'medium', 'high'];

/**
 * Every effort level any provider expresses, ascending, excluding `auto`.
 * `xhigh` (OpenAI) and `max` (Anthropic) are both "beyond high" in their
 * respective vocabularies; no model declares both, so their relative order is
 * arbitrary and only matters for clamping.
 */
export const EFFORT_ORDER: EffortLevel[] = ['off', 'low', 'medium', 'high', 'xhigh', 'max'];

/** Every value the effort setting / stored preference may legitimately hold. */
export const KNOWN_LEVELS: EffortLevel[] = ['auto', ...EFFORT_ORDER];

/**
 * The variant table we declare for every model in the OpenCode config. Declared
 * unconditionally and identically for all models, which is what lets the whole
 * feature avoid a server restart: the config never depends on user settings, so
 * changing effort is purely a per-message field.
 *
 * `off` maps to `none` (verified: zero reasoning tokens on both MLX and GGUF).
 * There is deliberately no `auto` entry — auto means "omit `variant`".
 */
export function variantsForModel(): Record<string, { reasoningEffort: ApiEffort }> {
  return {
    off: { reasoningEffort: 'none' },
    low: { reasoningEffort: 'low' },
    medium: { reasoningEffort: 'medium' },
    high: { reasoningEffort: 'high' },
  };
}

/**
 * Which levels to show for a model, derived from its declared capabilities.
 *
 * - no capability at all      -> [] (hide the control; the model cannot reason)
 * - unknown (undefined)       -> every level, shown optimistically
 * - binary ["off","on"]       -> auto/off/on, because low≡medium≡high on the wire
 * - granular ["low","medium","high"] -> auto/off + the declared levels
 */
export function levelsForModel(reasoning: ReasoningCapability | undefined | null): EffortLevel[] {
  if (reasoning === null) {
    return []; // explicitly reported as non-reasoning
  }
  if (!reasoning) {
    return [...ALL_LEVELS]; // unknown != unsupported — offer everything, sending is a safe no-op
  }
  const opts = (reasoning.allowedOptions ?? []).map((o) => o.toLowerCase());
  if (reasoning.declared) {
    // The model published its own variant names: offer exactly those, in effort
    // order, and nothing else. Inventing an `off` for a provider that declares
    // no such variant would be a control that silently does nothing — Anthropic
    // and OpenAI models simply cannot have reasoning switched off this way.
    const declared = EFFORT_ORDER.filter((l) => opts.includes(l));
    return declared.length ? ['auto', ...declared] : [];
  }
  if (opts.length === 0) {
    return [...ALL_LEVELS];
  }
  const granular = ALL_LEVELS.filter((l) => l !== 'auto' && l !== 'off' && opts.includes(l));
  if (granular.length > 0) {
    return ['auto', 'off', ...granular];
  }
  // Binary model: it can think or not, and that is the whole scale.
  return ['auto', 'off', 'high'];
}

/** True when a model collapses every "on" level to the same thing (so the UI says On, not High). */
export function isBinary(reasoning: ReasoningCapability | undefined | null): boolean {
  if (!reasoning || reasoning.declared) {
    return false; // a declared scale is never collapsed — it says what it offers
  }
  const opts = (reasoning.allowedOptions ?? []).map((o) => o.toLowerCase());
  return opts.length > 0 && !opts.some((o) => o === 'low' || o === 'medium' || o === 'high');
}

/** Label for a level, given the model's shape. Binary models say On rather than High. */
export function levelLabel(level: EffortLevel, reasoning?: ReasoningCapability | null): string {
  if (level === 'high' && isBinary(reasoning)) {
    return 'On';
  }
  switch (level) {
    case 'auto':
      return 'Auto';
    case 'off':
      return 'Off';
    case 'low':
      return 'Low';
    case 'medium':
      return 'Med';
    case 'high':
      return 'High';
    case 'xhigh':
      return 'X-High';
    case 'max':
      return 'Max';
  }
}

/**
 * The `variant` to put on the prompt body, or `undefined` to omit the field.
 * `auto` omits; everything else names one of the variants we declared.
 */
export function variantForLevel(level: EffortLevel): string | undefined {
  return level === 'auto' ? undefined : level;
}

/**
 * Clamp a stored/requested level to what the model actually offers, so a level
 * carried over from a previous model can never be sent to one that lacks it.
 * Falls back to the nearest supported level at or below the request, then to
 * `auto`.
 */
export function resolveLevel(
  requested: EffortLevel | undefined,
  reasoning: ReasoningCapability | undefined | null,
): EffortLevel {
  const available = levelsForModel(reasoning);
  if (available.length === 0) {
    return 'auto'; // non-reasoning model: nothing to send
  }
  if (requested && available.includes(requested)) {
    return requested;
  }
  if (!requested) {
    return 'auto';
  }
  // Degrade downward to the highest supported level ≤ requested (mirrors how
  // Anthropic silently downgrades an unsupported effort), never upward.
  const want = EFFORT_ORDER.indexOf(requested);
  if (want >= 0) {
    for (let i = want; i >= 0; i--) {
      if (available.includes(EFFORT_ORDER[i])) {
        return EFFORT_ORDER[i];
      }
    }
    // Nothing at or below the request (e.g. "off" against a model whose lowest
    // declared variant is "medium") — take the model's own floor rather than
    // dropping to auto, which would silently mean "the model's default", a
    // *higher* effort than the user asked for.
    const floor = EFFORT_ORDER.find((l) => available.includes(l));
    if (floor) {
      return floor;
    }
  }
  return 'auto';
}

/**
 * Prompt-text fallback for models that declare no reasoning capability at all.
 * This is the `ultrathink` pattern — a text nudge, not a parameter — and it is
 * the *only* lever left when a model has no variant support. Returns '' when
 * the parameter path is available, so we never do both.
 */
export function fallbackPromptText(
  level: EffortLevel,
  reasoning: ReasoningCapability | undefined | null,
): string {
  if (reasoning) {
    return ''; // the parameter path works; do not also nudge with text
  }
  if (level === 'off') {
    return 'Answer directly and concisely. Do not produce private chain-of-thought or <think> reasoning blocks.';
  }
  if (level === 'high') {
    return 'Think carefully and thoroughly before answering. Work through the problem step by step.';
  }
  return '';
}

/**
 * Context-window math shared by the bridge (server-side clamping), the OpenCode
 * server config, and the webview (presets + meter). Pure so it is unit-testable
 * and browser-safe.
 */
import type { ConnectionKind } from './providers';

/**
 * Clamp a requested context window to a model's real maximum, so we never ask
 * LM Studio to load — or tell OpenCode to assume — more context than the model
 * actually supports. Falls back gracefully when either value is missing.
 */
export function clampContext(requested: number, modelMax?: number): number {
  const req = Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : 0;
  const cap = modelMax && Number.isFinite(modelMax) && modelMax > 0 ? Math.floor(modelMax) : 0;
  if (!req) {
    return cap;
  }
  if (!cap) {
    return req;
  }
  return Math.max(1, Math.min(req, cap));
}

/** A positive, finite integer, or undefined. Anything else is "not reported". */
function positive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

/**
 * The context window advertised by one OpenAI-compatible `/v1/models` row.
 *
 * Every local runtime spells it differently and none of them agree: vLLM
 * writes `max_model_len`, oMLX `max_context_length`, and llama.cpp publishes
 * neither — it nests the window under `meta.n_ctx`. Missing all three the
 * caller gets undefined, which downstream reads as "unknown" rather than
 * filling the hole with a setting default and calling it a detected capability.
 *
 * `meta.n_ctx_train` is deliberately not consulted: that is the checkpoint's
 * ceiling, routinely far above the window the server was actually started with.
 *
 * `meta.n_ctx` is the window this llama.cpp *process* holds, and `--parallel N`
 * divides it across N slots — so a caller that has read the per-slot window
 * from `/props` passes it as `slotContext` and it wins, capped by the process
 * window so a stale or odd `/props` can never inflate the budget.
 */
export function contextFromModelRow(
  row: Record<string, any> | undefined,
  slotContext?: number,
): number | undefined {
  const direct = positive(row?.max_model_len) ?? positive(row?.max_context_length);
  if (direct) {
    return direct;
  }
  const processWindow = positive(row?.meta?.n_ctx);
  if (!processWindow) {
    return undefined;
  }
  const slot = positive(slotContext);
  return slot ? Math.min(slot, processWindow) : processWindow;
}

/**
 * The window to declare to OpenCode as `limit.context` for one local model.
 *
 * On a server with a load lifecycle (LM Studio) the window is genuinely ours:
 * we ask for `requested` when the model loads, capped by what the model
 * supports. Every other local runtime was started with its window already
 * fixed — llama.cpp's `--ctx-size`, vLLM's `--max-model-len`, oMLX's
 * configured window — and when such a server reports that number it *is* the
 * budget. Clamping it down to `minContextLength` there would make OpenCode
 * compact against 32K on a 256K window and throw away context the GPU is
 * already holding. The setting still applies when the server reports nothing,
 * because then it is the only estimate anyone has.
 */
export function declaredContext(
  requested: number,
  modelMax: number | undefined,
  lifecycle: boolean,
): number {
  const max = positive(modelMax);
  if (!lifecycle && max) {
    return max;
  }
  return clampContext(requested, modelMax);
}

const BASE_PRESETS = [8192, 16384, 32768, 65536, 131072, 262144];

/**
 * Context-window presets to offer in the picker, filtered to the model's max
 * (and always including the exact max). Sorted ascending, de-duplicated. When
 * the max is unknown we assume a generous 128K so the picker still works.
 */
export function contextPresets(modelMax?: number): number[] {
  const max = modelMax && Number.isFinite(modelMax) && modelMax > 0 ? Math.floor(modelMax) : 131072;
  const set = new Set(BASE_PRESETS.filter((v) => v <= max));
  set.add(max);
  return [...set].sort((a, b) => a - b);
}

/** 1024-base token formatting: 32768 -> "32K", 131072 -> "128K", 1.5M -> "1.5M". */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) {
    return '0';
  }
  if (n >= 1024 * 1024) {
    return (n / (1024 * 1024)).toFixed(1).replace(/\.0$/, '') + 'M';
  }
  if (n >= 1024) {
    return Math.round(n / 1024) + 'K';
  }
  return String(Math.round(n));
}

export interface WindowModel {
  /** The loaded context window, when the model is currently loaded. */
  contextLength?: number;
  /** The model's own maximum context window. */
  maxContextLength?: number;
  /** Which kind of connection serves it — decides who owns the window. */
  providerKind?: ConnectionKind;
  /** True when the serving process fixed the window at launch. */
  windowFixed?: boolean;
}

/**
 * Whether the context window is ours to choose, or already decided for us.
 *
 * Only local endpoints: `minContextLength` reaches a model exclusively through
 * the declaration we build for a local provider (serverManager.localModelsFor,
 * which sets `limit.context`/`limit.output`) and through LM Studio's load
 * lifecycle. A builtin/catalog model runs whatever window its provider
 * publishes — nothing we set is ever sent — so the setting is inert there, and
 * an unknown kind is treated the same way rather than pretending we control it.
 *
 * `windowFixed` carves out the local servers that are equally out of our hands:
 * a llama.cpp/vLLM/oMLX process was started with `--ctx-size` (or its
 * equivalent) and will not renegotiate, so when it reports that window the
 * honest answer is the same as for a cloud model — this is the number, and the
 * setting cannot move it. A local endpoint that reports *nothing* stays
 * managed: the setting is then the only window anyone has named.
 */
export function isWindowManaged(model?: {
  providerKind?: ConnectionKind;
  windowFixed?: boolean;
}): boolean {
  return model?.providerKind === 'local' && !model.windowFixed;
}

/**
 * The context window to display in the meter: the loaded window if the model is
 * loaded, otherwise the window we would load it at — min(configured, model max)
 * — so it tracks the selected model rather than a single hard-coded number.
 *
 * For a model whose window is not ours the configured minimum is not part of
 * that math: measuring a 195K cloud model — or a llama.cpp server started at
 * 256K — against a 32K setting we never send would report the bar as full
 * eight times too early.
 */
export function computeWindow(model: WindowModel | undefined, minContext: number): number {
  const min = Number.isFinite(minContext) && minContext > 0 ? minContext : 0;
  if (!model) {
    return min;
  }
  if (model.contextLength && model.contextLength > 0) {
    return model.contextLength;
  }
  if (model.maxContextLength && model.maxContextLength > 0) {
    return isWindowManaged(model)
      ? Math.min(min || model.maxContextLength, model.maxContextLength)
      : model.maxContextLength;
  }
  return min;
}

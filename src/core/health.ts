/**
 * The self-healing policy, expressed as a pure decision function so the timing
 * loop in the bridge stays a thin shell and the reliability rules are covered
 * by unit tests.
 *
 * Two failure modes drive everything:
 *   1. No provider can serve a model (show the offline banner, wait for one).
 *   2. A provider is available but the OpenCode server died / we lost our
 *      client (silently restart + reconnect, with backoff so we don't hammer
 *      it).
 *
 * A third state sits between them: a probe *timed out*. A saturated server
 * (mid-generation) answers slowly but isn't gone, so timeouts only flip us
 * offline after a consecutive streak — one slow probe must never pop the
 * offline banner during a long generation (issue #7).
 */

/** Result of one reachability probe against a local endpoint. */
export type ProbeStatus = 'ok' | 'auth-required' | 'timeout' | 'unreachable';

export interface UpstreamInputs {
  /** One probe result per enabled local endpoint (empty when there are none). */
  probes: ProbeStatus[];
  /** Enabled catalog providers that have a key stored. */
  keyedProviders: number;
  /** Whether the builtin zero-config provider is enabled. */
  builtinEnabled: boolean;
}

/**
 * Collapse every provider's state into the single upstream verdict the health
 * loop reasons about.
 *
 * The asymmetry here is deliberate. A cloud provider with a key stored, and the
 * builtin, are *always* considered available: they are reached through the
 * OpenCode server, and probing them would mean spending the user's money (or
 * their rate limit) on a liveness check every 30 seconds. Their failures
 * surface where they belong — on the request that fails, with the provider's
 * own error message.
 *
 * So the offline banner means "nothing at all can serve a model", not "one of
 * your servers is down". A dead LM Studio while an Anthropic key is configured
 * is not an offline state; the picker marks that one endpoint offline and the
 * chat keeps working. With nothing but local endpoints, this reduces exactly to
 * the old single-server behavior.
 */
export function aggregateUpstream(i: UpstreamInputs): ProbeStatus {
  if (i.builtinEnabled || i.keyedProviders > 0) {
    return 'ok';
  }
  if (!i.probes.length) {
    return 'unreachable'; // nothing configured at all
  }
  if (i.probes.includes('ok')) {
    return 'ok';
  }
  // Nothing is serving. Report the most actionable reason: a rejected key is a
  // fixable mistake, a timeout may just be a busy server, and unreachable is
  // the catch-all.
  if (i.probes.includes('auth-required')) {
    return 'auth-required';
  }
  return i.probes.includes('timeout') ? 'timeout' : 'unreachable';
}

export interface HealthInputs {
  /** The aggregate upstream verdict this tick (see aggregateUpstream). */
  upstream: ProbeStatus;
  /** Consecutive 'timeout' probes, including this one when it timed out. */
  timeoutStreak: number;
  /** Timeouts tolerated while connected before we believe the server is gone. */
  offlineAfterTimeouts: number;
  /** Whether the bridge currently considers a provider available. */
  connected: boolean;
  /** OpenCode server process alive AND we hold a client for it. */
  serverHealthy: boolean;
  /** Current time (ms). */
  now: number;
  /** Earliest time we are allowed to attempt another reconnect (backoff gate). */
  nextReconnectAt: number;
  /** Poll tick counter (incremented every poll). */
  tick: number;
  /** Refresh the model list every N ticks while healthy (0 disables). */
  refreshEvery: number;
}

export type HealthAction = 'none' | 'go-offline' | 'reconnect' | 'refresh-models';

/**
 * Decide what the health poll should do this tick.
 *
 * - probe timed out              -> go-offline only after a consecutive streak
 *                                   (a busy server is not a dead server);
 *                                   never pile more requests on it meanwhile
 * - hard-down + we were online   -> go-offline (show banner)
 * - hard-down + already offline  -> none (keep waiting)
 * - up + not connected / dead    -> reconnect (once backoff allows)
 * - up + healthy, refresh tick   -> refresh-models
 * - otherwise                    -> none
 */
export function decideHealthAction(i: HealthInputs): HealthAction {
  if (i.upstream === 'timeout') {
    return i.connected && i.timeoutStreak >= i.offlineAfterTimeouts ? 'go-offline' : 'none';
  }
  if (i.upstream !== 'ok') {
    // 'unreachable' (connection refused — the server really is gone) and
    // 'auth-required' (it answered but rejected us) both flip immediately.
    return i.connected ? 'go-offline' : 'none';
  }
  // Something upstream can serve a model.
  if (!i.connected || !i.serverHealthy) {
    return i.now >= i.nextReconnectAt ? 'reconnect' : 'none';
  }
  if (i.refreshEvery > 0 && i.tick > 0 && i.tick % i.refreshEvery === 0) {
    return 'refresh-models';
  }
  return 'none';
}

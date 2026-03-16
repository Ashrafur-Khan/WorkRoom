import type { RunningSessionState, SessionState } from '../types';

/**
 * Checks if a session is currently running AND valid (time hasn't expired).
 * Returns 'active' if running, 'expired' if it just finished, or 'idle'.
 */
export function getSessionStatus(state: SessionState): 'active' | 'expired' | 'idle' {
  if (!state.isRunning) return 'idle';

  const now = Date.now();
  const endTime = state.startTime + (state.durationMinutes * 60 * 1000);

  if (now >= endTime) {
    return 'expired';
  }

  return 'active';
}

/**
 * Helper to construct the "End Session" state object consistently
 */
export function createIdleState(): SessionState {
  return { isRunning: false };
}

export function createRunningState(goal: string, durationMinutes: number, startTime = Date.now()): RunningSessionState {
  return {
    allowedDomains: [],
    durationMinutes,
    goal,
    isRunning: true,
    snoozedDomains: {},
    startTime,
  };
}

export function getDomainFromUrl(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function normalizeSessionState(state: SessionState | undefined): {
  changed: boolean;
  state: SessionState;
} {
  if (!state || !state.isRunning) {
    return {
      changed: state !== undefined && state.isRunning !== false,
      state: createIdleState(),
    };
  }

  const allowedDomainsRaw = (state as Partial<RunningSessionState>).allowedDomains;
  const allowedDomains = Array.isArray(allowedDomainsRaw)
    ? allowedDomainsRaw.filter((domain): domain is string => typeof domain === 'string')
    : [];
  const snoozedDomainsRaw = (state as Partial<RunningSessionState>).snoozedDomains;
  const snoozedDomainsEntries = Object.entries(
    snoozedDomainsRaw && typeof snoozedDomainsRaw === 'object' ? snoozedDomainsRaw : {},
  ).filter((entry): entry is [string, number] => typeof entry[0] === 'string' && typeof entry[1] === 'number');
  const snoozedDomains = Object.fromEntries(snoozedDomainsEntries);
  const normalizedState: RunningSessionState = {
    allowedDomains,
    durationMinutes: state.durationMinutes,
    goal: state.goal,
    isRunning: true,
    snoozedDomains,
    startTime: state.startTime,
  };

  const changed =
    allowedDomains.length !== ((state as Partial<RunningSessionState>).allowedDomains?.length ?? 0) ||
    snoozedDomainsEntries.length !== Object.keys(snoozedDomains).length;

  return {
    changed,
    state: normalizedState,
  };
}

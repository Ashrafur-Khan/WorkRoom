import type { SessionState } from '../types';

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
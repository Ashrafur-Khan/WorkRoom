// src/types.ts
export type Classification = 'on-task' | 'off-task' | 'ambiguous';

export type RunningSessionState = {
  allowedDomains: string[];
  durationMinutes: number;
  goal: string;
  isRunning: true;
  snoozedDomains: Record<string, number>;
  startTime: number;
};

export type SessionState =
  | { isRunning: false }
  | RunningSessionState;

export type DebugLogEntry = {
  backend?: string;
  cacheHit?: boolean;
  error?: string;
  metadata?: Record<string, string | number | boolean | null>;
  requestId?: string;
  score?: number | null;
  source: 'bg' | 'offscreen';
  status: string;
  tabId?: number;
  timestamp: number;
};

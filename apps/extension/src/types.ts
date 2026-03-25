// src/types.ts
export type Classification = 'on-task' | 'off-task' | 'ambiguous';

export type PageSignalCounts = {
  appMarkers: number;
  headings: number;
  mainTextLength: number;
  navLabels: number;
  pathnameTokens: number;
};

export type PageSignals = {
  appMarkers: string[];
  durationMs: number;
  extractedAt: number;
  headings: string[];
  mainTextSnippet: string;
  metaDescription: string;
  navLabels: string[];
  pathnameTokens: string[];
  signalCounts: PageSignalCounts;
  title: string;
};

export type ExtractPageSignalsResponse =
  | {
      ok: true;
      signals: PageSignals;
    }
  | {
      ok: false;
      reason: string;
    };

export type SignalSnapshot = Pick<
  PageSignals,
  'appMarkers' | 'headings' | 'mainTextSnippet' | 'metaDescription' | 'navLabels' | 'pathnameTokens' | 'title'
>;

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
  signalSnapshot?: SignalSnapshot;
  requestId?: string;
  score?: number | null;
  source: 'bg' | 'offscreen';
  status: string;
  tabId?: number;
  timestamp: number;
};

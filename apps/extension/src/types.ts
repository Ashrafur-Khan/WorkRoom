// src/types.ts
export type Classification = 'on-task' | 'off-task' | 'ambiguous';

export type PageSignalCounts = {
  headings: number;
  mainSnippetCount: number;
  mainTextLength: number;
  pageMarkers: number;
  pathnameTokens: number;
  sectionHints: number;
  structuredTypes: number;
};

export type PageSignals = {
  durationMs: number;
  extractedAt: number;
  headings: string[];
  mainTextSnippets: string[];
  metaDescription: string;
  pageMarkers: string[];
  pathnameTokens: string[];
  sectionHints: string[];
  signalCounts: PageSignalCounts;
  structuredTypes: string[];
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
  'headings' | 'mainTextSnippets' | 'metaDescription' | 'pageMarkers' | 'pathnameTokens' | 'sectionHints' | 'structuredTypes' | 'title'
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

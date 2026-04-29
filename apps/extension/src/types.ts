export type Classification = 'on-task' | 'off-task' | 'ambiguous';

export type DebugMetadataValue = string | number | boolean | null;

export type DebugMetadata = Record<string, DebugMetadataValue>;

type PageSignalCounts = {
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

export type ClassificationRequestContext = {
  pageSignals?: PageSignals;
  requestId: string;
  tabId?: number;
};

export type MlClassifyRequest = ClassificationRequestContext & {
  goal: string;
  title: string;
  url: string;
};

export type MlClassifyResponse =
  | {
      backend: string;
      cacheHit: boolean;
      classification: Classification;
      modelState: 'ready';
      score: number;
    }
  | {
      backend: string;
      cacheHit: false;
      error: string;
      modelState: 'fallback';
      score: null;
    };

export type DebugLogEntry = {
  backend?: string;
  cacheHit?: boolean;
  error?: string;
  metadata?: DebugMetadata;
  signalSnapshot?: SignalSnapshot;
  requestId?: string;
  score?: number | null;
  source: 'bg' | 'offscreen';
  status: string;
  tabId?: number;
  timestamp: number;
};

export type StartSessionMessage = { type: 'START_SESSION' };

export type StopSessionMessage = { type: 'STOP_SESSION' };

export type AllowDomainForSessionMessage = { type: 'ALLOW_DOMAIN_FOR_SESSION' };

export type SnoozeDomainMessage = {
  payload: {
    durationMinutes: number;
  };
  type: 'SNOOZE_DOMAIN';
};

export type GetDebugLogsMessage = { type: 'GET_DEBUG_LOGS' };

export type MlDebugEventMessage = {
  payload: DebugLogEntry;
  type: 'ML_DEBUG_EVENT';
};

export type MlClassifyRequestMessage = MlClassifyRequest & {
  type: 'ML_CLASSIFY_REQUEST';
};

export type MlOffscreenCloseMessage = {
  type: 'ML_OFFSCREEN_CLOSE';
};

export type ExtractPageSignalsMessage = {
  type: 'EXTRACT_PAGE_SIGNALS';
};

export type BlockPageMessage = {
  payload: {
    goal: string;
  };
  type: 'BLOCK_PAGE';
};

export type UnblockPageMessage = {
  type: 'UNBLOCK_PAGE';
};

export type SessionCompleteMessage = {
  payload: {
    message: string;
  };
  type: 'SESSION_COMPLETE';
};

export type RuntimeMessage =
  | AllowDomainForSessionMessage
  | BlockPageMessage
  | ExtractPageSignalsMessage
  | GetDebugLogsMessage
  | MlClassifyRequestMessage
  | MlDebugEventMessage
  | MlOffscreenCloseMessage
  | SessionCompleteMessage
  | SnoozeDomainMessage
  | StartSessionMessage
  | StopSessionMessage
  | UnblockPageMessage;

export type RuntimeMessageOfType<T extends RuntimeMessage['type']> = Extract<RuntimeMessage, { type: T }>;

export type SessionMutationResponse =
  | {
      ok: false;
    }
  | {
      metadata?: DebugMetadata;
      ok: true;
    };

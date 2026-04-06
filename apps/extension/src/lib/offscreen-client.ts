import type { Classification, DebugLogEntry, PageSignals } from '../types';
import type { MlClassifyRequest, MlClassifyResponse } from './model-manager';

const OFFSCREEN_DOCUMENT_PATH = 'src/offscreen/offscreen.html';
const OFFSCREEN_JUSTIFICATION =
  'Run ONNX Runtime sentence-embedding inference in a DOM-capable extension page instead of the background service worker.';

type OffscreenClientTestOverrides = {
  closeDocument?: () => Promise<void>;
  createDocument?: () => Promise<void>;
  hasOffscreenDocument?: () => Promise<boolean>;
  sendRuntimeMessage?: (message: unknown) => Promise<unknown>;
};

// Offscreen lifecycle operations are serialized so classification traffic cannot
// race document creation against teardown during rapid session changes.
let offscreenLifecyclePromise: Promise<void> = Promise.resolve();
let testOverrides: OffscreenClientTestOverrides = {};

export type ClassificationContext = {
  goal: string;
  pageSignals?: PageSignals;
  requestId: string;
  tabId?: number;
  title: string;
  url: string;
};

export type MlClassificationResult =
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

function isMlClassificationResult(value: unknown): value is MlClassificationResult {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  if (typeof candidate.backend !== 'string' || typeof candidate.cacheHit !== 'boolean') {
    return false;
  }

  if (candidate.modelState === 'ready') {
    return (
      typeof candidate.classification === 'string' &&
      typeof candidate.score === 'number'
    );
  }

  if (candidate.modelState === 'fallback') {
    return (
      typeof candidate.error === 'string' &&
      candidate.cacheHit === false &&
      candidate.score === null
    );
  }

  return false;
}

function log(event: string, metadata: Record<string, unknown> = {}): void {
  console.log('[WorkRoom:bg]', event, metadata);
}

function createDebugEntry(
  status: string,
  partial: Omit<DebugLogEntry, 'source' | 'status' | 'timestamp'> = {},
): DebugLogEntry {
  return {
    ...partial,
    source: 'bg',
    status,
    timestamp: Date.now(),
  };
}

async function hasOffscreenDocument(): Promise<boolean> {
  if (testOverrides.hasOffscreenDocument) {
    return testOverrides.hasOffscreenDocument();
  }

  if (!('offscreen' in chrome)) {
    return false;
  }

  const getContexts = chrome.runtime.getContexts as unknown as (
    options: Record<string, unknown>,
  ) => Promise<Array<Record<string, unknown>>>;

  const contexts = await getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH)],
  });

  return contexts.length > 0;
}

async function createOffscreenDocument(): Promise<void> {
  if (testOverrides.createDocument) {
    await testOverrides.createDocument();
    return;
  }

  await chrome.offscreen.createDocument({
    justification: OFFSCREEN_JUSTIFICATION,
    reasons: [chrome.offscreen.Reason.WORKERS],
    url: OFFSCREEN_DOCUMENT_PATH,
  });
}

async function closeChromeOffscreenDocument(): Promise<void> {
  if (testOverrides.closeDocument) {
    await testOverrides.closeDocument();
    return;
  }

  await chrome.offscreen.closeDocument();
}

async function sendRuntimeMessage(message: unknown): Promise<unknown> {
  if (testOverrides.sendRuntimeMessage) {
    return testOverrides.sendRuntimeMessage(message);
  }

  return chrome.runtime.sendMessage(message);
}

function queueOffscreenLifecycle<T>(operation: () => Promise<T>): Promise<T> {
  const nextOperation = offscreenLifecyclePromise.then(operation, operation);
  offscreenLifecyclePromise = nextOperation.then(
    () => undefined,
    () => undefined,
  );
  return nextOperation;
}

export async function ensureOffscreenDocument(
  appendDebugLog: (entry: DebugLogEntry) => Promise<void> | void,
): Promise<void> {
  await queueOffscreenLifecycle(async () => {
    if (await hasOffscreenDocument()) {
      await appendDebugLog(createDebugEntry('offscreen-reused'));
      log('offscreen-reused');
      return;
    }

    await createOffscreenDocument();
    await appendDebugLog(createDebugEntry('offscreen-created'));
    log('offscreen-created');
  });
}

export async function closeOffscreenDocument(
  appendDebugLog: (entry: DebugLogEntry) => Promise<void> | void,
): Promise<void> {
  await queueOffscreenLifecycle(async () => {
    if (!(await hasOffscreenDocument())) {
      await appendDebugLog(createDebugEntry('offscreen-close-skipped'));
      log('offscreen-close-skipped');
      return;
    }

    try {
      await sendRuntimeMessage({ type: 'ML_OFFSCREEN_CLOSE' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await appendDebugLog(
        createDebugEntry('offscreen-close-message-failed', {
          error: message,
        }),
      );
      log('offscreen-close-message-failed', { error: message });
    }

    await closeChromeOffscreenDocument();
    await appendDebugLog(createDebugEntry('offscreen-closed'));
    log('offscreen-closed');
  });
}

export async function requestMlClassification(
  context: ClassificationContext,
  appendDebugLog: (entry: DebugLogEntry) => Promise<void> | void,
): Promise<MlClassificationResult> {
  // The background keeps consuming a `ready` vs `fallback` ML contract even
  // though the underlying runtime has changed from TF.js to ONNX Runtime WASM.
  await ensureOffscreenDocument(appendDebugLog);
  const startedAt = Date.now();

  const message: MlClassifyRequest & { type: 'ML_CLASSIFY_REQUEST' } = {
    goal: context.goal,
    pageSignals: context.pageSignals,
    requestId: context.requestId,
    title: context.title,
    type: 'ML_CLASSIFY_REQUEST',
    url: context.url,
  };

  let rawResponse: unknown;

  try {
    rawResponse = await sendRuntimeMessage(message);
  } catch (error) {
    const failure = error instanceof Error ? error.message : String(error);
    await appendDebugLog(
      createDebugEntry('offscreen-request-failed', {
        error: failure,
        requestId: context.requestId,
        tabId: context.tabId,
      }),
    );
    log('offscreen-request-failed', {
      error: failure,
      requestId: context.requestId,
      tabId: context.tabId,
    });
    throw error;
  }

  if (!isMlClassificationResult(rawResponse)) {
    const responseError = rawResponse === undefined
      ? 'Offscreen document returned no response.'
      : 'Offscreen document returned an invalid ML response.';
    await appendDebugLog(
      createDebugEntry('offscreen-response-invalid', {
        error: responseError,
        metadata: {
          hasResponse: rawResponse !== undefined,
        },
        requestId: context.requestId,
        tabId: context.tabId,
      }),
    );
    log('offscreen-response-invalid', {
      hasResponse: rawResponse !== undefined,
      requestId: context.requestId,
      tabId: context.tabId,
    });
    throw new Error(responseError);
  }

  const response = rawResponse as MlClassifyResponse;
  const classification = response.modelState === 'ready' ? response.classification : undefined;
  const error = response.modelState === 'fallback' ? response.error : undefined;

  await appendDebugLog(
    createDebugEntry('classification-complete', {
      backend: response.backend,
      cacheHit: response.cacheHit,
      metadata: {
        classification: classification ?? 'fallback',
        classificationRequestDurationMs: Date.now() - startedAt,
        modelState: response.modelState,
        usedPageSignals: Boolean(context.pageSignals),
      },
      error,
      requestId: context.requestId,
      score: response.score,
      tabId: context.tabId,
    }),
  );

  log('classification-complete', {
    backend: response.backend,
    cacheHit: response.cacheHit,
    classification,
    error,
    modelState: response.modelState,
    requestId: context.requestId,
    score: response.score,
    tabId: context.tabId,
  });

  return response;
}

export function configureOffscreenClientForTesting(overrides: OffscreenClientTestOverrides): void {
  testOverrides = overrides;
}

export function resetOffscreenClientForTesting(): void {
  offscreenLifecyclePromise = Promise.resolve();
  testOverrides = {};
}

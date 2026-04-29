import type {
  DebugLogEntry,
  MlClassifyRequest,
  MlClassifyRequestMessage,
  MlClassifyResponse,
  MlOffscreenCloseMessage,
} from '../types';

const OFFSCREEN_DOCUMENT_PATH = 'src/offscreen/offscreen.html';
const OFFSCREEN_JUSTIFICATION =
  'Run ONNX Runtime sentence-embedding inference in a DOM-capable extension page instead of the background service worker.';

type OffscreenLifecycleMessage = MlClassifyRequestMessage | MlOffscreenCloseMessage;

type OffscreenClientTestOverrides = {
  closeDocument?: () => Promise<void>;
  createDocument?: () => Promise<void>;
  hasOffscreenDocument?: () => Promise<boolean>;
  sendRuntimeMessage?: (message: OffscreenLifecycleMessage) => Promise<unknown>;
};

let offscreenLifecyclePromise: Promise<void> = Promise.resolve();
let testOverrides: OffscreenClientTestOverrides = {};

function isMlClassificationResponse(value: unknown): value is MlClassifyResponse {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<MlClassifyResponse>;
  if (typeof candidate.backend !== 'string' || typeof candidate.cacheHit !== 'boolean') {
    return false;
  }

  if (candidate.modelState === 'ready') {
    return typeof candidate.classification === 'string' && typeof candidate.score === 'number';
  }

  if (candidate.modelState === 'fallback') {
    return typeof candidate.error === 'string' && candidate.cacheHit === false && candidate.score === null;
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

  if (!('offscreen' in chrome) || typeof chrome.runtime.getContexts !== 'function') {
    return false;
  }

  const contexts = await (chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH)],
  }) as Promise<chrome.runtime.ExtensionContext[]>);

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

async function sendRuntimeMessage(message: OffscreenLifecycleMessage): Promise<unknown> {
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
  context: MlClassifyRequest,
  appendDebugLog: (entry: DebugLogEntry) => Promise<void> | void,
): Promise<MlClassifyResponse> {
  await ensureOffscreenDocument(appendDebugLog);
  const startedAt = Date.now();

  const message: MlClassifyRequestMessage = {
    ...context,
    type: 'ML_CLASSIFY_REQUEST',
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

  if (!isMlClassificationResponse(rawResponse)) {
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

  const classification = rawResponse.modelState === 'ready' ? rawResponse.classification : undefined;
  const error = rawResponse.modelState === 'fallback' ? rawResponse.error : undefined;

  await appendDebugLog(
    createDebugEntry('classification-complete', {
      backend: rawResponse.backend,
      cacheHit: rawResponse.cacheHit,
      metadata: {
        classification: classification ?? 'fallback',
        classificationRequestDurationMs: Date.now() - startedAt,
        modelState: rawResponse.modelState,
        usedPageSignals: Boolean(context.pageSignals),
      },
      error,
      requestId: context.requestId,
      score: rawResponse.score,
      tabId: context.tabId,
    }),
  );

  log('classification-complete', {
    backend: rawResponse.backend,
    cacheHit: rawResponse.cacheHit,
    classification,
    error,
    modelState: rawResponse.modelState,
    requestId: context.requestId,
    score: rawResponse.score,
    tabId: context.tabId,
  });

  return rawResponse;
}

export function configureOffscreenClientForTesting(overrides: OffscreenClientTestOverrides): void {
  testOverrides = overrides;
}

export function resetOffscreenClientForTesting(): void {
  offscreenLifecyclePromise = Promise.resolve();
  testOverrides = {};
}

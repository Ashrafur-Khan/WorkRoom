import type { Classification, DebugLogEntry } from '../types';
import type { MlClassifyRequest, MlClassifyResponse } from './model-manager';
import { buildPageContext } from './ml-helpers';

const OFFSCREEN_DOCUMENT_PATH = 'src/offscreen/offscreen.html';
const OFFSCREEN_JUSTIFICATION =
  'Run TensorFlow.js Universal Sentence Encoder inference in a DOM-capable extension page instead of the background service worker.';

let createDocumentPromise: Promise<void> | null = null;

export type ClassificationContext = {
  goal: string;
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

export async function ensureOffscreenDocument(
  appendDebugLog: (entry: DebugLogEntry) => Promise<void> | void,
): Promise<void> {
  if (await hasOffscreenDocument()) {
    return;
  }

  if (!createDocumentPromise) {
    createDocumentPromise = (async () => {
      await chrome.offscreen.createDocument({
        justification: OFFSCREEN_JUSTIFICATION,
        reasons: [chrome.offscreen.Reason.WORKERS],
        url: OFFSCREEN_DOCUMENT_PATH,
      });

      await appendDebugLog(createDebugEntry('offscreen-created'));
      log('offscreen-created');
    })().finally(() => {
      createDocumentPromise = null;
    });
  }

  await createDocumentPromise;
}

export async function closeOffscreenDocument(
  appendDebugLog: (entry: DebugLogEntry) => Promise<void> | void,
): Promise<void> {
  if (!(await hasOffscreenDocument())) {
    return;
  }

  await chrome.runtime.sendMessage({ type: 'ML_OFFSCREEN_CLOSE' });
  await chrome.offscreen.closeDocument();
  await appendDebugLog(createDebugEntry('offscreen-closed'));
  log('offscreen-closed');
}

export async function requestMlClassification(
  context: ClassificationContext,
  appendDebugLog: (entry: DebugLogEntry) => Promise<void> | void,
): Promise<MlClassificationResult> {
  await ensureOffscreenDocument(appendDebugLog);

  const message: MlClassifyRequest & { type: 'ML_CLASSIFY_REQUEST'; pageContext: string } = {
    goal: context.goal,
    pageContext: buildPageContext(context.url, context.title),
    requestId: context.requestId,
    title: context.title,
    type: 'ML_CLASSIFY_REQUEST',
    url: context.url,
  };

  const response = (await chrome.runtime.sendMessage(message)) as MlClassifyResponse | undefined;

  if (!response) {
    throw new Error('Offscreen document returned no response.');
  }

  const classification = response.modelState === 'ready' ? response.classification : undefined;
  const error = response.modelState === 'fallback' ? response.error : undefined;

  await appendDebugLog(
    createDebugEntry('classification-complete', {
      backend: response.backend,
      cacheHit: response.cacheHit,
      metadata: {
        classification: classification ?? 'fallback',
        modelState: response.modelState,
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

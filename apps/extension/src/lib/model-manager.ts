import * as use from '@tensorflow-models/universal-sentence-encoder';
import * as tf from '@tensorflow/tfjs';
import '@tensorflow/tfjs-backend-cpu';
import '@tensorflow/tfjs-backend-webgl';

import type { Classification } from '../types';
import { buildPageContext, classifyCosineScore, cosineSimilarity, normalizeText } from './ml-helpers';

const MODEL_DIRECTORY = 'assets/models/use';
const MODEL_URL = `${MODEL_DIRECTORY}/model.json`;
const VOCAB_URL = `${MODEL_DIRECTORY}/vocab.json`;

const BACKEND_PRIORITY = ['webgl', 'cpu'] as const;
type SupportedBackend = (typeof BACKEND_PRIORITY)[number];
type BackendDowngrade = {
  from: SupportedBackend;
  reason: string;
};
type ModelManagerTestOverrides = {
  getBackend?: () => string;
  loadModel?: typeof use.load;
  ready?: typeof tf.ready;
  setBackend?: typeof tf.setBackend;
  verifyAssetExists?: typeof verifyAssetExists;
};

export type MlClassifyRequest = {
  goal: string;
  requestId: string;
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

export type MlDebugEventStatus =
  | 'cache-hit'
  | 'cache-miss'
  | 'classification-complete'
  | 'classification-fallback'
  | 'model-loading'
  | 'model-ready'
  | 'offscreen-closed'
  | 'offscreen-created';

export type MlDebugEvent = {
  backend?: string;
  cacheHit?: boolean;
  error?: string;
  metadata?: Record<string, string | number | boolean | null>;
  requestId?: string;
  score?: number | null;
  source: 'bg' | 'offscreen';
  status: MlDebugEventStatus;
  tabId?: number;
  timestamp: number;
};

let backendPromise: Promise<SupportedBackend> | null = null;
let modelPromise: Promise<use.UniversalSentenceEncoder> | null = null;
const goalEmbeddingCache = new Map<string, number[]>();
const pageEmbeddingCache = new Map<string, number[]>();
let selectedBackend: SupportedBackend | null = null;
let lastAttemptedBackend: SupportedBackend | null = null;
let backendDowngrade: BackendDowngrade | null = null;
let testOverrides: ModelManagerTestOverrides = {};

function toRuntimeUrl(path: string): string {
  return chrome.runtime.getURL(path);
}

function createDebugEvent(
  status: MlDebugEventStatus,
  partial: Omit<MlDebugEvent, 'source' | 'status' | 'timestamp'> = {},
): MlDebugEvent {
  return {
    ...partial,
    source: 'offscreen',
    status,
    timestamp: Date.now(),
  };
}

async function verifyAssetExists(path: string): Promise<void> {
  const response = await fetch(toRuntimeUrl(path));

  if (!response.ok) {
    throw new Error(`Missing asset: ${path}`);
  }
}

function getBackendName(): string {
  return testOverrides.getBackend ? testOverrides.getBackend() : tf.getBackend();
}

async function setBackend(backend: SupportedBackend): Promise<boolean> {
  return testOverrides.setBackend ? testOverrides.setBackend(backend) : tf.setBackend(backend);
}

async function waitForBackendReady(): Promise<void> {
  return testOverrides.ready ? testOverrides.ready() : tf.ready();
}

async function ensureAssetExists(path: string): Promise<void> {
  if (testOverrides.verifyAssetExists) {
    await testOverrides.verifyAssetExists(path);
    return;
  }

  await verifyAssetExists(path);
}

async function loadUseModel(options: {
  modelUrl: string;
  vocabUrl: string;
}): Promise<use.UniversalSentenceEncoder> {
  return testOverrides.loadModel ? testOverrides.loadModel(options) : use.load(options);
}

function getBackendMetadata(): Record<string, string> | undefined {
  if (!backendDowngrade) {
    return undefined;
  }

  return {
    downgradedFrom: backendDowngrade.from,
    downgradeReason: backendDowngrade.reason,
  };
}

function getResolvedBackend(): string {
  return (selectedBackend ?? getBackendName()) || lastAttemptedBackend || 'unknown';
}

async function tryBackend(
  backend: SupportedBackend,
  notifyDebug?: (event: MlDebugEvent) => void,
): Promise<SupportedBackend> {
  lastAttemptedBackend = backend;
  notifyDebug?.(createDebugEvent('model-loading', { backend }));

  const didSwitch = await setBackend(backend);

  if (!didSwitch) {
    throw new Error(`TensorFlow.js backend '${backend}' was not available.`);
  }

  await waitForBackendReady();
  selectedBackend = backend;
  return backend;
}

async function ensureBackend(notifyDebug?: (event: MlDebugEvent) => void): Promise<SupportedBackend> {
  if (!backendPromise) {
    backendPromise = (async () => {
      selectedBackend = null;
      lastAttemptedBackend = null;
      backendDowngrade = null;
      let webglError: string | null = null;

      try {
        return await tryBackend('webgl', notifyDebug);
      } catch (error) {
        webglError = error instanceof Error ? error.message : String(error);
      }

      try {
        const backend = await tryBackend('cpu', notifyDebug);
        backendDowngrade = webglError ? { from: 'webgl', reason: webglError } : null;
        return backend;
      } catch (error) {
        const cpuError = error instanceof Error ? error.message : String(error);
        const attemptMessages = [
          webglError ? `webgl: ${webglError}` : null,
          `cpu: ${cpuError}`,
        ].filter(Boolean);
        throw new Error(`TensorFlow.js backend initialization failed. ${attemptMessages.join(' | ')}`);
      }
    })().catch((error) => {
      backendPromise = null;
      selectedBackend = null;
      throw error;
    });
  }

  return backendPromise;
}

async function loadModel(notifyDebug?: (event: MlDebugEvent) => void): Promise<use.UniversalSentenceEncoder> {
  const backend = await ensureBackend(notifyDebug);
  await Promise.all([ensureAssetExists(MODEL_URL), ensureAssetExists(VOCAB_URL)]);

  const model = await loadUseModel({
    modelUrl: toRuntimeUrl(MODEL_URL),
    vocabUrl: toRuntimeUrl(VOCAB_URL),
  });

  notifyDebug?.(
    createDebugEvent('model-ready', {
      backend,
      metadata: getBackendMetadata(),
    }),
  );
  return model;
}

async function getModel(notifyDebug?: (event: MlDebugEvent) => void): Promise<use.UniversalSentenceEncoder> {
  if (!modelPromise) {
    modelPromise = loadModel(notifyDebug).catch((error) => {
      modelPromise = null;
      throw error;
    });
  }

  return modelPromise;
}

async function getCachedEmbedding(
  cache: Map<string, number[]>,
  key: string,
  text: string,
  notifyDebug?: (event: MlDebugEvent) => void,
  requestId?: string,
): Promise<{ cacheHit: boolean; embedding: number[] }> {
  const cached = cache.get(key);

  if (cached) {
    notifyDebug?.(createDebugEvent('cache-hit', { cacheHit: true, requestId }));
    return { cacheHit: true, embedding: cached };
  }

  notifyDebug?.(createDebugEvent('cache-miss', { cacheHit: false, requestId }));

  const model = await getModel(notifyDebug);
  const embeddings = await model.embed([text]);

  try {
    const [embedding] = (await embeddings.array()) as number[][];

    if (!embedding) {
      throw new Error(`No embedding returned for key: ${key}`);
    }

    cache.set(key, embedding);
    return { cacheHit: false, embedding };
  } finally {
    embeddings.dispose();
  }
}

export async function classifyWithModel(
  request: MlClassifyRequest,
  notifyDebug?: (event: MlDebugEvent) => void,
): Promise<MlClassifyResponse> {
  try {
    const normalizedGoal = normalizeText(request.goal);
    const pageContext = buildPageContext(request.url, request.title);

    if (!normalizedGoal || !pageContext) {
      return {
        backend: getResolvedBackend(),
        cacheHit: false,
        error: 'Missing goal or page context for ML classification.',
        modelState: 'fallback',
        score: null,
      };
    }

    const goalResult = await getCachedEmbedding(
      goalEmbeddingCache,
      normalizedGoal,
      normalizedGoal,
      notifyDebug,
      request.requestId,
    );
    const pageCacheKey = `${request.url}|${pageContext}`;
    const pageResult = await getCachedEmbedding(
      pageEmbeddingCache,
      pageCacheKey,
      pageContext,
      notifyDebug,
      request.requestId,
    );

    const score = cosineSimilarity(goalResult.embedding, pageResult.embedding);
    const classification = classifyCosineScore(score);

    notifyDebug?.(
        createDebugEvent('classification-complete', {
          backend: getResolvedBackend(),
          cacheHit: goalResult.cacheHit && pageResult.cacheHit,
          metadata: getBackendMetadata(),
          requestId: request.requestId,
          score,
        }),
    );

    return {
      backend: getResolvedBackend(),
      cacheHit: goalResult.cacheHit && pageResult.cacheHit,
      classification,
      modelState: 'ready',
      score,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    notifyDebug?.(
      createDebugEvent('classification-fallback', {
        backend: getResolvedBackend(),
        error: message,
        requestId: request.requestId,
      }),
    );

    return {
      backend: getResolvedBackend(),
      cacheHit: false,
      error: message,
      modelState: 'fallback',
      score: null,
    };
  }
}

export function resetModelManagerForTesting(): void {
  backendPromise = null;
  modelPromise = null;
  selectedBackend = null;
  lastAttemptedBackend = null;
  backendDowngrade = null;
  testOverrides = {};
  goalEmbeddingCache.clear();
  pageEmbeddingCache.clear();
}

export function configureModelManagerForTesting(overrides: ModelManagerTestOverrides): void {
  testOverrides = overrides;
}

export function clearModelCaches(): void {
  goalEmbeddingCache.clear();
  pageEmbeddingCache.clear();
}

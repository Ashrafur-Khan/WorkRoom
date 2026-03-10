import * as use from '@tensorflow-models/universal-sentence-encoder';
import * as tf from '@tensorflow/tfjs';
import { setThreadsCount, setWasmPaths } from '@tensorflow/tfjs-backend-wasm';
import '@tensorflow/tfjs-backend-wasm';

import type { Classification } from '../types';
import { buildPageContext, classifyCosineScore, cosineSimilarity, normalizeText } from './ml-helpers';

const MODEL_DIRECTORY = 'assets/models/use';
const MODEL_URL = `${MODEL_DIRECTORY}/model.json`;
const VOCAB_URL = `${MODEL_DIRECTORY}/vocab.json`;

const WASM_PATHS = {
  'tfjs-backend-wasm.wasm': 'assets/tfjs-backend-wasm.wasm',
  'tfjs-backend-wasm-simd.wasm': 'assets/tfjs-backend-wasm-simd.wasm',
  'tfjs-backend-wasm-threaded-simd.wasm': 'assets/tfjs-backend-wasm-threaded-simd.wasm',
} as const;

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

let backendPromise: Promise<void> | null = null;
let modelPromise: Promise<use.UniversalSentenceEncoder> | null = null;
const goalEmbeddingCache = new Map<string, number[]>();
const pageEmbeddingCache = new Map<string, number[]>();

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

async function ensureBackend(notifyDebug?: (event: MlDebugEvent) => void): Promise<void> {
  if (!backendPromise) {
    backendPromise = (async () => {
      notifyDebug?.(createDebugEvent('model-loading', { backend: 'wasm' }));

      tf.env().set('WASM_HAS_MULTITHREAD_SUPPORT', false);
      setThreadsCount(1);
      setWasmPaths(
        Object.fromEntries(
          Object.entries(WASM_PATHS).map(([fileName, path]) => [fileName, toRuntimeUrl(path)]),
        ),
      );

      await Promise.all(Object.values(WASM_PATHS).map(verifyAssetExists));

      const didSwitch = await tf.setBackend('wasm');

      if (!didSwitch) {
        throw new Error('TensorFlow.js WASM backend was not available.');
      }

      await tf.ready();
    })().catch((error) => {
      backendPromise = null;
      throw error;
    });
  }

  await backendPromise;
}

async function loadModel(notifyDebug?: (event: MlDebugEvent) => void): Promise<use.UniversalSentenceEncoder> {
  await ensureBackend(notifyDebug);
  await Promise.all([verifyAssetExists(MODEL_URL), verifyAssetExists(VOCAB_URL)]);

  const model = await use.load({
    modelUrl: toRuntimeUrl(MODEL_URL),
    vocabUrl: toRuntimeUrl(VOCAB_URL),
  });

  notifyDebug?.(createDebugEvent('model-ready', { backend: tf.getBackend() }));
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
        backend: tf.getBackend() || 'unknown',
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
        backend: tf.getBackend(),
        cacheHit: goalResult.cacheHit && pageResult.cacheHit,
        requestId: request.requestId,
        score,
      }),
    );

    return {
      backend: tf.getBackend(),
      cacheHit: goalResult.cacheHit && pageResult.cacheHit,
      classification,
      modelState: 'ready',
      score,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    notifyDebug?.(
      createDebugEvent('classification-fallback', {
        backend: tf.getBackend() || 'unknown',
        error: message,
        requestId: request.requestId,
      }),
    );

    return {
      backend: tf.getBackend() || 'unknown',
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
  goalEmbeddingCache.clear();
  pageEmbeddingCache.clear();
}

export function clearModelCaches(): void {
  goalEmbeddingCache.clear();
  pageEmbeddingCache.clear();
}

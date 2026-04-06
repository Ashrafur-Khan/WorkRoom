import type { Classification, PageSignals } from '../types';
import { classifyCosineScore, cosineSimilarity, normalizeText } from './ml-helpers';
import { buildNormalizedPageContext } from './page-signals';

type EmbeddingOutput = { data: Float32Array };
type EmbeddingPipeline = (text: string, options?: Record<string, unknown>) => Promise<EmbeddingOutput>;

const MODEL_DIRECTORY = 'assets/models/minilm';
// `config.json` is a lightweight sentinel that proves the packaged model exists
// without eagerly fetching the heavier ONNX weight file. The path must include
// the HuggingFace model ID subdirectory because the build nests files there to
// match the library's local path resolution: {localModelPath}/{modelId}/{file}.
const MODEL_CONFIG_PATH = `${MODEL_DIRECTORY}/Xenova/all-MiniLM-L6-v2/config.json`;
const ORT_ASSET_DIRECTORY = 'assets';
const ORT_WASM_MODULE_PATH = `${ORT_ASSET_DIRECTORY}/ort-wasm-simd-threaded.jsep.mjs`;
const ORT_WASM_BINARY_PATH = `${ORT_ASSET_DIRECTORY}/ort-wasm-simd-threaded.jsep.wasm`;
// The response contract still exposes `backend` for background compatibility, even
// though the offscreen runtime now only supports ONNX Runtime WASM.
const BACKEND_NAME = 'wasm';

type ModelManagerTestOverrides = {
  createPipeline?: () => Promise<EmbeddingPipeline>;
  verifyAssetExists?: typeof verifyAssetExists;
};

export type MlClassifyRequest = {
  goal: string;
  pageSignals?: PageSignals;
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

let pipelinePromise: Promise<EmbeddingPipeline> | null = null;
// Goal and page embeddings stay in the offscreen document so the background worker
// never owns ML state directly. They are cleared on explicit runtime teardown.
const goalEmbeddingCache = new Map<string, number[]>();
const pageEmbeddingCache = new Map<string, number[]>();
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
  let response: Response;

  try {
    response = await fetch(toRuntimeUrl(path));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not fetch model asset ${path}: ${message}`);
  }

  if (!response.ok) {
    throw new Error(`Missing asset: ${path}`);
  }
}

async function ensureAssetExists(path: string): Promise<void> {
  if (testOverrides.verifyAssetExists) {
    await testOverrides.verifyAssetExists(path);
    return;
  }

  await verifyAssetExists(path);
}

async function ensureRuntimeAssetsExist(): Promise<void> {
  await ensureAssetExists(ORT_WASM_MODULE_PATH);
  await ensureAssetExists(ORT_WASM_BINARY_PATH);
}

async function createLocalPipeline(): Promise<EmbeddingPipeline> {
  // Dynamic import: @huggingface/transformers is ESM-only; dynamic import
  // keeps the CJS test build working (tests inject createPipeline overrides).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hf: any = await import('@huggingface/transformers');

  hf.env.allowRemoteModels = false;
  hf.env.allowLocalModels = true;
  hf.env.useBrowserCache = false;
  hf.env.localModelPath = toRuntimeUrl(MODEL_DIRECTORY) + '/';

  if (hf.env.backends?.onnx?.wasm) {
    hf.env.backends.onnx.wasm.wasmPaths = {
      mjs: toRuntimeUrl(ORT_WASM_MODULE_PATH),
      wasm: toRuntimeUrl(ORT_WASM_BINARY_PATH),
    };
  }

  const pipe = await hf.pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
    local_files_only: true,
  });
  return pipe as EmbeddingPipeline;
}

async function loadModel(
  notifyDebug?: (event: MlDebugEvent) => void,
): Promise<EmbeddingPipeline> {
  notifyDebug?.(createDebugEvent('model-loading', { backend: BACKEND_NAME }));
  const startedAt = Date.now();

  await ensureAssetExists(MODEL_CONFIG_PATH);
  await ensureRuntimeAssetsExist();

  const createFn = testOverrides.createPipeline ?? createLocalPipeline;
  const pipe = await createFn();

  notifyDebug?.(
    createDebugEvent('model-ready', {
      backend: BACKEND_NAME,
      metadata: {
        loadDurationMs: Date.now() - startedAt,
      },
    }),
  );
  return pipe;
}

async function getModel(
  notifyDebug?: (event: MlDebugEvent) => void,
): Promise<EmbeddingPipeline> {
  if (!pipelinePromise) {
    pipelinePromise = loadModel(notifyDebug).catch((error) => {
      pipelinePromise = null;
      throw error;
    });
  }

  return pipelinePromise;
}

async function getCachedEmbedding(
  cache: Map<string, number[]>,
  key: string,
  text: string,
  cacheName: 'goal' | 'page',
  notifyDebug?: (event: MlDebugEvent) => void,
  requestId?: string,
): Promise<{ cacheHit: boolean; embedding: number[] }> {
  const cached = cache.get(key);

  if (cached) {
    notifyDebug?.(
      createDebugEvent('cache-hit', {
        cacheHit: true,
        metadata: { cache: cacheName },
        requestId,
      }),
    );
    return { cacheHit: true, embedding: cached };
  }

  notifyDebug?.(
    createDebugEvent('cache-miss', {
      cacheHit: false,
      metadata: { cache: cacheName },
      requestId,
    }),
  );

  const pipe = await getModel(notifyDebug);
  const output = await pipe(text, { pooling: 'mean', normalize: true });
  const embedding = Array.from(output.data);

  if (embedding.length === 0) {
    throw new Error(`No embedding returned for key: ${key}`);
  }

  cache.set(key, embedding);
  return { cacheHit: false, embedding };
}

export async function classifyWithModel(
  request: MlClassifyRequest,
  notifyDebug?: (event: MlDebugEvent) => void,
): Promise<MlClassifyResponse> {
  const startedAt = Date.now();

  try {
    const normalizedGoal = normalizeText(request.goal);
    const pageContext = buildNormalizedPageContext({
      pageSignals: request.pageSignals,
      title: request.title,
      url: request.url,
    });

    if (!normalizedGoal || !pageContext) {
      return {
        backend: BACKEND_NAME,
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
      'goal',
      notifyDebug,
      request.requestId,
    );
    const pageCacheKey = `page:${pageContext}`;
    const pageResult = await getCachedEmbedding(
      pageEmbeddingCache,
      pageCacheKey,
      pageContext,
      'page',
      notifyDebug,
      request.requestId,
    );

    const score = cosineSimilarity(goalResult.embedding, pageResult.embedding);
    const classification = classifyCosineScore(score);

    notifyDebug?.(
      createDebugEvent('classification-complete', {
        backend: BACKEND_NAME,
        cacheHit: goalResult.cacheHit && pageResult.cacheHit,
        metadata: {
          classificationDurationMs: Date.now() - startedAt,
        },
        requestId: request.requestId,
        score,
      }),
    );

    return {
      backend: BACKEND_NAME,
      cacheHit: goalResult.cacheHit && pageResult.cacheHit,
      classification,
      modelState: 'ready',
      score,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    notifyDebug?.(
      createDebugEvent('classification-fallback', {
        backend: BACKEND_NAME,
        error: message,
        metadata: {
          classificationDurationMs: Date.now() - startedAt,
        },
        requestId: request.requestId,
      }),
    );

    return {
      backend: BACKEND_NAME,
      cacheHit: false,
      error: message,
      modelState: 'fallback',
      score: null,
    };
  }
}

export function resetModelManagerForTesting(): void {
  pipelinePromise = null;
  testOverrides = {};
  clearModelCaches();
}

export function configureModelManagerForTesting(overrides: ModelManagerTestOverrides): void {
  testOverrides = overrides;
}

export function clearModelCaches(): void {
  // Clearing both caches keeps the offscreen model lifetime explicit while
  // leaving the background-facing ML contract unchanged.
  goalEmbeddingCache.clear();
  pageEmbeddingCache.clear();
}

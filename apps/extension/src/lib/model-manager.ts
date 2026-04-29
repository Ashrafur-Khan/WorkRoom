import type { FeatureExtractionPipelineOptions, FeatureExtractionPipelineType, Tensor } from '@huggingface/transformers';
import type { DebugLogEntry, MlClassifyRequest, MlClassifyResponse } from '../types';
import { classifyCosineScore, cosineSimilarity, normalizeText } from './ml-helpers';
import { buildNormalizedPageContext } from './page-context';

const MODEL_DIRECTORY = 'assets/models/minilm';
const MODEL_CONFIG_PATH = `${MODEL_DIRECTORY}/Xenova/all-MiniLM-L6-v2/config.json`;
const ORT_ASSET_DIRECTORY = 'assets';
const ORT_WASM_MODULE_PATH = `${ORT_ASSET_DIRECTORY}/ort-wasm-simd-threaded.jsep.mjs`;
const ORT_WASM_BINARY_PATH = `${ORT_ASSET_DIRECTORY}/ort-wasm-simd-threaded.jsep.wasm`;
const BACKEND_NAME = 'wasm';

type MlDebugEventStatus =
  | 'cache-hit'
  | 'cache-miss'
  | 'classification-complete'
  | 'classification-fallback'
  | 'model-loading'
  | 'model-ready'
  | 'offscreen-closed'
  | 'offscreen-created';

type ModelManagerTestOverrides = {
  createPipeline?: () => Promise<FeatureExtractionPipelineType>;
  verifyAssetExists?: typeof verifyAssetExists;
};

type TransformersEnv = {
  allowLocalModels: boolean;
  allowRemoteModels: boolean;
  backends?: {
    onnx?: {
      wasm?: {
        wasmPaths?: {
          mjs: string;
          wasm: string;
        };
      };
    };
  };
  localModelPath: string;
  useBrowserCache: boolean;
};

type TransformersModule = {
  env: TransformersEnv;
  pipeline: (
    task: 'feature-extraction',
    model: string,
    options: {
      local_files_only: true;
    },
  ) => Promise<FeatureExtractionPipelineType>;
};

let pipelinePromise: Promise<FeatureExtractionPipelineType> | null = null;
const goalEmbeddingCache = new Map<string, number[]>();
const pageEmbeddingCache = new Map<string, number[]>();
let testOverrides: ModelManagerTestOverrides = {};

function toRuntimeUrl(path: string): string {
  return chrome.runtime.getURL(path);
}

function createDebugEvent(
  status: MlDebugEventStatus,
  partial: Omit<DebugLogEntry, 'source' | 'status' | 'timestamp'> = {},
): DebugLogEntry {
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

async function createLocalPipeline(): Promise<FeatureExtractionPipelineType> {
  const hf = await import('@huggingface/transformers') as unknown as TransformersModule;

  hf.env.allowRemoteModels = false;
  hf.env.allowLocalModels = true;
  hf.env.useBrowserCache = false;
  hf.env.localModelPath = `${toRuntimeUrl(MODEL_DIRECTORY)}/`;

  if (hf.env.backends?.onnx?.wasm) {
    hf.env.backends.onnx.wasm.wasmPaths = {
      mjs: toRuntimeUrl(ORT_WASM_MODULE_PATH),
      wasm: toRuntimeUrl(ORT_WASM_BINARY_PATH),
    };
  }

  return hf.pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
    local_files_only: true,
  });
}

async function loadModel(
  notifyDebug?: (event: DebugLogEntry) => void,
): Promise<FeatureExtractionPipelineType> {
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
  notifyDebug?: (event: DebugLogEntry) => void,
): Promise<FeatureExtractionPipelineType> {
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
  notifyDebug?: (event: DebugLogEntry) => void,
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
  const output = await pipe(text, {
    normalize: true,
    pooling: 'mean',
  } satisfies FeatureExtractionPipelineOptions);
  const embedding = Array.from((output as Tensor).data);

  if (embedding.length === 0) {
    throw new Error(`No embedding returned for key: ${key}`);
  }

  cache.set(key, embedding);
  return { cacheHit: false, embedding };
}

export async function classifyWithModel(
  request: MlClassifyRequest,
  notifyDebug?: (event: DebugLogEntry) => void,
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
  goalEmbeddingCache.clear();
  pageEmbeddingCache.clear();
}

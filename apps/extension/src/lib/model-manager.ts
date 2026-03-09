import * as use from '@tensorflow-models/universal-sentence-encoder';
import * as tf from '@tensorflow/tfjs';
import { setWasmPaths } from '@tensorflow/tfjs-backend-wasm';
import '@tensorflow/tfjs-backend-wasm';

const MODEL_DIRECTORY = 'assets/models/use';
const MODEL_URL = `${MODEL_DIRECTORY}/model.json`;
const VOCAB_URL = `${MODEL_DIRECTORY}/vocab.json`;

const WASM_PATHS = {
  'tfjs-backend-wasm.wasm': 'assets/tfjs-backend-wasm.wasm',
  'tfjs-backend-wasm-simd.wasm': 'assets/tfjs-backend-wasm-simd.wasm',
  'tfjs-backend-wasm-threaded-simd.wasm': 'assets/tfjs-backend-wasm-threaded-simd.wasm',
} as const;

let backendPromise: Promise<void> | null = null;
let modelPromise: Promise<use.UniversalSentenceEncoder> | null = null;

function toRuntimeUrl(path: string): string {
  return chrome.runtime.getURL(path);
}

async function verifyAssetExists(path: string): Promise<void> {
  const response = await fetch(toRuntimeUrl(path));

  if (!response.ok) {
    throw new Error(`Missing asset: ${path}`);
  }
}

async function ensureBackend(): Promise<void> {
  if (!backendPromise) {
    backendPromise = (async () => {
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

  return backendPromise;
}

async function loadModel(): Promise<use.UniversalSentenceEncoder> {
  await ensureBackend();
  await Promise.all([verifyAssetExists(MODEL_URL), verifyAssetExists(VOCAB_URL)]);

  return use.load({
    modelUrl: toRuntimeUrl(MODEL_URL),
    vocabUrl: toRuntimeUrl(VOCAB_URL),
  });
}

async function getModel(): Promise<use.UniversalSentenceEncoder> {
  if (!modelPromise) {
    modelPromise = loadModel().catch((error) => {
      modelPromise = null;
      throw error;
    });
  }

  return modelPromise;
}

export async function embedTexts(texts: string[]): Promise<number[][]> {
  const model = await getModel();
  const embeddings = await model.embed(texts);

  try {
    return (await embeddings.array()) as number[][];
  } finally {
    embeddings.dispose();
  }
}

export function resetModelManagerForTesting(): void {
  backendPromise = null;
  modelPromise = null;
}

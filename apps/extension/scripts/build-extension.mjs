import { createRequire } from 'node:module';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { cp } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const require = createRequire(import.meta.url);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..', '..', '..');
const extensionRoot = resolve(repoRoot, 'apps/extension');
const distRoot = resolve(extensionRoot, 'dist');
const distAssetsRoot = resolve(distRoot, 'assets');
const vendoredMiniLmRoot = resolve(extensionRoot, 'ml/minilm');

const HF_MODEL_REPO = 'Xenova/all-MiniLM-L6-v2';
const HF_MODEL_FILES = [
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'onnx/model_quantized.onnx',
];
export const REQUIRED_ORT_RUNTIME_ASSETS = [
  'ort-wasm-simd-threaded.jsep.mjs',
  'ort-wasm-simd-threaded.jsep.wasm',
  'ort-wasm-simd-threaded.mjs',
  'ort-wasm-simd-threaded.wasm',
];
const ORT_RUNTIME_ASSET_PATTERN = /^ort-wasm.*\.(?:mjs|wasm)$/;

async function ensureDirectory(path) {
  mkdirSync(path, { recursive: true });
}

async function runViteBuilds() {
  await build({
    configFile: false,
    publicDir: false,
    root: extensionRoot,
    build: {
      emptyOutDir: true,
      outDir: distRoot,
      rollupOptions: {
        input: {
          popup: resolve(extensionRoot, 'src/popup/popup.html'),
          offscreen: resolve(extensionRoot, 'src/offscreen/offscreen.html'),
          background: resolve(extensionRoot, 'src/background/index.ts'),
        },
        output: {
          entryFileNames: 'src/[name]/index.js',
          chunkFileNames: 'assets/[name].js',
          assetFileNames: 'assets/[name].[ext]',
        },
      },
    },
  });

  await build({
    configFile: false,
    publicDir: false,
    root: extensionRoot,
    build: {
      cssCodeSplit: false,
      emptyOutDir: false,
      lib: {
        cssFileName: 'content',
        entry: resolve(extensionRoot, 'src/content/index.ts'),
        fileName: () => 'src/content/index.js',
        formats: ['iife'],
        name: 'WorkRoomContentScript',
      },
      outDir: distRoot,
      rollupOptions: {
        output: {
          assetFileNames: (assetInfo) => {
            if (assetInfo.name === 'content.css') {
              return 'assets/content.css';
            }

            return 'assets/[name].[ext]';
          },
        },
      },
    },
  });
}

function validateContentScriptBundle() {
  const contentScriptPath = resolve(distRoot, 'src/content/index.js');
  const contentScript = readFileSync(contentScriptPath, 'utf8');

  if (/\bimport\b|\bexport\b/.test(contentScript)) {
    throw new Error(`Content script bundle contains ESM syntax: ${contentScriptPath}`);
  }

  if (/assets\/[^"'`\s]+\.js\b/.test(contentScript)) {
    throw new Error(`Content script bundle references external JS chunks: ${contentScriptPath}`);
  }
}

function normalizeContentStyleAsset() {
  const emittedPath = resolve(distRoot, 'assets/style.css');
  const expectedPath = resolve(distRoot, 'assets/content.css');

  if (existsSync(emittedPath)) {
    renameSync(emittedPath, expectedPath);
  }
}

async function copyStaticAssets() {
  copyFileSync(resolve(extensionRoot, 'manifest.json'), resolve(distRoot, 'manifest.json'));
  copyFileSync(resolve(extensionRoot, 'workicon.png'), resolve(distRoot, 'workicon.png'));
}

export function getRequiredOnnxRuntimeAssets(fileNames) {
  return fileNames.filter((fileName) => ORT_RUNTIME_ASSET_PATTERN.test(fileName)).sort();
}

export function validateOnnxRuntimeAssetSet(fileNames) {
  const missingFiles = REQUIRED_ORT_RUNTIME_ASSETS.filter((fileName) => !fileNames.includes(fileName));

  if (missingFiles.length > 0) {
    throw new Error(
      `Missing required ONNX Runtime web assets: ${missingFiles.join(', ')}`,
    );
  }
}

async function copyOnnxRuntimeAssets() {
  const onnxDistRoot = dirname(require.resolve('onnxruntime-web'));

  await ensureDirectory(distAssetsRoot);

  const runtimeFiles = getRequiredOnnxRuntimeAssets(readdirSync(onnxDistRoot));

  validateOnnxRuntimeAssetSet(runtimeFiles);

  for (const fileName of runtimeFiles) {
    copyFileSync(resolve(onnxDistRoot, fileName), resolve(distAssetsRoot, fileName));
  }
}

function validateDistOnnxRuntimeAssets() {
  if (!existsSync(distAssetsRoot)) {
    throw new Error(`Missing dist assets directory: ${distAssetsRoot}`);
  }

  validateOnnxRuntimeAssetSet(readdirSync(distAssetsRoot));
}

async function downloadFile(url, destinationPath) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  }

  const fileBuffer = Buffer.from(await response.arrayBuffer());
  mkdirSync(dirname(destinationPath), { recursive: true });
  writeFileSync(destinationPath, fileBuffer);
}

async function copyVendoredMiniLmAssets(destinationRoot) {
  if (!existsSync(vendoredMiniLmRoot)) {
    return false;
  }

  await cp(vendoredMiniLmRoot, destinationRoot, { recursive: true });
  return true;
}

async function downloadMiniLmAssets(destinationRoot) {
  for (const filePath of HF_MODEL_FILES) {
    const url = `https://huggingface.co/${HF_MODEL_REPO}/resolve/main/${filePath}`;
    await downloadFile(url, resolve(destinationRoot, filePath));
  }
}

async function ensureMiniLmAssets() {
  // Nest under the HuggingFace model ID so the runtime path matches what
  // @huggingface/transformers resolves: {localModelPath}/{modelId}/{file}.
  const destinationRoot = resolve(distAssetsRoot, 'models/minilm', HF_MODEL_REPO);
  await ensureDirectory(destinationRoot);
  await ensureDirectory(resolve(destinationRoot, 'onnx'));

  if (await copyVendoredMiniLmAssets(destinationRoot)) {
    return;
  }

  await downloadMiniLmAssets(destinationRoot);
}

async function main() {
  await runViteBuilds();
  normalizeContentStyleAsset();
  validateContentScriptBundle();
  await copyStaticAssets();
  await copyOnnxRuntimeAssets();
  await ensureMiniLmAssets();
  validateDistOnnxRuntimeAssets();
}

if (process.argv[1] === __filename) {
  main().catch((error) => {
    console.error('[WorkRoom] Extension build failed:', error);
    process.exitCode = 1;
  });
}

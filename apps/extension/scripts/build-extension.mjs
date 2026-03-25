import { createRequire } from 'node:module';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
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
const vendoredUseAssetsRoot = resolve(extensionRoot, 'ml/use');

const USE_MODEL_SOURCE =
  'https://storage.googleapis.com/tfjs-models/savedmodel/universal_sentence_encoder/model.json';
const USE_VOCAB_SOURCE =
  'https://storage.googleapis.com/tfjs-models/savedmodel/universal_sentence_encoder/vocab.json';

const wasmFiles = [
  'tfjs-backend-wasm.wasm',
  'tfjs-backend-wasm-simd.wasm',
  'tfjs-backend-wasm-threaded-simd.wasm',
];

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

async function copyWasmAssets() {
  const packageRoot = dirname(require.resolve('@tensorflow/tfjs-backend-wasm/package.json'));

  await ensureDirectory(distAssetsRoot);

  for (const fileName of wasmFiles) {
    copyFileSync(resolve(packageRoot, 'dist', fileName), resolve(distAssetsRoot, fileName));
  }
}

async function downloadJson(url) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  }

  return {
    json: await response.json(),
    resolvedUrl: response.url,
  };
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

async function copyVendoredUseAssets(destinationRoot) {
  if (!existsSync(vendoredUseAssetsRoot)) {
    return false;
  }

  await cp(vendoredUseAssetsRoot, destinationRoot, { recursive: true });
  return true;
}

async function downloadUseAssets(destinationRoot) {
  const { json: modelJson, resolvedUrl } = await downloadJson(USE_MODEL_SOURCE);
  const resolvedModelUrl = new URL(resolvedUrl);
  const baseModelUrl = new URL('./', resolvedModelUrl);

  writeFileSync(resolve(destinationRoot, 'model.json'), JSON.stringify(modelJson, null, 2));
  await downloadFile(USE_VOCAB_SOURCE, resolve(destinationRoot, 'vocab.json'));

  const shardPaths = modelJson.weightsManifest.flatMap((entry) => entry.paths);

  await Promise.all(
    shardPaths.map((relativePath) =>
      downloadFile(new URL(relativePath, baseModelUrl).toString(), resolve(destinationRoot, relativePath)),
    ),
  );
}

async function ensureUseAssets() {
  const destinationRoot = resolve(distAssetsRoot, 'models/use');
  await ensureDirectory(destinationRoot);

  if (await copyVendoredUseAssets(destinationRoot)) {
    return;
  }

  await downloadUseAssets(destinationRoot);
}

async function main() {
  await runViteBuilds();
  normalizeContentStyleAsset();
  validateContentScriptBundle();
  await copyStaticAssets();
  await copyWasmAssets();
  await ensureUseAssets();
}

main().catch((error) => {
  console.error('[WorkRoom] Extension build failed:', error);
  process.exitCode = 1;
});

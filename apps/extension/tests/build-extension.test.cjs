const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { resolve } = require('node:path');

const buildScriptUrl = pathToFileURL(
  resolve(__dirname, '../scripts/build-extension.mjs'),
).href;

test('build script selects the ORT runtime modules and wasm files required by the extension', async () => {
  const {
    REQUIRED_ORT_RUNTIME_ASSETS,
    getRequiredOnnxRuntimeAssets,
  } = await import(buildScriptUrl);

  const selectedAssets = getRequiredOnnxRuntimeAssets([
    'ort-wasm-simd-threaded.jsep.wasm',
    'ort-wasm-simd-threaded.jsep.mjs',
    'ort-wasm-simd-threaded.wasm',
    'ort-wasm-simd-threaded.mjs',
    'ort.all.mjs',
    'transformers.web.js',
  ]);

  assert.deepEqual(selectedAssets, REQUIRED_ORT_RUNTIME_ASSETS);
});

test('build script validation fails when a required ORT runtime asset is missing', async () => {
  const {
    REQUIRED_ORT_RUNTIME_ASSETS,
    validateOnnxRuntimeAssetSet,
  } = await import(buildScriptUrl);

  const incompleteAssets = REQUIRED_ORT_RUNTIME_ASSETS.filter(
    (fileName) => fileName !== 'ort-wasm-simd-threaded.jsep.mjs',
  );

  assert.throws(
    () => validateOnnxRuntimeAssetSet(incompleteAssets),
    /ort-wasm-simd-threaded\.jsep\.mjs/i,
  );
});

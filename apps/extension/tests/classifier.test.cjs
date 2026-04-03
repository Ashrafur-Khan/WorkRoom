const test = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyUrl,
  heuristicClassifyUrl,
} = require('../.test-build/lib/classifier.js');
const {
  normalizeText,
} = require('../.test-build/lib/ml-helpers.js');
const {
  classifyWithModel,
  configureModelManagerForTesting,
  resetModelManagerForTesting,
} = require('../.test-build/lib/model-manager.js');

const originalFetch = global.fetch;
const originalChrome = global.chrome;

function installChromeRuntime() {
  global.chrome = {
    runtime: {
      getURL: (path) => path,
    },
  };
}

function installAssetFetchStub() {
  global.fetch = async () => ({ ok: true });
}

function mockPipeline(embeddingsByInput) {
  return async () => async (text) => {
    const embedding = embeddingsByInput[text];

    if (!embedding) {
      throw new Error(`Missing mock embedding for input: ${text}`);
    }

    return { data: new Float32Array(embedding) };
  };
}

test('normalizeText collapses punctuation and casing', () => {
  assert.equal(normalizeText('Study: Econ Chapter 5!'), 'study econ chapter 5');
});

test('classifyUrl returns ML on-task result when offscreen responds positively', async () => {
  const result = await classifyUrl(
    'https://example.edu/calculus',
    'Calculus lecture notes',
    'Study calculus',
    { requestId: 'req-1', tabId: 1 },
    {
      appendDebugLog: async () => undefined,
      async requestMlClassification() {
        return {
          backend: 'wasm',
          cacheHit: false,
          classification: 'on-task',
          modelState: 'ready',
          score: 0.87,
        };
      },
    },
  );

  assert.equal(result.classification, 'on-task');
  assert.equal(result.source, 'ml');
  assert.equal(result.score, 0.87);
});

test('classifyUrl returns ML off-task result when offscreen responds negatively', async () => {
  const result = await classifyUrl(
    'https://example.com/reels',
    'Instagram reels',
    'Study calculus',
    { requestId: 'req-2', tabId: 2 },
    {
      appendDebugLog: async () => undefined,
      async requestMlClassification() {
        return {
          backend: 'wasm',
          cacheHit: false,
          classification: 'off-task',
          modelState: 'ready',
          score: 0.12,
        };
      },
    },
  );

  assert.equal(result.classification, 'off-task');
  assert.equal(result.source, 'ml');
  assert.equal(result.score, 0.12);
});

test('classifyUrl falls back to heuristics when offscreen request fails', async () => {
  const result = await classifyUrl(
    'https://github.com/tensorflow/tfjs',
    'TensorFlow.js repository',
    'Ship extension ml',
    { requestId: 'req-3', tabId: 3 },
    {
      appendDebugLog: async () => undefined,
      async requestMlClassification() {
        throw new Error('boom');
      },
    },
  );

  assert.equal(result.classification, 'on-task');
  assert.equal(result.source, 'heuristic');
  assert.equal(result.score, null);
});

test('classifyUrl uses background heuristic when offscreen returns fallback', async () => {
  const result = await classifyUrl(
    'https://github.com/tensorflow/tfjs',
    'TensorFlow.js repository',
    'Ship extension ml',
    { requestId: 'req-3b', tabId: 33 },
    {
      appendDebugLog: async () => undefined,
      async requestMlClassification() {
        return {
          backend: 'wasm',
          cacheHit: false,
          error: 'model load failed',
          modelState: 'fallback',
          score: null,
        };
      },
    },
  );

  assert.equal(result.classification, 'on-task');
  assert.equal(result.source, 'heuristic');
  assert.equal(result.score, null);
});

test('classifyUrl falls back to ambiguous for invalid URLs', async () => {
  const result = await classifyUrl(
    'chrome://extensions',
    'Extensions',
    'Study calculus',
    { requestId: 'req-4' },
    {
      appendDebugLog: async () => undefined,
      async requestMlClassification() {
        throw new Error('boom');
      },
    },
  );
  assert.equal(result.classification, 'ambiguous');
  assert.equal(result.source, 'heuristic');
});

test('heuristic classifier returns ambiguous for sites not in the background distraction list', () => {
  assert.equal(
    heuristicClassifyUrl('https://www.reddit.com/r/typescript', 'TypeScript post', 'Study calculus'),
    'ambiguous',
  );
});

test('background heuristic does not force youtube off-task during ML fallback', async () => {
  const result = await classifyUrl(
    'https://www.youtube.com/watch?v=abc123',
    'Calculus lecture walkthrough',
    'Study calculus',
    { requestId: 'req-youtube', tabId: 5 },
    {
      appendDebugLog: async () => undefined,
      async requestMlClassification() {
        return {
          backend: 'wasm',
          cacheHit: false,
          error: 'model unavailable',
          modelState: 'fallback',
          score: null,
        };
      },
    },
  );

  assert.equal(result.classification, 'on-task');
  assert.equal(result.source, 'heuristic');
});

test('classifyWithModel returns fallback response if pipeline init fails', async () => {
  installChromeRuntime();
  configureModelManagerForTesting({
    createPipeline: async () => { throw new Error('Pipeline initialization failed'); },
    verifyAssetExists: async () => undefined,
  });

  const result = await classifyWithModel({
    goal: 'Study calculus',
    requestId: 'req-5',
    title: 'Calculus lecture notes',
    url: 'https://example.edu/calculus',
  });

  assert.equal(result.modelState, 'fallback');
  assert.equal(result.score, null);
  assert.equal(typeof result.error, 'string');
  assert.match(result.error, /pipeline initialization failed/i);
});

test('classifyWithModel loads pipeline and classifies correctly', async () => {
  installChromeRuntime();

  configureModelManagerForTesting({
    createPipeline: mockPipeline({
      'study calculus': [1, 0, 0],
      'calculus lecture notes example': [1, 0, 0],
    }),
    verifyAssetExists: async () => undefined,
  });

  const debugEvents = [];
  const result = await classifyWithModel(
    {
      goal: 'Study calculus',
      requestId: 'req-pipeline',
      title: 'Calculus lecture notes',
      url: 'https://example.edu/calculus',
    },
    (event) => debugEvents.push(event),
  );

  assert.equal(result.modelState, 'ready');
  assert.equal(result.backend, 'wasm');
  assert.equal(result.classification, 'on-task');
  assert.equal(debugEvents.at(-1)?.status, 'classification-complete');
  assert.equal(debugEvents.at(-1)?.backend, 'wasm');
});

test('classifyWithModel reuses cached pipeline across calls', async () => {
  installChromeRuntime();

  let createCount = 0;

  configureModelManagerForTesting({
    createPipeline: async () => {
      createCount++;
      return async (text) => ({
        data: new Float32Array([1, 0, 0]),
      });
    },
    verifyAssetExists: async () => undefined,
  });

  await classifyWithModel({
    goal: 'Study calculus',
    requestId: 'req-a',
    title: 'Calculus lecture notes',
    url: 'https://example.edu/calculus',
  });

  await classifyWithModel({
    goal: 'Study calculus',
    requestId: 'req-b',
    title: 'Calculus lecture notes',
    url: 'https://example.edu/calculus',
  });

  assert.equal(createCount, 1);
});

test.afterEach(() => {
  global.fetch = originalFetch;
  global.chrome = originalChrome;
  resetModelManagerForTesting();
});

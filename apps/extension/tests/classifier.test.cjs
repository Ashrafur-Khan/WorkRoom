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

function createEmbeddingTensor(embedding) {
  return {
    async array() {
      return [embedding];
    },
    dispose() {},
  };
}

function mockUseModel(embeddingsByInput) {
  return async () => ({
    async embed([text]) {
      const embedding = embeddingsByInput[text];

      if (!embedding) {
        throw new Error(`Missing mock embedding for input: ${text}`);
      }

      return createEmbeddingTensor(embedding);
    },
  });
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

  assert.equal(result, 'on-task');
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

  assert.equal(result, 'off-task');
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

  assert.equal(result, 'on-task');
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

  assert.equal(result, 'on-task');
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
  assert.equal(result, 'ambiguous');
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

  assert.equal(result, 'on-task');
});

test('classifyWithModel returns fallback response if tf runtime fails', async () => {
  installChromeRuntime();
  configureModelManagerForTesting({
    getBackend: () => '',
    ready: async () => undefined,
    setBackend: async () => false,
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
  assert.match(result.error, /backend initialization failed/i);
});

test('classifyWithModel prefers the webgl backend when available', async () => {
  installChromeRuntime();

  const backendAttempts = [];
  let activeBackend = 'cpu';

  configureModelManagerForTesting({
    getBackend: () => activeBackend,
    loadModel: mockUseModel({
      'study calculus': [1, 0, 0],
      'calculus lecture notes example': [1, 0, 0],
    }),
    ready: async () => undefined,
    setBackend: async (backend) => {
      backendAttempts.push(backend);
      activeBackend = backend;
      return backend === 'webgl';
    },
    verifyAssetExists: async () => undefined,
  });

  const debugEvents = [];
  const result = await classifyWithModel(
    {
      goal: 'Study calculus',
      requestId: 'req-webgl',
      title: 'Calculus lecture notes',
      url: 'https://example.edu/calculus',
    },
    (event) => debugEvents.push(event),
  );

  assert.deepEqual(backendAttempts, ['webgl']);
  assert.equal(result.modelState, 'ready');
  assert.equal(result.backend, 'webgl');
  assert.equal(result.classification, 'on-task');
  assert.equal(debugEvents.at(-1)?.status, 'classification-complete');
  assert.equal(debugEvents.at(-1)?.backend, 'webgl');
});

test('classifyWithModel falls back to cpu when webgl initialization fails', async () => {
  installChromeRuntime();

  const backendAttempts = [];
  let activeBackend = 'cpu';

  configureModelManagerForTesting({
    getBackend: () => activeBackend,
    loadModel: mockUseModel({
      'study calculus': [1, 0, 0],
      'calculus lecture notes example': [1, 0, 0],
    }),
    ready: async () => undefined,
    setBackend: async (backend) => {
      backendAttempts.push(backend);

      if (backend === 'webgl') {
        throw new Error('WebGL context creation failed');
      }

      activeBackend = backend;
      return backend === 'cpu';
    },
    verifyAssetExists: async () => undefined,
  });

  const debugEvents = [];
  const result = await classifyWithModel(
    {
      goal: 'Study calculus',
      requestId: 'req-cpu',
      title: 'Calculus lecture notes',
      url: 'https://example.edu/calculus',
    },
    (event) => debugEvents.push(event),
  );

  assert.deepEqual(backendAttempts, ['webgl', 'cpu']);
  assert.equal(result.modelState, 'ready');
  assert.equal(result.backend, 'cpu');
  assert.equal(result.classification, 'on-task');
  assert.deepEqual(
    debugEvents
      .filter((event) => event.status === 'model-loading')
      .map((event) => event.backend),
    ['webgl', 'cpu'],
  );
  assert.equal(debugEvents.at(-1)?.metadata?.downgradedFrom, 'webgl');
  assert.match(debugEvents.at(-1)?.metadata?.downgradeReason ?? '', /context creation failed/i);
});

test.afterEach(() => {
  global.fetch = originalFetch;
  global.chrome = originalChrome;
  resetModelManagerForTesting();
});

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyUrl,
  clearClassificationCaches,
  configureEmbeddingProviderForTesting,
  heuristicClassifyUrl,
} = require('../.test-build/lib/classifier.js');
const {
  buildPageContext,
  classifyCosineScore,
  cosineSimilarity,
  normalizeText,
} = require('../.test-build/lib/ml-helpers.js');

test('normalizeText collapses punctuation and casing', () => {
  assert.equal(normalizeText('Study: Econ Chapter 5!'), 'study econ chapter 5');
});

test('buildPageContext includes title and hostname tokens', () => {
  assert.equal(
    buildPageContext('https://docs.github.com/en/actions', 'GitHub Actions documentation'),
    'github actions documentation docs github',
  );
});

test('classifyCosineScore thresholds focused and distractive scores', () => {
  assert.equal(classifyCosineScore(0.81), 'on-task');
  assert.equal(classifyCosineScore(0.12), 'off-task');
  assert.equal(classifyCosineScore(0.44), 'ambiguous');
});

test('cosineSimilarity prefers aligned vectors', () => {
  assert.ok(cosineSimilarity([1, 0, 0], [0.9, 0.1, 0]) > 0.9);
  assert.ok(cosineSimilarity([1, 0, 0], [0, 1, 0]) < 0.1);
});

test('classifyUrl returns on-task for close embeddings', async () => {
  configureEmbeddingProviderForTesting({
    async embedTexts(texts) {
      return texts.map((text) =>
        text.includes('calculus')
          ? [1, 0, 0]
          : text.includes('lecture')
            ? [0.93, 0.07, 0]
            : [0.2, 0.3, 0.5],
      );
    },
  });

  const result = await classifyUrl(
    'https://example.edu/calculus',
    'Calculus lecture notes',
    'Study calculus',
  );

  assert.equal(result, 'on-task');
});

test('classifyUrl returns off-task for clearly unrelated embeddings', async () => {
  configureEmbeddingProviderForTesting({
    async embedTexts(texts) {
      return texts.map((text) =>
        text.includes('calculus')
          ? [1, 0, 0]
          : text.includes('instagram')
            ? [0, 1, 0]
            : [0.1, 0.2, 0.7],
      );
    },
  });

  const result = await classifyUrl(
    'https://example.com/reels',
    'Instagram reels',
    'Study calculus',
  );

  assert.equal(result, 'off-task');
});

test('classifyUrl falls back to heuristics when embeddings fail', async () => {
  configureEmbeddingProviderForTesting({
    async embedTexts() {
      throw new Error('boom');
    },
  });

  const result = await classifyUrl(
    'https://github.com/tensorflow/tfjs',
    'TensorFlow.js repository',
    'Ship extension ml',
  );

  assert.equal(result, 'on-task');
});

test('classifyUrl falls back to ambiguous for invalid URLs', async () => {
  configureEmbeddingProviderForTesting({
    async embedTexts() {
      throw new Error('boom');
    },
  });

  const result = await classifyUrl('chrome://extensions', 'Extensions', 'Study calculus');
  assert.equal(result, 'ambiguous');
});

test('heuristic classifier still blocks known distractions', () => {
  assert.equal(
    heuristicClassifyUrl('https://www.reddit.com/r/typescript', 'TypeScript post', 'Study calculus'),
    'off-task',
  );
});

test.afterEach(() => {
  configureEmbeddingProviderForTesting(null);
  clearClassificationCaches();
});

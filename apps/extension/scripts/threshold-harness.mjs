/**
 * Threshold calibration harness for MiniLM-L6-v2 cosine similarity.
 *
 * Runs every labeled pair from threshold-pairs.ts through the real model
 * and outputs a score distribution table + threshold suggestions.
 *
 * Usage:
 *   node apps/extension/scripts/threshold-harness.mjs
 *   node apps/extension/scripts/threshold-harness.mjs src/__tests__/threshold-pairs-expanded.ts THRESHOLD_PAIRS_EXPANDED
 *
 * First run downloads ~23MB model from HuggingFace Hub.
 * Subsequent runs use the cached model in ~/.cache/huggingface/.
 */

import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { compileExtensionTests, extensionRoot, testBuildRoot } from './common.mjs';

const [, , pairSourceArg, pairExportArg] = process.argv;
const pairSource = pairSourceArg ?? 'src/__tests__/threshold-pairs.ts';
const pairExport = pairExportArg ?? 'THRESHOLD_PAIRS';

function toCompiledPairModulePath(sourcePath) {
  const normalized = sourcePath.replace(/\\/g, '/');
  const relativeSource = normalized.startsWith('apps/extension/src/')
    ? normalized.slice('apps/extension/'.length)
    : normalized;
  if (!relativeSource.startsWith('src/')) {
    throw new Error(`Pair source must be under apps/extension/src; got "${sourcePath}"`);
  }
  return resolve(testBuildRoot, relativeSource.slice('src/'.length).replace(/\.ts$/, '.js'));
}

console.log('Compiling TypeScript...');
const require_ = createRequire(import.meta.url);
compileExtensionTests();

const pairModulePath = toCompiledPairModulePath(pairSource);
const pairModule = require_(pairModulePath);
const THRESHOLD_PAIRS = pairModule[pairExport];
if (!Array.isArray(THRESHOLD_PAIRS)) {
  throw new Error(`Export "${pairExport}" was not found or is not an array in ${pairSource}`);
}
const { normalizeText, cosineSimilarity, classifyCosineScore, ML_THRESHOLDS, ML_BORDERLINE_WINDOW } = require_(
  resolve(testBuildRoot, 'lib/ml-helpers.js'),
);
const { buildNormalizedPageContext } = require_(resolve(testBuildRoot, 'lib/page-context.js'));

console.log(`Using pair source: ${pairSource} (${pairExport}, ${THRESHOLD_PAIRS.length} pairs)`);

console.log('Loading MiniLM-L6-v2 model (first run downloads ~23MB)...');
const { pipeline } = await import('@huggingface/transformers');
const pipe = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
console.log('Model loaded.\n');

async function embed(text) {
  const output = await pipe(text, { pooling: 'mean', normalize: true });
  return Array.from(output.data);
}

const results = [];

for (const pair of THRESHOLD_PAIRS) {
  const goalText = normalizeText(pair.goal);
  const pageContext = buildNormalizedPageContext({
    title: pair.pageTitle,
    url: pair.pageUrl,
  });

  const [goalEmb, pageEmb] = await Promise.all([embed(goalText), embed(pageContext)]);
  const score = cosineSimilarity(goalEmb, pageEmb);
  const currentClassification = classifyCosineScore(score);

  results.push({
    goal: pair.goal,
    pageTitle: pair.pageTitle,
    pageContext,
    expectedLabel: pair.expectedLabel,
    category: pair.category,
    score,
    currentClassification,
    note: pair.note,
  });
}

function truncate(str, len) {
  return str.length > len ? str.slice(0, len - 1) + '…' : str;
}

function isCorrect(expected, actual) {
  if (expected === 'borderline') return actual === 'ambiguous';
  return expected === actual;
}

console.log('═'.repeat(130));
console.log(
  'Goal'.padEnd(32) +
    'Page Context'.padEnd(40) +
    'Expected'.padEnd(12) +
    'Score'.padEnd(8) +
    'Got'.padEnd(12) +
    'Cat'.padEnd(12) +
    'OK?',
);
console.log('─'.repeat(130));

for (const r of results) {
  const ok = isCorrect(r.expectedLabel, r.currentClassification);
  console.log(
    truncate(r.goal, 30).padEnd(32) +
      truncate(r.pageContext, 38).padEnd(40) +
      r.expectedLabel.padEnd(12) +
      r.score.toFixed(4).padStart(6).padEnd(8) +
      r.currentClassification.padEnd(12) +
      r.category.padEnd(12) +
      (ok ? 'Y' : '*** N ***'),
  );
}

console.log('═'.repeat(130));

function stats(scores) {
  if (scores.length === 0) return { min: NaN, max: NaN, mean: NaN, median: NaN };
  const sorted = [...scores].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return {
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: sum / sorted.length,
    median,
    count: sorted.length,
  };
}

const groups = { 'on-task': [], 'off-task': [], borderline: [] };
for (const r of results) {
  groups[r.expectedLabel].push(r.score);
}

console.log('\nScore distribution by expected label:');
console.log('─'.repeat(70));
for (const [label, scores] of Object.entries(groups)) {
  const s = stats(scores);
  console.log(
    `  ${label.padEnd(12)} n=${String(s.count).padEnd(3)} min=${s.min.toFixed(4)}  max=${s.max.toFixed(4)}  mean=${s.mean.toFixed(4)}  median=${s.median.toFixed(4)}`,
  );
}

console.log(`\nCurrent thresholds: onTask=${ML_THRESHOLDS.onTask}  offTask=${ML_THRESHOLDS.offTask}  borderlineWindow=${ML_BORDERLINE_WINDOW}`);

const misclassified = results.filter((r) => !isCorrect(r.expectedLabel, r.currentClassification));
const clearMisses = misclassified.filter((r) => r.category === 'clear');
const trickyMisses = misclassified.filter((r) => r.category === 'tricky');
const borderlineMisses = misclassified.filter((r) => r.category === 'borderline');

console.log(
  `\nMisclassifications: ${misclassified.length}/${results.length} total  (clear: ${clearMisses.length}, tricky: ${trickyMisses.length}, borderline: ${borderlineMisses.length})`,
);

if (misclassified.length > 0) {
  console.log('\nMisclassified pairs:');
  for (const r of misclassified) {
    console.log(
      `  [${r.category}] "${truncate(r.goal, 30)}" + "${truncate(r.pageTitle, 40)}"  score=${r.score.toFixed(4)}  expected=${r.expectedLabel}  got=${r.currentClassification}`,
    );
    if (r.note) console.log(`    note: ${r.note}`);
  }
}

console.log('\n' + '═'.repeat(70));
console.log('Threshold suggestion analysis');
console.log('─'.repeat(70));

const onTaskScores = groups['on-task'];
const offTaskScores = groups['off-task'];
const borderlineScores = groups.borderline;

const onTaskMin = Math.min(...onTaskScores);
const offTaskMax = Math.max(...offTaskScores);
const borderlineMin = borderlineScores.length > 0 ? Math.min(...borderlineScores) : NaN;
const borderlineMax = borderlineScores.length > 0 ? Math.max(...borderlineScores) : NaN;

console.log(`  on-task scores range:    [${onTaskMin.toFixed(4)} .. ${Math.max(...onTaskScores).toFixed(4)}]`);
console.log(`  off-task scores range:   [${Math.min(...offTaskScores).toFixed(4)} .. ${offTaskMax.toFixed(4)}]`);
console.log(`  borderline scores range: [${borderlineMin.toFixed(4)} .. ${borderlineMax.toFixed(4)}]`);

const suggestedOnTask = !isNaN(borderlineMax)
  ? Number(((borderlineMax + onTaskMin) / 2).toFixed(2))
  : Number(((offTaskMax + onTaskMin) / 2).toFixed(2));

const suggestedOffTask = !isNaN(borderlineMin)
  ? Number(((offTaskMax + borderlineMin) / 2).toFixed(2))
  : Number(((offTaskMax + onTaskMin) / 2).toFixed(2));

const ambiguousBandWidth = suggestedOnTask - suggestedOffTask;
const suggestedWindow = Math.max(0.03, Number((ambiguousBandWidth / 4).toFixed(2)));

console.log(`\n  Suggested thresholds:`);
console.log(`    onTask:          ${suggestedOnTask}`);
console.log(`    offTask:         ${suggestedOffTask}`);
console.log(`    borderlineWindow: ${suggestedWindow}`);

function classifyWithThresholds(score, onTask, offTask) {
  if (score >= onTask) return 'on-task';
  if (score <= offTask) return 'off-task';
  return 'ambiguous';
}

const suggestedMisses = results.filter((r) => {
  const cls = classifyWithThresholds(r.score, suggestedOnTask, suggestedOffTask);
  return !isCorrect(r.expectedLabel, cls);
});

console.log(
  `\n  With suggested thresholds: ${suggestedMisses.length}/${results.length} misclassifications`,
);
if (suggestedMisses.length > 0) {
  for (const r of suggestedMisses) {
    const cls = classifyWithThresholds(r.score, suggestedOnTask, suggestedOffTask);
    console.log(
      `    [${r.category}] score=${r.score.toFixed(4)}  expected=${r.expectedLabel}  got=${cls}  "${truncate(r.pageTitle, 40)}"`,
    );
  }
}

console.log('\n' + '═'.repeat(70));
console.log('Surprising scores (>0.15 deviation from expected band center):');
console.log('─'.repeat(70));

const bandCenters = { 'on-task': 0.7, 'off-task': 0.2, borderline: 0.45 };
const surpriseThreshold = 0.15;

let hasSurprises = false;
for (const r of results) {
  const center = bandCenters[r.expectedLabel];
  const deviation = Math.abs(r.score - center);
  if (deviation > surpriseThreshold) {
    hasSurprises = true;
    console.log(
      `  ${r.score.toFixed(4)} (expected ~${center.toFixed(1)}, off by ${deviation.toFixed(2)}) "${truncate(r.goal, 25)}" + "${truncate(r.pageTitle, 35)}"`,
    );
    if (r.note) console.log(`    note: ${r.note}`);
  }
}
if (!hasSurprises) {
  console.log('  None — all scores within expected bands.');
}

console.log('\nDone.');

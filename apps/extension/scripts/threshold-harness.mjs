/**
 * Threshold calibration harness for MiniLM-L6-v2 cosine similarity.
 *
 * Runs every labeled pair from threshold-pairs.ts through the real model
 * and outputs a score distribution table + threshold suggestions.
 *
 * Usage: node apps/extension/scripts/threshold-harness.mjs
 *
 * First run downloads ~23MB model from HuggingFace Hub.
 * Subsequent runs use the cached model in ~/.cache/huggingface/.
 */

import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const extensionRoot = resolve(__dirname, '..');
const repoRoot = resolve(extensionRoot, '..', '..');
const testBuild = resolve(extensionRoot, '.test-build');

// ── Step 0: Compile TypeScript ─────────────────────────────────
console.log('Compiling TypeScript...');
const require_ = createRequire(import.meta.url);
const tscBin = require_.resolve('typescript/lib/tsc.js');
const tscResult = spawnSync(process.execPath, [tscBin, '-p', resolve(extensionRoot, 'tsconfig.tests.json')], {
  cwd: repoRoot,
  stdio: 'inherit',
});
if (tscResult.status !== 0) {
  console.error('TypeScript compilation failed.');
  process.exit(1);
}

// ── Step 1: Load compiled modules via CJS interop ──────────────
const { THRESHOLD_PAIRS } = require_(resolve(testBuild, '__tests__/threshold-pairs.js'));
const { normalizeText, cosineSimilarity, classifyCosineScore, ML_THRESHOLDS, ML_BORDERLINE_WINDOW } = require_(
  resolve(testBuild, 'lib/ml-helpers.js'),
);
const { buildNormalizedPageContext } = require_(resolve(testBuild, 'lib/page-signals.js'));

// ── Step 2: Load MiniLM-L6-v2 pipeline ─────────────────────────
console.log('Loading MiniLM-L6-v2 model (first run downloads ~23MB)...');
const { pipeline } = await import('@huggingface/transformers');
const pipe = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
console.log('Model loaded.\n');

// ── Step 3: Score every pair ───────────────────────────────────
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

// ── Step 4: Output formatted table ─────────────────────────────
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

// ── Step 5: Per-label statistics ───────────────────────────────
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

// ── Step 6: Misclassification analysis ─────────────────────────
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

// ── Step 7: Threshold suggestions ──────────────────────────────
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

// Suggest onTask threshold: midpoint between borderlineMax and onTaskMin
const suggestedOnTask = !isNaN(borderlineMax)
  ? Number(((borderlineMax + onTaskMin) / 2).toFixed(2))
  : Number(((offTaskMax + onTaskMin) / 2).toFixed(2));

// Suggest offTask threshold: midpoint between offTaskMax and borderlineMin
const suggestedOffTask = !isNaN(borderlineMin)
  ? Number(((offTaskMax + borderlineMin) / 2).toFixed(2))
  : Number(((offTaskMax + onTaskMin) / 2).toFixed(2));

// Borderline window: half the ambiguous band, min 0.03
const ambiguousBandWidth = suggestedOnTask - suggestedOffTask;
const suggestedWindow = Math.max(0.03, Number((ambiguousBandWidth / 4).toFixed(2)));

console.log(`\n  Suggested thresholds:`);
console.log(`    onTask:          ${suggestedOnTask}`);
console.log(`    offTask:         ${suggestedOffTask}`);
console.log(`    borderlineWindow: ${suggestedWindow}`);

// Rerun classification with suggested thresholds
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

// ── Step 8: Surprising scores ──────────────────────────────────
console.log('\n' + '═'.repeat(70));
console.log('Surprising scores (>0.15 deviation from expected band center):');
console.log('─'.repeat(70));

// Expected band centers: on-task ~0.7, off-task ~0.2, borderline ~0.45
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

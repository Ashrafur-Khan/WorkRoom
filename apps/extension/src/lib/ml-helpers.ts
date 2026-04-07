import type { Classification } from '../types';

const HOSTNAME_STOP_WORDS = new Set([
  'www',
  'com',
  'org',
  'net',
  'edu',
  'gov',
  'app',
  'io',
  'co',
  'dev',
]);

// Thresholds calibrated 2026-04-07 against 43 labeled (goal, title+URL) pairs
// spanning 5 goal types via apps/extension/scripts/threshold-harness.mjs.
//
// Score distribution (Stage 1: title + hostname tokens only):
//   on-task  (n=19): min=0.02  median=0.42  max=0.93
//   off-task (n=17): min=-0.09 median=0.08  max=0.13 (clear), 0.49 (tricky keyword overlap)
//   borderline (n=7): min=0.11  median=0.20  max=0.42
//
// Clear on/off-task pairs separate cleanly (gap: 0.31–0.13 = 0.18).
// Tricky off-task pairs with keyword overlap (e.g. "r/biology" vs "biology exam")
// score 0.43–0.49 and leak into on-task — a Stage 1 limitation that Stage 2
// DOM signals can address. See threshold-harness output for full details.
export const ML_THRESHOLDS = {
  onTask: 0.30,
  offTask: 0.15,
} as const;

export const ML_BORDERLINE_WINDOW = 0.04;

export function normalizeText(input: string): string {
  return input
    .toLowerCase()
    .replace(/https?:\/\//g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractHostnameTokens(url: string): string[] {
  const hostname = new URL(url).hostname.toLowerCase();
  return hostname
    .split(/[.-]/g)
    .map((token) => token.trim())
    .filter((token) => token.length > 1 && !HOSTNAME_STOP_WORDS.has(token));
}

export function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || right.length === 0 || left.length !== right.length) {
    return 0;
  }

  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;

  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftMagnitude += left[index] * left[index];
    rightMagnitude += right[index] * right[index];
  }

  const denominator = Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude);
  return denominator === 0 ? 0 : dot / denominator;
}

export function classifyCosineScore(score: number): Classification {
  if (score >= ML_THRESHOLDS.onTask) {
    return 'on-task';
  }

  if (score <= ML_THRESHOLDS.offTask) {
    return 'off-task';
  }

  return 'ambiguous';
}

export function isBorderlineClassification(score: number, classification: Classification): boolean {
  if (classification === 'ambiguous') {
    return true;
  }

  if (classification === 'on-task') {
    return score < ML_THRESHOLDS.onTask + ML_BORDERLINE_WINDOW;
  }

  return score > ML_THRESHOLDS.offTask - ML_BORDERLINE_WINDOW;
}

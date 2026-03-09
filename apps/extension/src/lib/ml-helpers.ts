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

export const ML_THRESHOLDS = {
  onTask: 0.57,
  offTask: 0.32,
} as const;

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

export function buildPageContext(url: string, title: string): string {
  const normalizedTitle = normalizeText(title);
  const hostnameTokens = extractHostnameTokens(url);

  return [normalizedTitle, hostnameTokens.join(' ')].filter(Boolean).join(' ').trim();
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

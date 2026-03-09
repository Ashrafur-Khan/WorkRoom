import type { Classification } from '../types';
import { buildPageContext, classifyCosineScore, cosineSimilarity, normalizeText } from './ml-helpers';

type EmbeddingProvider = {
  embedTexts(texts: string[]): Promise<number[][]>;
};

const USER_BLOCKLIST: string[] = [];
const USER_ALLOWLIST: string[] = [];

const DISTRACTIONS = [
  'instagram.com',
  'facebook.com',
  'twitter.com',
  'tiktok.com',
  'reddit.com',
  'netflix.com',
  'twitch.tv',
  'youtube.com',
];

const PRODUCTIVE = [
  'github.com',
  'stackoverflow.com',
  'wikipedia.org',
  'arxiv.org',
  'scholar.google.com',
  'coursera.org',
  'notion.so',
  'docs.google.com',
];

const goalEmbeddingCache = new Map<string, number[]>();
const pageEmbeddingCache = new Map<string, number[]>();

let modelManagerPromise: Promise<typeof import('./model-manager')> | null = null;
let embeddingProvider: EmbeddingProvider = {
  async embedTexts(texts: string[]) {
    if (!modelManagerPromise) {
      modelManagerPromise = import('./model-manager');
    }

    const { embedTexts } = await modelManagerPromise;
    return embedTexts(texts);
  },
};

function resolveDomain(url: string): string {
  return new URL(url).hostname.toLowerCase();
}

function getBlocklistOverride(domain: string): Classification | null {
  if (USER_BLOCKLIST.some((entry) => domain.includes(entry))) {
    return 'off-task';
  }

  if (USER_ALLOWLIST.some((entry) => domain.includes(entry))) {
    return 'on-task';
  }

  return null;
}

async function getCachedEmbedding(cache: Map<string, number[]>, key: string, text: string): Promise<number[]> {
  const cached = cache.get(key);

  if (cached) {
    return cached;
  }

  const [embedding] = await embeddingProvider.embedTexts([text]);

  if (!embedding) {
    throw new Error(`No embedding returned for key: ${key}`);
  }

  cache.set(key, embedding);
  return embedding;
}

function buildFallbackGoalKeywords(goal: string): string[] {
  return normalizeText(goal)
    .split(' ')
    .filter((word) => word.length > 3);
}

export function heuristicClassifyUrl(url: string, title: string, goal: string): Classification {
  try {
    const domain = resolveDomain(url);
    const override = getBlocklistOverride(domain);

    if (override) {
      return override;
    }

    if (DISTRACTIONS.some((entry) => domain.includes(entry))) {
      return 'off-task';
    }

    if (PRODUCTIVE.some((entry) => domain.includes(entry))) {
      return 'on-task';
    }

    const goalKeywords = buildFallbackGoalKeywords(goal);
    const normalizedTitle = normalizeText(title);
    const matches = goalKeywords.filter((word) => normalizedTitle.includes(word)).length;

    return matches >= 1 ? 'on-task' : 'ambiguous';
  } catch {
    return 'ambiguous';
  }
}

export async function classifyUrl(url: string, title: string, goal: string): Promise<Classification> {
  try {
    const domain = resolveDomain(url);
    const override = getBlocklistOverride(domain);

    if (override) {
      return override;
    }

    const normalizedGoal = normalizeText(goal);
    const pageContext = buildPageContext(url, title);

    if (!normalizedGoal || !pageContext) {
      return heuristicClassifyUrl(url, title, goal);
    }

    const goalEmbedding = await getCachedEmbedding(goalEmbeddingCache, normalizedGoal, normalizedGoal);
    const pageCacheKey = `${domain}|${pageContext}`;
    const pageEmbedding = await getCachedEmbedding(pageEmbeddingCache, pageCacheKey, pageContext);

    return classifyCosineScore(cosineSimilarity(goalEmbedding, pageEmbedding));
  } catch (error) {
    console.warn('[WorkRoom] Falling back to heuristic classifier.', error);
    return heuristicClassifyUrl(url, title, goal);
  }
}

export function clearClassificationCaches(): void {
  goalEmbeddingCache.clear();
  pageEmbeddingCache.clear();
}

export function configureEmbeddingProviderForTesting(provider: EmbeddingProvider | null): void {
  modelManagerPromise = null;
  embeddingProvider = provider ?? {
    async embedTexts(texts: string[]) {
      if (!modelManagerPromise) {
        modelManagerPromise = import('./model-manager');
      }

      const { embedTexts } = await modelManagerPromise;
      return embedTexts(texts);
    },
  };
  clearClassificationCaches();
}

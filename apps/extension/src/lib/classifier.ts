import type { Classification, DebugLogEntry } from '../types';
import { normalizeText } from './ml-helpers';
import { requestMlClassification } from './offscreen-client';

type MlClassifierDependencies = {
  appendDebugLog: (entry: DebugLogEntry) => Promise<void> | void;
  requestMlClassification: typeof requestMlClassification;
};

const USER_BLOCKLIST: string[] = [];
const USER_ALLOWLIST: string[] = [];

const DISTRACTIONS = [
  'instagram.com',
  'facebook.com',
  'twitter.com',
  'tiktok.com',
  'netflix.com',
  'twitch.tv',
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

const defaultDependencies: MlClassifierDependencies = {
  appendDebugLog: async () => undefined,
  requestMlClassification,
};

function createDebugEntry(
  status: string,
  partial: Omit<DebugLogEntry, 'source' | 'status' | 'timestamp'> = {},
): DebugLogEntry {
  return {
    ...partial,
    source: 'bg',
    status,
    timestamp: Date.now(),
  };
}

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

export async function classifyUrl(
  url: string,
  title: string,
  goal: string,
  context: { requestId: string; tabId?: number },
  dependencies: MlClassifierDependencies = defaultDependencies,
): Promise<Classification> {
  try {
    const domain = resolveDomain(url);
    const override = getBlocklistOverride(domain);

    if (override) {
      return override;
    }

    const mlResult = await dependencies.requestMlClassification(
      {
        goal,
        requestId: context.requestId,
        tabId: context.tabId,
        title,
        url,
      },
      dependencies.appendDebugLog,
    );

    if (mlResult.modelState === 'fallback') {
      await dependencies.appendDebugLog(
        createDebugEntry('classification-fallback', {
          backend: mlResult.backend,
          error: mlResult.error,
          requestId: context.requestId,
          tabId: context.tabId,
        }),
      );

      console.warn('[WorkRoom:bg] ML classification fell back to heuristic classifier.', {
        backend: mlResult.backend,
        error: mlResult.error,
        requestId: context.requestId,
        tabId: context.tabId,
      });

      return heuristicClassifyUrl(url, title, goal);
    }

    return mlResult.classification;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    await dependencies.appendDebugLog(
      createDebugEntry('classification-fallback', {
        error: message,
        requestId: context.requestId,
        tabId: context.tabId,
      }),
    );

    console.warn('[WorkRoom:bg] Falling back to heuristic classifier.', {
      error: message,
      requestId: context.requestId,
      tabId: context.tabId,
    });

    return heuristicClassifyUrl(url, title, goal);
  }
}

export function clearClassificationCaches(): void {
  // Background no longer owns ML caches. This remains as a no-op compatibility shim.
}

export function configureEmbeddingProviderForTesting(): void {
  // The classifier now talks to the offscreen runtime. Tests should inject requestMlClassification instead.
}

import type {
  Classification,
  ClassificationRequestContext,
  DebugLogEntry,
  MlClassifyResponse,
} from '../types';
import { getDomainFromUrl } from './session-utilities';
import { normalizeText } from './ml-helpers';

type MlClassifierDependencies = {
  appendDebugLog: (entry: DebugLogEntry) => Promise<void> | void;
  requestMlClassification: (
    context: {
      goal: string;
      title: string;
      url: string;
    } & ClassificationRequestContext,
    appendDebugLog: (entry: DebugLogEntry) => Promise<void> | void,
  ) => Promise<MlClassifyResponse>;
};

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

export type ClassificationDecision = {
  classification: Classification;
  score: number | null;
  source: 'heuristic' | 'ml';
  usedPageSignals: boolean;
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

function buildFallbackGoalKeywords(goal: string): string[] {
  return normalizeText(goal)
    .split(' ')
    .filter((word) => word.length > 3);
}

export function heuristicClassifyUrl(url: string, title: string, goal: string): Classification {
  const domain = getDomainFromUrl(url);

  if (!domain) {
    return 'ambiguous';
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
}

async function appendClassificationFallbackLog(
  appendDebugLog: MlClassifierDependencies['appendDebugLog'],
  error: string,
  context: ClassificationRequestContext,
  backend?: string,
): Promise<void> {
  await appendDebugLog(
    createDebugEntry('classification-fallback', {
      backend,
      error,
      requestId: context.requestId,
      tabId: context.tabId,
    }),
  );
}

export async function classifyUrl(
  url: string,
  title: string,
  goal: string,
  context: ClassificationRequestContext,
  dependencies: MlClassifierDependencies,
): Promise<ClassificationDecision> {
  try {
    const mlResult = await dependencies.requestMlClassification(
      {
        goal,
        pageSignals: context.pageSignals,
        requestId: context.requestId,
        tabId: context.tabId,
        title,
        url,
      },
      dependencies.appendDebugLog,
    );

    if (mlResult.modelState === 'fallback') {
      await appendClassificationFallbackLog(
        dependencies.appendDebugLog,
        mlResult.error,
        context,
        mlResult.backend,
      );

      console.warn('[WorkRoom:bg] ML classification fell back to heuristic classifier.', {
        backend: mlResult.backend,
        error: mlResult.error,
        requestId: context.requestId,
        tabId: context.tabId,
      });

      return {
        classification: heuristicClassifyUrl(url, title, goal),
        score: null,
        source: 'heuristic',
        usedPageSignals: Boolean(context.pageSignals),
      };
    }

    return {
      classification: mlResult.classification,
      score: mlResult.score,
      source: 'ml',
      usedPageSignals: Boolean(context.pageSignals),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    await appendClassificationFallbackLog(dependencies.appendDebugLog, message, context);

    console.warn('[WorkRoom:bg] Falling back to heuristic classifier.', {
      error: message,
      requestId: context.requestId,
      tabId: context.tabId,
    });

    return {
      classification: heuristicClassifyUrl(url, title, goal),
      score: null,
      source: 'heuristic',
      usedPageSignals: Boolean(context.pageSignals),
    };
  }
}

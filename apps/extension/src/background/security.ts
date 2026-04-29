import type { ClassificationDecision } from '../lib/classifier';
import { createSignalSnapshot, hasMeaningfulPageSignals } from '../lib/page-context';
import { isBorderlineClassification } from '../lib/ml-helpers';
import {
  getDomainFromUrl,
  resolveSessionOverride as resolveDomainOverride,
  writeSessionState,
  safeParseUrl,
} from '../lib/session-utilities';
import type {
  BlockPageMessage,
  ClassificationRequestContext,
  DebugLogEntry,
  DebugMetadata,
  ExtractPageSignalsMessage,
  ExtractPageSignalsResponse,
  PageSignals,
  RunningSessionState,
  SessionState,
} from '../types';

type ActionApi = Pick<typeof chrome.action, 'setBadgeBackgroundColor' | 'setBadgeText'>;
type TabsApi = Pick<typeof chrome.tabs, 'get' | 'query' | 'sendMessage'>;
type ScriptingApi = Pick<typeof chrome.scripting, 'executeScript' | 'insertCSS'>;
type StorageApi = Pick<typeof chrome.storage.local, 'set'>;

type ClassifyFn = (
  url: string,
  title: string,
  goal: string,
  context: ClassificationRequestContext,
) => Promise<ClassificationDecision>;

type MessageSendResult<T> =
  | {
      recovered: boolean;
      response: T;
      status: 'sent';
    }
  | {
      error: string;
      recovered: boolean;
      status: 'failed' | 'restricted';
    };

const CONTENT_SCRIPT_FILE = 'src/content/index.js';
const CONTENT_STYLE_FILE = 'assets/content.css';
const SIGNAL_EXTRACTION_TIMEOUT_MS = 200;
const BADGE_TEXT = {
  ambiguous: '',
  offTask: 'BAD',
  onTask: 'GOOD',
} as const;
const BADGE_COLOR = {
  offTask: '#FF0000',
  onTask: '#00FF00',
} as const;

class TimeoutError extends Error {}

type SecurityCheckDependencies = {
  actionApi: ActionApi;
  appendDebugLog: (entry: DebugLogEntry) => Promise<void> | void;
  classify: ClassifyFn;
  scriptingApi: ScriptingApi;
  storageApi: StorageApi;
  tabsApi: TabsApi;
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

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingReceiverError(message: string): boolean {
  return (
    message.includes('Receiving end does not exist') ||
    message.includes('Could not establish connection')
  );
}

function isInjectableUrl(url: string): boolean {
  const parsedUrl = safeParseUrl(url);
  return parsedUrl !== null && ['http:', 'https:', 'file:'].includes(parsedUrl.protocol);
}

function isExtractPageSignalsResponse(value: unknown): value is ExtractPageSignalsResponse {
  if (!value || typeof value !== 'object' || typeof (value as { ok?: unknown }).ok !== 'boolean') {
    return false;
  }

  if ((value as { ok: boolean }).ok) {
    return typeof (value as { signals?: unknown }).signals === 'object' && (value as { signals?: unknown }).signals !== null;
  }

  return typeof (value as { reason?: unknown }).reason === 'string';
}

async function sendMessageWithContentScriptRecovery<T>(
  dependencies: SecurityCheckDependencies,
  tabId: number,
  url: string,
  message: BlockPageMessage | ExtractPageSignalsMessage,
  options: { insertCss: boolean },
): Promise<MessageSendResult<T>> {
  const attempt = async (): Promise<MessageSendResult<T>> => {
    const response = await dependencies.tabsApi.sendMessage(tabId, message) as T;
    return { recovered: false, response, status: 'sent' };
  };

  try {
    return await attempt();
  } catch (error) {
    const deliveryError = getErrorMessage(error);

    if (!isMissingReceiverError(deliveryError)) {
      return { error: deliveryError, recovered: false, status: 'failed' };
    }

    if (!isInjectableUrl(url)) {
      return { error: deliveryError, recovered: false, status: 'restricted' };
    }

    try {
      if (options.insertCss) {
        await dependencies.scriptingApi.insertCSS({
          files: [CONTENT_STYLE_FILE],
          target: { tabId },
        });
      }

      await dependencies.scriptingApi.executeScript({
        files: [CONTENT_SCRIPT_FILE],
        target: { tabId },
      });

      const response = await dependencies.tabsApi.sendMessage(tabId, message) as T;
      return { recovered: true, response, status: 'sent' };
    } catch (retryError) {
      return {
        error: getErrorMessage(retryError),
        recovered: true,
        status: 'failed',
      };
    }
  }
}

function applyBadgeState(
  actionApi: ActionApi,
  tabId: number,
  classification: ClassificationDecision['classification'],
): void {
  if (classification === 'on-task') {
    actionApi.setBadgeText({ text: BADGE_TEXT.onTask, tabId });
    actionApi.setBadgeBackgroundColor({ color: BADGE_COLOR.onTask, tabId });
    return;
  }

  if (classification === 'off-task') {
    actionApi.setBadgeText({ text: BADGE_TEXT.offTask, tabId });
    actionApi.setBadgeBackgroundColor({ color: BADGE_COLOR.offTask, tabId });
    return;
  }

  actionApi.setBadgeText({ text: BADGE_TEXT.ambiguous, tabId });
}

async function deliverBlockMessage(
  dependencies: SecurityCheckDependencies,
  tabId: number,
  url: string,
  goal: string,
  requestId: string,
): Promise<void> {
  const message: BlockPageMessage = {
    payload: { goal },
    type: 'BLOCK_PAGE',
  };
  const result = await sendMessageWithContentScriptRecovery<void>(dependencies, tabId, url, message, { insertCss: true });

  if (result.status === 'sent') {
    if (result.recovered) {
      await dependencies.appendDebugLog(
        createDebugEntry('block-message-recovered', {
          metadata: {
            strategy: 'reinject-content-script',
            url,
          },
          requestId,
          tabId,
        }),
      );
    }
    return;
  }

  const metadata: DebugMetadata = result.status === 'restricted'
    ? { reason: 'restricted-url', url }
    : {
        reason: result.recovered ? 'reinject-failed' : 'send-message-failed',
        url,
      };

  await dependencies.appendDebugLog(
    createDebugEntry(result.status === 'restricted' ? 'block-message-skipped' : 'block-message-failed', {
      error: result.error,
      metadata,
      requestId,
      tabId,
    }),
  );

  if (result.status === 'restricted') {
    console.warn('[WorkRoom:bg] Block message skipped because tab is not script-injectable.', {
      requestId,
      tabId,
      url,
    });
    return;
  }

  console.error('[WorkRoom:bg] Could not recover block message delivery.', {
    error: result.error,
    requestId,
    tabId,
    url,
  });
}

async function applyClassificationResult(
  dependencies: SecurityCheckDependencies,
  tabId: number,
  url: string,
  classification: ClassificationDecision['classification'],
  goal: string,
  requestId: string,
): Promise<void> {
  applyBadgeState(dependencies.actionApi, tabId, classification);

  if (classification === 'off-task') {
    await deliverBlockMessage(dependencies, tabId, url, goal, requestId);
  }

  await dependencies.appendDebugLog(
    createDebugEntry('classification-complete', {
      metadata: { classification },
      requestId,
      tabId,
    }),
  );
}

function shouldRequestPageSignals(decision: ClassificationDecision): boolean {
  if (decision.usedPageSignals || decision.source !== 'ml' || decision.score === null) {
    return false;
  }

  return isBorderlineClassification(decision.score, decision.classification);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new TimeoutError(`Timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    void promise.then(
      (value) => {
        clearTimeout(timeoutId);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeoutId);
        reject(error);
      },
    );
  });
}

async function requestPageSignals(
  dependencies: SecurityCheckDependencies,
  tabId: number,
  url: string,
  requestId: string,
): Promise<PageSignals | null> {
  const message: ExtractPageSignalsMessage = { type: 'EXTRACT_PAGE_SIGNALS' };

  await dependencies.appendDebugLog(
    createDebugEntry('signal-extraction-started', {
      metadata: { timeoutMs: SIGNAL_EXTRACTION_TIMEOUT_MS, url },
      requestId,
      tabId,
    }),
  );

  const attemptExtraction = async () =>
    withTimeout(
      sendMessageWithContentScriptRecovery<unknown>(dependencies, tabId, url, message, { insertCss: false }),
      SIGNAL_EXTRACTION_TIMEOUT_MS,
    );

  try {
    const result = await attemptExtraction();

    if (result.status !== 'sent') {
      await dependencies.appendDebugLog(
        createDebugEntry('signal-extraction-fallback', {
          error: result.error,
          metadata: {
            reason: result.status === 'restricted'
              ? 'restricted-url'
              : result.recovered
                ? 'reinject-failed'
                : 'send-message-failed',
            url,
          },
          requestId,
          tabId,
        }),
      );
      return null;
    }

    const response = result.response;

    if (!isExtractPageSignalsResponse(response)) {
      await dependencies.appendDebugLog(
        createDebugEntry('signal-extraction-fallback', {
          error: 'Content script returned an invalid signal payload.',
          metadata: {
            reason: result.recovered ? 'reinject-response-failed' : 'content-script-response',
            strategy: result.recovered ? 'reinject-content-script' : null,
            url,
          },
          requestId,
          tabId,
        }),
      );
      return null;
    }

    if (!response.ok) {
      await dependencies.appendDebugLog(
        createDebugEntry('signal-extraction-fallback', {
          error: response.reason,
          metadata: {
            reason: result.recovered ? 'reinject-response-failed' : 'content-script-response',
            strategy: result.recovered ? 'reinject-content-script' : null,
            url,
          },
          requestId,
          tabId,
        }),
      );
      return null;
    }

    if (!hasMeaningfulPageSignals(response.signals)) {
      await dependencies.appendDebugLog(
        createDebugEntry('signal-extraction-fallback', {
          metadata: {
            reason: 'signals-too-sparse',
            strategy: result.recovered ? 'reinject-content-script' : null,
            url,
          },
          requestId,
          tabId,
        }),
      );
      return null;
    }

    await dependencies.appendDebugLog(
      createDebugEntry('signal-extraction-complete', {
        metadata: {
          durationMs: response.signals.durationMs,
          headings: response.signals.signalCounts.headings,
          mainSnippetCount: response.signals.signalCounts.mainSnippetCount,
          mainTextLength: response.signals.signalCounts.mainTextLength,
          pageMarkers: response.signals.signalCounts.pageMarkers,
          pathnameTokens: response.signals.signalCounts.pathnameTokens,
          sectionHints: response.signals.signalCounts.sectionHints,
          strategy: result.recovered ? 'reinject-content-script' : null,
          structuredTypes: response.signals.signalCounts.structuredTypes,
          url,
        },
        requestId,
        signalSnapshot: createSignalSnapshot(response.signals),
        tabId,
      }),
    );
    return response.signals;
  } catch (error) {
    const extractionError = getErrorMessage(error);

    if (error instanceof TimeoutError) {
      await dependencies.appendDebugLog(
        createDebugEntry('signal-extraction-timeout', {
          error: extractionError,
          metadata: { timeoutMs: SIGNAL_EXTRACTION_TIMEOUT_MS, url },
          requestId,
          tabId,
        }),
      );
      return null;
    }

    await dependencies.appendDebugLog(
      createDebugEntry('signal-extraction-fallback', {
        error: extractionError,
        metadata: { reason: 'send-message-failed', url },
        requestId,
        tabId,
      }),
    );
    return null;
  }
}

async function isStaleTab(
  dependencies: SecurityCheckDependencies,
  tabId: number,
  url: string,
  requestId: string,
): Promise<boolean> {
  try {
    const tab = await dependencies.tabsApi.get(tabId);

    if (!tab.url || tab.url !== url) {
      await dependencies.appendDebugLog(
        createDebugEntry('classification-skipped', {
          metadata: {
            currentUrl: tab.url ?? null,
            reason: 'stale-tab',
            url,
          },
          requestId,
          tabId,
        }),
      );
      return true;
    }
  } catch (error) {
    await dependencies.appendDebugLog(
      createDebugEntry('classification-skipped', {
        error: getErrorMessage(error),
        metadata: { reason: 'tab-unavailable', url },
        requestId,
        tabId,
      }),
    );
    return true;
  }

  return false;
}

async function applyOverrideResult(
  dependencies: SecurityCheckDependencies,
  tabId: number,
  requestId: string,
  metadata: DebugMetadata,
): Promise<void> {
  applyBadgeState(dependencies.actionApi, tabId, 'on-task');
  await dependencies.appendDebugLog(
    createDebugEntry('override-applied', {
      metadata,
      requestId,
      tabId,
    }),
  );
}

async function resolveSessionOverride(
  dependencies: SecurityCheckDependencies,
  tabId: number,
  url: string,
  requestId: string,
  state: RunningSessionState,
): Promise<boolean> {
  const domain = getDomainFromUrl(url);

  if (!domain) {
    return false;
  }

  const override = resolveDomainOverride(state, url);

  if (override.status === 'allowed') {
    await applyOverrideResult(dependencies, tabId, requestId, {
      domain,
      reason: 'user-allowed-domain',
      scope: 'session',
    });
    return true;
  }

  if (override.status === 'expired') {
    delete state.snoozedDomains[domain];
    await writeSessionState(state, dependencies.storageApi);
    await dependencies.appendDebugLog(
      createDebugEntry('snooze-expired', {
        metadata: {
          domain,
          expiredAt: override.expiresAt,
        },
        requestId,
        tabId,
      }),
    );
    return false;
  }

  if (override.status === 'snoozed') {
    await applyOverrideResult(dependencies, tabId, requestId, {
      domain,
      expiresAt: override.expiresAt,
      reason: 'domain-snoozed',
      scope: 'temporary',
    });
    return true;
  }

  if (override.status === 'allowed-search-query') {
    await applyOverrideResult(dependencies, tabId, requestId, {
      host: override.serp.host,
      query: override.serp.query,
      reason: 'user-allowed-search-query',
      scope: 'session',
    });
    return true;
  }

  return false;
}

export async function runSecurityCheckForState(
  tabId: number,
  url: string,
  title: string,
  state: SessionState | undefined,
  dependencies: SecurityCheckDependencies,
): Promise<void> {
  if (!state || !state.isRunning) {
    dependencies.actionApi.setBadgeText({ text: BADGE_TEXT.ambiguous, tabId });
    return;
  }

  const requestId = `${tabId}:${Date.now()}`;

  if (await resolveSessionOverride(dependencies, tabId, url, requestId, state)) {
    return;
  }

  const classification = await dependencies.classify(url, title, state.goal, { requestId, tabId });
  let finalDecision = classification;

  if (shouldRequestPageSignals(classification)) {
    const pageSignals = await requestPageSignals(dependencies, tabId, url, requestId);

    if (pageSignals) {
      finalDecision = await dependencies.classify(url, title, state.goal, {
        pageSignals,
        requestId,
        tabId,
      });
    }
  }

  if (await isStaleTab(dependencies, tabId, url, requestId)) {
    return;
  }

  await applyClassificationResult(dependencies, tabId, url, finalDecision.classification, state.goal, requestId);
}

export async function clearBadgesForAllTabs(
  tabsApi: Pick<typeof chrome.tabs, 'query'> = chrome.tabs,
  actionApi: Pick<typeof chrome.action, 'setBadgeText'> = chrome.action,
): Promise<void> {
  const tabs = await tabsApi.query({});

  await Promise.all(
    tabs
      .filter((tab): tab is chrome.tabs.Tab & { id: number } => typeof tab.id === 'number')
      .map((tab) => actionApi.setBadgeText({ text: BADGE_TEXT.ambiguous, tabId: tab.id })),
  );
}

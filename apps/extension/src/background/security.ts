import { getDomainFromUrl } from '../lib/session-utilities';
import { requestMlClassification } from '../lib/offscreen-client';
import { classifyUrl, clearClassificationCaches, type ClassificationDecision } from '../lib/classifier';
import { isBorderlineClassification } from '../lib/ml-helpers';
import { createSignalSnapshot, hasMeaningfulPageSignals } from '../lib/page-signals';
import type { DebugLogEntry, ExtractPageSignalsResponse, PageSignals, RunningSessionState, SessionState } from '../types';

type ActionApi = Pick<typeof chrome.action, 'setBadgeText' | 'setBadgeBackgroundColor'>;
type TabsApi = Pick<typeof chrome.tabs, 'get' | 'sendMessage' | 'query'>;
type ScriptingApi = Pick<typeof chrome.scripting, 'executeScript' | 'insertCSS'>;
type StorageApi = Pick<typeof chrome.storage.local, 'set'>;

const CONTENT_SCRIPT_FILE = 'src/content/index.js';
const CONTENT_STYLE_FILE = 'assets/content.css';
const SIGNAL_EXTRACTION_TIMEOUT_MS = 200;

export type SecurityCheckDependencies = {
  actionApi: ActionApi;
  appendDebugLog: (entry: DebugLogEntry) => Promise<void> | void;
  classify: typeof classifyUrl;
  requestMlClassification: typeof requestMlClassification;
  scriptingApi: ScriptingApi;
  storageApi: StorageApi;
  tabsApi: TabsApi;
};

const defaultDependencies: SecurityCheckDependencies = {
  actionApi: chrome.action,
  appendDebugLog: async () => undefined,
  classify: classifyUrl,
  requestMlClassification,
  scriptingApi: chrome.scripting,
  storageApi: chrome.storage.local,
  tabsApi: chrome.tabs,
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
  try {
    const parsed = new URL(url);
    return ['http:', 'https:', 'file:'].includes(parsed.protocol);
  } catch {
    return false;
  }
}

async function deliverBlockMessage(
  dependencies: SecurityCheckDependencies,
  tabId: number,
  url: string,
  goal: string,
  requestId: string,
): Promise<void> {
  const message = {
    type: 'BLOCK_PAGE' as const,
    payload: { goal },
  };

  try {
    await dependencies.tabsApi.sendMessage(tabId, message);
    return;
  } catch (error) {
    const deliveryError = getErrorMessage(error);

    if (!isMissingReceiverError(deliveryError)) {
      await dependencies.appendDebugLog(
        createDebugEntry('block-message-failed', {
          error: deliveryError,
          metadata: {
            reason: 'send-message-failed',
            url,
          },
          requestId,
          tabId,
        }),
      );
      console.error('[WorkRoom:bg] Could not send block message.', error);
      return;
    }

    if (!isInjectableUrl(url)) {
      await dependencies.appendDebugLog(
        createDebugEntry('block-message-skipped', {
          error: deliveryError,
          metadata: {
            reason: 'restricted-url',
            url,
          },
          requestId,
          tabId,
        }),
      );
      console.warn('[WorkRoom:bg] Block message skipped because tab is not script-injectable.', {
        requestId,
        tabId,
        url,
      });
      return;
    }

    try {
      await dependencies.scriptingApi.insertCSS({
        files: [CONTENT_STYLE_FILE],
        target: { tabId },
      });
      await dependencies.scriptingApi.executeScript({
        files: [CONTENT_SCRIPT_FILE],
        target: { tabId },
      });
      await dependencies.tabsApi.sendMessage(tabId, message);

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
    } catch (retryError) {
      const retryMessage = getErrorMessage(retryError);

      await dependencies.appendDebugLog(
        createDebugEntry('block-message-failed', {
          error: retryMessage,
          metadata: {
            reason: 'reinject-failed',
            url,
          },
          requestId,
          tabId,
        }),
      );
      console.error('[WorkRoom:bg] Could not recover block message delivery.', {
        deliveryError,
        requestId,
        retryError,
        tabId,
        url,
      });
    }
  }
}

async function applyClassificationResult(
  dependencies: SecurityCheckDependencies,
  tabId: number,
  url: string,
  classification: ClassificationDecision['classification'],
  goal: string,
  requestId: string,
): Promise<void> {
  if (classification === 'off-task') {
    dependencies.actionApi.setBadgeText({ text: 'BAD', tabId });
    dependencies.actionApi.setBadgeBackgroundColor({ color: '#FF0000', tabId });
    await deliverBlockMessage(dependencies, tabId, url, goal, requestId);

    await dependencies.appendDebugLog(
      createDebugEntry('classification-complete', {
        metadata: { classification: 'off-task' },
        requestId,
        tabId,
      }),
    );
    return;
  }

  if (classification === 'on-task') {
    dependencies.actionApi.setBadgeText({ text: 'GOOD', tabId });
    dependencies.actionApi.setBadgeBackgroundColor({ color: '#00FF00', tabId });
    await dependencies.appendDebugLog(
      createDebugEntry('classification-complete', {
        metadata: { classification: 'on-task' },
        requestId,
        tabId,
      }),
    );
    return;
  }

  dependencies.actionApi.setBadgeText({ text: '', tabId });
  await dependencies.appendDebugLog(
    createDebugEntry('classification-complete', {
      metadata: { classification: 'ambiguous' },
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
      reject(new Error(`Timed out after ${timeoutMs}ms.`));
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
  const message = { type: 'EXTRACT_PAGE_SIGNALS' as const };

  await dependencies.appendDebugLog(
    createDebugEntry('signal-extraction-started', {
      metadata: { timeoutMs: SIGNAL_EXTRACTION_TIMEOUT_MS, url },
      requestId,
      tabId,
    }),
  );

  const attemptExtraction = async (): Promise<ExtractPageSignalsResponse> =>
    withTimeout(
      dependencies.tabsApi.sendMessage(tabId, message) as Promise<ExtractPageSignalsResponse>,
      SIGNAL_EXTRACTION_TIMEOUT_MS,
    );

  try {
    const response = await attemptExtraction();

    if (!response.ok) {
      await dependencies.appendDebugLog(
        createDebugEntry('signal-extraction-fallback', {
          error: response.reason,
          metadata: { reason: 'content-script-response', url },
          requestId,
          tabId,
        }),
      );
      return null;
    }

    if (!hasMeaningfulPageSignals(response.signals)) {
      await dependencies.appendDebugLog(
        createDebugEntry('signal-extraction-fallback', {
          metadata: { reason: 'signals-too-sparse', url },
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

    if (extractionError.includes('Timed out')) {
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

    if (isMissingReceiverError(extractionError) && !isInjectableUrl(url)) {
      await dependencies.appendDebugLog(
        createDebugEntry('signal-extraction-fallback', {
          error: extractionError,
          metadata: { reason: 'restricted-url', url },
          requestId,
          tabId,
        }),
      );
      return null;
    }

    if (isMissingReceiverError(extractionError) && isInjectableUrl(url)) {
      try {
        await dependencies.scriptingApi.executeScript({
          files: [CONTENT_SCRIPT_FILE],
          target: { tabId },
        });

        const retryResponse = await attemptExtraction();
        if (!retryResponse.ok || !hasMeaningfulPageSignals(retryResponse.signals)) {
          await dependencies.appendDebugLog(
            createDebugEntry('signal-extraction-fallback', {
              error: retryResponse.ok ? undefined : retryResponse.reason,
              metadata: {
                reason: retryResponse.ok ? 'signals-too-sparse' : 'reinject-response-failed',
                strategy: 'reinject-content-script',
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
              durationMs: retryResponse.signals.durationMs,
              headings: retryResponse.signals.signalCounts.headings,
              mainSnippetCount: retryResponse.signals.signalCounts.mainSnippetCount,
              mainTextLength: retryResponse.signals.signalCounts.mainTextLength,
              pageMarkers: retryResponse.signals.signalCounts.pageMarkers,
              pathnameTokens: retryResponse.signals.signalCounts.pathnameTokens,
              sectionHints: retryResponse.signals.signalCounts.sectionHints,
              strategy: 'reinject-content-script',
              structuredTypes: retryResponse.signals.signalCounts.structuredTypes,
              url,
            },
            requestId,
            signalSnapshot: createSignalSnapshot(retryResponse.signals),
            tabId,
          }),
        );
        return retryResponse.signals;
      } catch (retryError) {
        await dependencies.appendDebugLog(
          createDebugEntry('signal-extraction-fallback', {
            error: getErrorMessage(retryError),
            metadata: { reason: 'reinject-failed', url },
            requestId,
            tabId,
          }),
        );
        return null;
      }
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
  metadata: Record<string, string | number | boolean | null>,
): Promise<void> {
  dependencies.actionApi.setBadgeText({ text: 'GOOD', tabId });
  dependencies.actionApi.setBadgeBackgroundColor({ color: '#00FF00', tabId });
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

  if (state.allowedDomains.includes(domain)) {
    await applyOverrideResult(dependencies, tabId, requestId, {
      domain,
      reason: 'user-allowed-domain',
      scope: 'session',
    });
    return true;
  }

  const snoozeExpiresAt = state.snoozedDomains[domain];

  if (!snoozeExpiresAt) {
    return false;
  }

  if (snoozeExpiresAt <= Date.now()) {
    delete state.snoozedDomains[domain];
    await dependencies.storageApi.set({ sessionState: state });
    await dependencies.appendDebugLog(
      createDebugEntry('snooze-expired', {
        metadata: {
          domain,
          expiredAt: snoozeExpiresAt,
        },
        requestId,
        tabId,
      }),
    );
    return false;
  }

  await applyOverrideResult(dependencies, tabId, requestId, {
    domain,
    expiresAt: snoozeExpiresAt,
    reason: 'domain-snoozed',
    scope: 'temporary',
  });
  return true;
}

export async function runSecurityCheckForState(
  tabId: number,
  url: string,
  title: string,
  state: SessionState | undefined,
  dependencies: SecurityCheckDependencies = defaultDependencies,
): Promise<void> {
  if (!state || !state.isRunning) {
    dependencies.actionApi.setBadgeText({ text: '', tabId });
    return;
  }

  const requestId = `${tabId}:${Date.now()}`;

  if (await resolveSessionOverride(dependencies, tabId, url, requestId, state)) {
    return;
  }

  const classification = await dependencies.classify(
    url,
    title,
    state.goal,
    { requestId, tabId },
    {
      appendDebugLog: dependencies.appendDebugLog,
      requestMlClassification: dependencies.requestMlClassification,
    },
  );
  let finalDecision = classification;

  if (shouldRequestPageSignals(classification)) {
    const pageSignals = await requestPageSignals(dependencies, tabId, url, requestId);

    if (pageSignals) {
      finalDecision = await dependencies.classify(
        url,
        title,
        state.goal,
        { pageSignals, requestId, tabId },
        {
          appendDebugLog: dependencies.appendDebugLog,
          requestMlClassification: dependencies.requestMlClassification,
        },
      );
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
      .filter((tab) => typeof tab.id === 'number')
      .map((tab) => actionApi.setBadgeText({ text: '', tabId: tab.id! })),
  );
}

export function resetClassifierSessionState(): void {
  clearClassificationCaches();
}

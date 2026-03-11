import { requestMlClassification } from '../lib/offscreen-client';
import { classifyUrl, clearClassificationCaches } from '../lib/classifier';
import type { DebugLogEntry, SessionState } from '../types';

type ActionApi = Pick<typeof chrome.action, 'setBadgeText' | 'setBadgeBackgroundColor'>;
type TabsApi = Pick<typeof chrome.tabs, 'sendMessage' | 'query'>;
type ScriptingApi = Pick<typeof chrome.scripting, 'executeScript' | 'insertCSS'>;

const CONTENT_SCRIPT_FILE = 'src/content/index.js';
const CONTENT_STYLE_FILE = 'assets/content.css';

export type SecurityCheckDependencies = {
  actionApi: ActionApi;
  appendDebugLog: (entry: DebugLogEntry) => Promise<void> | void;
  classify: typeof classifyUrl;
  requestMlClassification: typeof requestMlClassification;
  scriptingApi: ScriptingApi;
  tabsApi: TabsApi;
};

const defaultDependencies: SecurityCheckDependencies = {
  actionApi: chrome.action,
  appendDebugLog: async () => undefined,
  classify: classifyUrl,
  requestMlClassification,
  scriptingApi: chrome.scripting,
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
  classification: 'on-task' | 'off-task' | 'ambiguous',
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
  await applyClassificationResult(dependencies, tabId, url, classification, state.goal, requestId);
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

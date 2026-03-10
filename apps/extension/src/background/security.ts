import { requestMlClassification } from '../lib/offscreen-client';
import { classifyUrl, clearClassificationCaches } from '../lib/classifier';
import type { DebugLogEntry, SessionState } from '../types';

type ActionApi = Pick<typeof chrome.action, 'setBadgeText' | 'setBadgeBackgroundColor'>;
type TabsApi = Pick<typeof chrome.tabs, 'sendMessage' | 'query'>;

export type SecurityCheckDependencies = {
  actionApi: ActionApi;
  appendDebugLog: (entry: DebugLogEntry) => Promise<void> | void;
  classify: typeof classifyUrl;
  requestMlClassification: typeof requestMlClassification;
  tabsApi: TabsApi;
};

const defaultDependencies: SecurityCheckDependencies = {
  actionApi: chrome.action,
  appendDebugLog: async () => undefined,
  classify: classifyUrl,
  requestMlClassification,
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

async function applyClassificationResult(
  dependencies: SecurityCheckDependencies,
  tabId: number,
  classification: 'on-task' | 'off-task' | 'ambiguous',
  goal: string,
  requestId: string,
): Promise<void> {
  if (classification === 'off-task') {
    dependencies.actionApi.setBadgeText({ text: 'BAD', tabId });
    dependencies.actionApi.setBadgeBackgroundColor({ color: '#FF0000', tabId });

    try {
      await dependencies.tabsApi.sendMessage(tabId, {
        type: 'BLOCK_PAGE',
        payload: { goal },
      });
    } catch (error) {
      console.error('[WorkRoom:bg] Could not send block message.', error);
    }

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
  await applyClassificationResult(dependencies, tabId, classification, state.goal, requestId);
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

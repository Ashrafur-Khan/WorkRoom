import { classifyUrl, clearClassificationCaches } from '../lib/classifier';
import type { Classification, SessionState } from '../types';

type ActionApi = Pick<typeof chrome.action, 'setBadgeText' | 'setBadgeBackgroundColor'>;
type TabsApi = Pick<typeof chrome.tabs, 'sendMessage' | 'query'>;

export type SecurityCheckDependencies = {
  actionApi: ActionApi;
  classify: typeof classifyUrl;
  tabsApi: TabsApi;
};

const defaultDependencies: SecurityCheckDependencies = {
  actionApi: chrome.action,
  classify: classifyUrl,
  tabsApi: chrome.tabs,
};

async function applyClassificationResult(
  dependencies: SecurityCheckDependencies,
  tabId: number,
  classification: Classification,
  goal: string,
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
      console.error('[WorkRoom] Could not send block message.', error);
    }

    return;
  }

  if (classification === 'on-task') {
    dependencies.actionApi.setBadgeText({ text: 'GOOD', tabId });
    dependencies.actionApi.setBadgeBackgroundColor({ color: '#00FF00', tabId });
    return;
  }

  dependencies.actionApi.setBadgeText({ text: '', tabId });
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

  const classification = await dependencies.classify(url, title, state.goal);
  await applyClassificationResult(dependencies, tabId, classification, state.goal);
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

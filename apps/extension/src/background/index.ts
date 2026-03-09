import { createIdleState } from '../lib/session-utilities';
import { ALARM_NAME } from '../lib/constants';
import type { SessionState } from '../types';
import { clearBadgesForAllTabs, resetClassifierSessionState, runSecurityCheckForState } from './security';

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) {
    return;
  }

  console.log('[WorkRoom] Alarm fired! Ending session.');

  const result = await chrome.storage.local.get('sessionState');
  const state = result.sessionState as SessionState | undefined;
  const goal = state && 'goal' in state ? state.goal : undefined;

  await chrome.storage.local.set({ sessionState: createIdleState() });
  resetClassifierSessionState();
  await clearBadgesForAllTabs();

  chrome.notifications.create(
    {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('workicon.png'),
      title: 'Session Complete',
      message: goal ? `Great job! You focused on: ${goal}` : 'Session finished!',
      priority: 2,
    },
    (notificationId) => {
      if (chrome.runtime.lastError) {
        console.error('[WorkRoom] Notification failed:', chrome.runtime.lastError);
      } else {
        console.log('[WorkRoom] Notification sent. ID:', notificationId);
      }
    },
  );

  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });

  if (tabs.length > 0 && tabs[0].id) {
    try {
      await chrome.tabs.sendMessage(tabs[0].id, {
        type: 'SESSION_COMPLETE',
        payload: {
          message: goal ? `Great job! You finished: ${goal}` : 'Session Done!',
        },
      });
    } catch {
      console.log('[WorkRoom] Could not send in-page notification.');
    }
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url && tab.title) {
    await runSecurityCheck(tabId, tab.url, tab.title);
  }
});

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  const tab = await chrome.tabs.get(activeInfo.tabId);

  if (tab.url && tab.title) {
    await runSecurityCheck(tab.id!, tab.url, tab.title);
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'START_SESSION') {
    resetClassifierSessionState();
    void sweepAllTabs();
  }

  if (message.type === 'STOP_SESSION') {
    resetClassifierSessionState();
    void clearBadgesForAllTabs();
  }
});

async function runSecurityCheck(tabId: number, url: string, title: string): Promise<void> {
  const result = await chrome.storage.local.get('sessionState');
  const state = result.sessionState as SessionState | undefined;

  await runSecurityCheckForState(tabId, url, title, state);
}

async function sweepAllTabs(): Promise<void> {
  const tabs = await chrome.tabs.query({});

  await Promise.all(
    tabs
      .filter((tab) => tab.id && tab.url && tab.title)
      .map((tab) => runSecurityCheck(tab.id!, tab.url!, tab.title!)),
  );
}

import { createIdleState } from '../lib/session-utilities';
import { ALARM_NAME } from '../lib/constants';
import { classifyUrl } from '../lib/classifier';
import { closeOffscreenDocument, requestMlClassification } from '../lib/offscreen-client';
import type { DebugLogEntry, SessionState } from '../types';
import { appendDebugLog, getDebugLogs } from './debug-log';
import { clearBadgesForAllTabs, resetClassifierSessionState, runSecurityCheckForState } from './security';

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

function log(status: string, metadata: Record<string, unknown> = {}): void {
  console.log('[WorkRoom:bg]', status, metadata);
}

async function endSession(goal?: string): Promise<void> {
  await chrome.storage.local.set({ sessionState: createIdleState() });
  resetClassifierSessionState();
  await clearBadgesForAllTabs();
  await closeOffscreenDocument(appendDebugLog);

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
        console.error('[WorkRoom:bg] Notification failed:', chrome.runtime.lastError);
      } else {
        log('notification-sent', { notificationId });
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
      log('session-complete-message-skipped');
    }
  }
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) {
    return;
  }

  const result = await chrome.storage.local.get('sessionState');
  const state = result.sessionState as SessionState | undefined;
  const goal = state && 'goal' in state ? state.goal : undefined;

  await appendDebugLog(createDebugEntry('session-alarm-fired'));
  log('session-alarm-fired', { goal });
  await endSession(goal);
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

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'START_SESSION') {
    resetClassifierSessionState();
    void appendDebugLog(createDebugEntry('session-started'));
    void sweepAllTabs();
    return false;
  }

  if (message.type === 'STOP_SESSION') {
    void (async () => {
      await appendDebugLog(createDebugEntry('session-stopped'));
      await closeOffscreenDocument(appendDebugLog);
      resetClassifierSessionState();
      await clearBadgesForAllTabs();
    })();
    return false;
  }

  if (message.type === 'ML_DEBUG_EVENT') {
    void appendDebugLog(message.payload as DebugLogEntry);
    return false;
  }

  if (message.type === 'GET_DEBUG_LOGS') {
    void (async () => {
      sendResponse(await getDebugLogs());
    })();
    return true;
  }

  return false;
});

async function runSecurityCheck(tabId: number, url: string, title: string): Promise<void> {
  const result = await chrome.storage.local.get('sessionState');
  const state = result.sessionState as SessionState | undefined;

  await runSecurityCheckForState(tabId, url, title, state, {
    actionApi: chrome.action,
    appendDebugLog,
    classify: (targetUrl, targetTitle, goal, context) => classifyUrlWithLogging(targetUrl, targetTitle, goal, context),
    requestMlClassification,
    scriptingApi: chrome.scripting,
    tabsApi: chrome.tabs,
  });
}

async function classifyUrlWithLogging(
  url: string,
  title: string,
  goal: string,
  context: { requestId: string; tabId?: number },
) {
  const result = await classifyUrl(url, title, goal, context, {
    appendDebugLog,
    requestMlClassification,
  });

  log('classification-finished', {
    requestId: context.requestId,
    tabId: context.tabId,
    url,
  });

  return result;
}

async function sweepAllTabs(): Promise<void> {
  const tabs = await chrome.tabs.query({});

  await Promise.all(
    tabs
      .filter((tab) => tab.id && tab.url && tab.title)
      .map((tab) => runSecurityCheck(tab.id!, tab.url!, tab.title!)),
  );
}

import { createIdleState, getDomainFromUrl, normalizeSessionState } from '../lib/session-utilities';
import { ALARM_NAME } from '../lib/constants';
import { classifyUrl } from '../lib/classifier';
import { closeOffscreenDocument, requestMlClassification } from '../lib/offscreen-client';
import type { DebugLogEntry, PageSignals, RunningSessionState, SessionState } from '../types';
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

async function getNormalizedSessionState(): Promise<SessionState> {
  const result = await chrome.storage.local.get('sessionState');
  const normalized = normalizeSessionState(result.sessionState as SessionState | undefined);

  if (normalized.changed) {
    await chrome.storage.local.set({ sessionState: normalized.state });
  }

  return normalized.state;
}

async function refreshTabsForDomain(domain: string): Promise<void> {
  const tabs = await chrome.tabs.query({});

  await Promise.all(
    tabs.map(async (tab) => {
      if (!tab.id || !tab.url || getDomainFromUrl(tab.url) !== domain) {
        return;
      }

      try {
        await chrome.tabs.sendMessage(tab.id, { type: 'UNBLOCK_PAGE' });
      } catch {
        log('unblock-message-skipped', { domain, tabId: tab.id });
      }

      if (tab.title) {
        await runSecurityCheck(tab.id, tab.url, tab.title);
      }
    }),
  );
}

async function updateRunningSessionState(
  mutate: (
    state: RunningSessionState,
  ) => { debugStatus: string; metadata: Record<string, string | number | boolean | null> } | null,
): Promise<{ metadata?: Record<string, string | number | boolean | null>; ok: boolean }> {
  const currentState = await getNormalizedSessionState();

  if (!currentState.isRunning) {
    return { ok: false };
  }

  const mutation = mutate(currentState);

  if (!mutation) {
    return { ok: false };
  }

  await chrome.storage.local.set({ sessionState: currentState });
  await appendDebugLog(createDebugEntry(mutation.debugStatus, { metadata: mutation.metadata }));
  log(mutation.debugStatus, mutation.metadata);

  return { metadata: mutation.metadata, ok: true };
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

  const state = await getNormalizedSessionState();
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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
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

  if (message.type === 'ALLOW_DOMAIN_FOR_SESSION' || message.type === 'SNOOZE_DOMAIN') {
    void (async () => {
      const senderTabId = sender.tab?.id;
      const senderUrl = sender.tab?.url;

      if (!senderTabId || !senderUrl) {
        sendResponse({ ok: false });
        return;
      }

      const domain = getDomainFromUrl(senderUrl);

      if (!domain) {
        sendResponse({ ok: false });
        return;
      }

      const result =
        message.type === 'ALLOW_DOMAIN_FOR_SESSION'
          ? await updateRunningSessionState((state) => {
              if (state.allowedDomains.includes(domain)) {
                return {
                  debugStatus: 'user-marked-allowed-domain',
                  metadata: { domain, scope: 'session', wasDuplicate: true },
                };
              }

              state.allowedDomains.push(domain);
              delete state.snoozedDomains[domain];
              return {
                debugStatus: 'user-marked-allowed-domain',
                metadata: { domain, scope: 'session', wasDuplicate: false },
              };
            })
          : await updateRunningSessionState((state) => {
              const durationMinutes = Number(message.payload?.durationMinutes);

              if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) {
                return null;
              }

              state.snoozedDomains[domain] = Date.now() + durationMinutes * 60 * 1000;
              return {
                debugStatus: 'domain-snoozed',
                metadata: { domain, durationMinutes, scope: 'domain' },
              };
            });

      if (!result.ok) {
        sendResponse({ ok: false });
        return;
      }

      await refreshTabsForDomain(domain);
      sendResponse({ metadata: result.metadata, ok: true });
    })();

    return true;
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
  const state = await getNormalizedSessionState();

  await runSecurityCheckForState(tabId, url, title, state, {
    actionApi: chrome.action,
    appendDebugLog,
    classify: (targetUrl, targetTitle, goal, context) => classifyUrlWithLogging(targetUrl, targetTitle, goal, context),
    requestMlClassification,
    scriptingApi: chrome.scripting,
    storageApi: chrome.storage.local,
    tabsApi: chrome.tabs,
  });
}

async function classifyUrlWithLogging(
  url: string,
  title: string,
  goal: string,
  context: { pageSignals?: PageSignals; requestId: string; tabId?: number },
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

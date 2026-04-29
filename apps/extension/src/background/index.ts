import { ALARM_NAME } from '../lib/constants';
import { classifyUrl } from '../lib/classifier';
import { requestMlClassification, closeOffscreenDocument } from '../lib/offscreen-client';
import {
  allowDomainForSession,
  allowSearchQueryForSession,
  createIdleState,
  detectSearchEngineQuery,
  getDomainFromUrl,
  readSessionState,
  snoozeDomainForSession,
  writeSessionState,
} from '../lib/session-utilities';
import type {
  AllowDomainForSessionMessage,
  ClassificationRequestContext,
  DebugLogEntry,
  DebugMetadata,
  RuntimeMessage,
  SessionMutationResponse,
  SnoozeDomainMessage,
} from '../types';
import { appendDebugLog, getDebugLogs, isDebugLogEntry } from './debug-log';
import { clearBadgesForAllTabs, runSecurityCheckForState } from './security';

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

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRuntimeMessage(value: unknown): value is RuntimeMessage {
  return typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string';
}

function isTabWithIdentity(tab: chrome.tabs.Tab): tab is chrome.tabs.Tab & { id: number; title: string; url: string } {
  return typeof tab.id === 'number' && typeof tab.url === 'string' && typeof tab.title === 'string';
}

function isAllowDomainForSessionMessage(message: RuntimeMessage): message is AllowDomainForSessionMessage {
  return message.type === 'ALLOW_DOMAIN_FOR_SESSION';
}

function isSnoozeDomainMessage(message: RuntimeMessage): message is SnoozeDomainMessage {
  return (
    message.type === 'SNOOZE_DOMAIN' &&
    typeof message.payload?.durationMinutes === 'number' &&
    Number.isFinite(message.payload.durationMinutes)
  );
}

async function readNormalizedSessionState() {
  return readSessionState(chrome.storage.local);
}

async function sendUnblockMessage(tabId: number, metadata: Record<string, unknown>): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'UNBLOCK_PAGE' });
  } catch (error) {
    log('unblock-message-skipped', {
      ...metadata,
      error: getErrorMessage(error),
      tabId,
    });
  }
}

async function refreshTabsForDomain(domain: string): Promise<void> {
  const tabs = await chrome.tabs.query({});

  await Promise.all(
    tabs.map(async (tab) => {
      if (!isTabWithIdentity(tab) || getDomainFromUrl(tab.url) !== domain) {
        return;
      }

      await sendUnblockMessage(tab.id, { domain });
      await runSecurityCheck(tab.id, tab.url, tab.title);
    }),
  );
}

async function unblockAllTabs(): Promise<void> {
  const tabs = await chrome.tabs.query({});

  await Promise.all(
    tabs
      .filter((tab): tab is chrome.tabs.Tab & { id: number } => typeof tab.id === 'number')
      .map((tab) => sendUnblockMessage(tab.id, {})),
  );
}

async function updateRunningSessionState(
  mutate: (state: Extract<Awaited<ReturnType<typeof readNormalizedSessionState>>, { isRunning: true }>) =>
    | { debugStatus: string; metadata: DebugMetadata }
    | null,
): Promise<SessionMutationResponse> {
  const currentState = await readNormalizedSessionState();

  if (!currentState.isRunning) {
    return { ok: false };
  }

  const mutation = mutate(currentState);

  if (!mutation) {
    return { ok: false };
  }

  await writeSessionState(currentState, chrome.storage.local);
  await appendDebugLog(createDebugEntry(mutation.debugStatus, { metadata: mutation.metadata }));
  log(mutation.debugStatus, mutation.metadata);

  return { metadata: mutation.metadata, ok: true };
}

async function teardownSessionState(): Promise<void> {
  await writeSessionState(createIdleState(), chrome.storage.local);
  await clearBadgesForAllTabs();
  await unblockAllTabs();
  await closeOffscreenDocument(appendDebugLog);
}

function sendSessionCompleteNotification(goal?: string): void {
  chrome.notifications.create(
    {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('workicon.png'),
      message: goal ? `Great job! You focused on: ${goal}` : 'Session finished!',
      priority: 2,
      title: 'Session Complete',
    },
    (notificationId) => {
      if (chrome.runtime.lastError) {
        console.error('[WorkRoom:bg] Notification failed:', chrome.runtime.lastError);
      } else {
        log('notification-sent', { notificationId });
      }
    },
  );
}

async function sendSessionCompleteMessage(goal?: string): Promise<void> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const activeTab = tabs.find((tab): tab is chrome.tabs.Tab & { id: number } => typeof tab.id === 'number');

  if (!activeTab) {
    return;
  }

  try {
    await chrome.tabs.sendMessage(activeTab.id, {
      payload: {
        message: goal ? `Great job! You finished: ${goal}` : 'Session Done!',
      },
      type: 'SESSION_COMPLETE',
    });
  } catch (error) {
    log('session-complete-message-skipped', { error: getErrorMessage(error) });
  }
}

async function endSession(goal?: string): Promise<void> {
  await teardownSessionState();
  sendSessionCompleteNotification(goal);
  await sendSessionCompleteMessage(goal);
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) {
    return;
  }

  const state = await readNormalizedSessionState();
  const goal = state.isRunning ? state.goal : undefined;

  await appendDebugLog(createDebugEntry('session-alarm-fired'));
  log('session-alarm-fired', { goal });
  await endSession(goal);
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && typeof tab.url === 'string' && typeof tab.title === 'string') {
    await runSecurityCheck(tabId, tab.url, tab.title);
  }
});

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  const tab = await chrome.tabs.get(activeInfo.tabId);

  if (isTabWithIdentity(tab)) {
    await runSecurityCheck(tab.id, tab.url, tab.title);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!isRuntimeMessage(message)) {
    return false;
  }

  if (message.type === 'START_SESSION') {
    void appendDebugLog(createDebugEntry('session-started'));
    void sweepAllTabs();
    return false;
  }

  if (message.type === 'STOP_SESSION') {
    void (async () => {
      await appendDebugLog(createDebugEntry('session-stopped'));
      await teardownSessionState();
    })();
    return false;
  }

  if (message.type === 'ML_DEBUG_EVENT') {
    void (async () => {
      if (isDebugLogEntry(message.payload)) {
        await appendDebugLog(message.payload);
      } else {
        await appendDebugLog(
          createDebugEntry('invalid-debug-event', {
            error: 'Received malformed debug event payload.',
          }),
        );
      }
    })();
    return false;
  }

  if (isAllowDomainForSessionMessage(message) || isSnoozeDomainMessage(message)) {
    void (async () => {
      const senderTabId = sender.tab?.id;
      const senderUrl = sender.tab?.url;

      if (typeof senderTabId !== 'number' || typeof senderUrl !== 'string') {
        sendResponse({ ok: false } satisfies SessionMutationResponse);
        return;
      }

      const domain = getDomainFromUrl(senderUrl);

      if (!domain) {
        sendResponse({ ok: false } satisfies SessionMutationResponse);
        return;
      }

      const serp = isAllowDomainForSessionMessage(message)
        ? detectSearchEngineQuery(senderUrl)
        : null;

      const result = isAllowDomainForSessionMessage(message)
        ? await updateRunningSessionState((state) => {
            if (serp) {
              const { wasDuplicate } = allowSearchQueryForSession(state, serp);
              const metadata: DebugMetadata = {
                host: serp.host,
                query: serp.query,
                scope: 'session',
                wasDuplicate,
              };
              return { debugStatus: 'user-marked-allowed-search-query', metadata };
            }

            const { wasDuplicate } = allowDomainForSession(state, domain);
            const metadata: DebugMetadata = { domain, scope: 'session', wasDuplicate };
            return { debugStatus: 'user-marked-allowed-domain', metadata };
          })
        : await updateRunningSessionState((state) => {
            const durationMinutes = Number(message.payload.durationMinutes);

            if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) {
              return null;
            }

            snoozeDomainForSession(state, domain, durationMinutes);
            return {
              debugStatus: 'domain-snoozed',
              metadata: { domain, durationMinutes, scope: 'domain' },
            };
          });

      if (!result.ok) {
        sendResponse({ ok: false } satisfies SessionMutationResponse);
        return;
      }

      await refreshTabsForDomain(domain);
      sendResponse(result);
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
  const state = await readNormalizedSessionState();

  await runSecurityCheckForState(tabId, url, title, state, {
    actionApi: chrome.action,
    appendDebugLog,
    classify: (targetUrl, targetTitle, goal, context) => classifyUrlWithLogging(targetUrl, targetTitle, goal, context),
    scriptingApi: chrome.scripting,
    storageApi: chrome.storage.local,
    tabsApi: chrome.tabs,
  });
}

async function classifyUrlWithLogging(
  url: string,
  title: string,
  goal: string,
  context: ClassificationRequestContext,
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
      .filter(isTabWithIdentity)
      .map((tab) => runSecurityCheck(tab.id, tab.url, tab.title)),
  );
}

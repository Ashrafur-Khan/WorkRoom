const test = require('node:test');
const assert = require('node:assert/strict');

const BACKGROUND_MODULE_PATH = '../.test-build/background/index.js';

function createRunningState() {
  return {
    allowedDomains: [],
    durationMinutes: 25,
    goal: 'Ship WorkRoom',
    isRunning: true,
    snoozedDomains: {},
    startTime: Date.now(),
  };
}

function flushAsyncWork() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function loadBackgroundWithChrome(overrides = {}) {
  const listeners = {
    alarm: null,
    runtimeMessage: null,
    tabActivated: null,
    tabUpdated: null,
  };
  const calls = {
    badgeText: [],
    badgeBackground: [],
    notifications: [],
    sentMessages: [],
    storageLocalSet: [],
  };
  const runningState = overrides.runningState ?? createRunningState();
  const allTabs = overrides.allTabs ?? [
    { id: 1, url: 'https://blocked.example.com', title: 'Blocked tab' },
    { id: 2, url: 'https://docs.example.com', title: 'Docs' },
    { url: 'https://no-id.example.com', title: 'No id' },
  ];
  const activeTabs = overrides.activeTabs ?? [
    { id: 1, url: 'https://blocked.example.com', title: 'Blocked tab' },
  ];

  global.chrome = {
    action: {
      setBadgeBackgroundColor(details) {
        calls.badgeBackground.push(details);
      },
      setBadgeText(details) {
        calls.badgeText.push(details);
      },
    },
    alarms: {
      onAlarm: {
        addListener(listener) {
          listeners.alarm = listener;
        },
      },
    },
    notifications: {
      create(options, callback) {
        calls.notifications.push(options);
        callback?.('notification-id');
      },
    },
    runtime: {
      getURL(path) {
        return `chrome-extension://test/${path}`;
      },
      lastError: null,
      onMessage: {
        addListener(listener) {
          listeners.runtimeMessage = listener;
        },
      },
      sendMessage: async () => undefined,
    },
    scripting: {
      executeScript: async () => undefined,
      insertCSS: async () => undefined,
    },
    storage: {
      local: {
        async get(key) {
          if (key === 'sessionState') {
            return { sessionState: runningState };
          }

          return {};
        },
        async set(value) {
          calls.storageLocalSet.push(value);
        },
      },
      session: {
        async get() {
          return {};
        },
        async remove() {
          return undefined;
        },
        async set() {
          return undefined;
        },
      },
    },
    tabs: {
      async get(tabId) {
        return allTabs.find((tab) => tab.id === tabId) ?? { id: tabId, url: 'https://example.com' };
      },
      onActivated: {
        addListener(listener) {
          listeners.tabActivated = listener;
        },
      },
      onUpdated: {
        addListener(listener) {
          listeners.tabUpdated = listener;
        },
      },
      async query(queryInfo) {
        if (queryInfo?.active && queryInfo?.currentWindow) {
          return activeTabs;
        }

        return allTabs;
      },
      async sendMessage(tabId, message) {
        calls.sentMessages.push({ message, tabId });

        if (overrides.sendMessageErrorTabIds?.includes(tabId)) {
          throw new Error('Could not establish connection. Receiving end does not exist.');
        }

        return undefined;
      },
    },
  };

  delete require.cache[require.resolve(BACKGROUND_MODULE_PATH)];
  require(BACKGROUND_MODULE_PATH);

  return { calls, listeners };
}

test('alarm-driven session completion unblocks all tabs and still sends SESSION_COMPLETE only to the active tab', async () => {
  const { calls, listeners } = loadBackgroundWithChrome({
    allTabs: [
      { id: 10, url: 'https://blocked.example.com', title: 'Blocked tab' },
      { id: 11, url: 'https://allowed.example.com', title: 'Allowed tab' },
      { url: 'https://no-id.example.com', title: 'No id' },
    ],
    activeTabs: [
      { id: 10, url: 'https://blocked.example.com', title: 'Blocked tab' },
    ],
    sendMessageErrorTabIds: [11],
  });

  await listeners.alarm({ name: 'WORKROOM_TIMER' });

  const unblockMessages = calls.sentMessages.filter((entry) => entry.message.type === 'UNBLOCK_PAGE');
  const sessionCompleteMessages = calls.sentMessages.filter((entry) => entry.message.type === 'SESSION_COMPLETE');

  assert.deepEqual(
    unblockMessages.map((entry) => entry.tabId),
    [10, 11],
  );
  assert.equal(sessionCompleteMessages.length, 1);
  assert.equal(sessionCompleteMessages[0].tabId, 10);
});

test('manual stop unblocks all tabs and does not send SESSION_COMPLETE', async () => {
  const { calls, listeners } = loadBackgroundWithChrome({
    allTabs: [
      { id: 21, url: 'https://blocked.example.com', title: 'Blocked tab' },
      { id: 22, url: 'https://docs.example.com', title: 'Docs' },
    ],
    activeTabs: [
      { id: 21, url: 'https://blocked.example.com', title: 'Blocked tab' },
    ],
    sendMessageErrorTabIds: [22],
  });

  listeners.runtimeMessage({ type: 'STOP_SESSION' }, {}, () => undefined);
  await flushAsyncWork();

  const unblockMessages = calls.sentMessages.filter((entry) => entry.message.type === 'UNBLOCK_PAGE');
  const sessionCompleteMessages = calls.sentMessages.filter((entry) => entry.message.type === 'SESSION_COMPLETE');

  assert.deepEqual(
    unblockMessages.map((entry) => entry.tabId),
    [21, 22],
  );
  assert.equal(sessionCompleteMessages.length, 0);
});

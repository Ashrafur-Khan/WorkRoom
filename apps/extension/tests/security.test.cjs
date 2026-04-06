const test = require('node:test');
const assert = require('node:assert/strict');

const noop = () => undefined;

global.chrome = {
  action: {
    setBadgeText: noop,
    setBadgeBackgroundColor: noop,
  },
  storage: {
    local: {
      set: async () => undefined,
    },
  },
  scripting: {
    executeScript: async () => undefined,
    insertCSS: async () => undefined,
  },
  tabs: {
    get: async (tabId) => ({ id: tabId, url: 'https://example.com' }),
    query: async () => [],
    sendMessage: async () => undefined,
  },
};

const { runSecurityCheckForState } = require('../.test-build/background/security.js');

function createRunningState() {
  return {
    allowedDomains: [],
    isRunning: true,
    goal: 'Ship WorkRoom',
    snoozedDomains: {},
    durationMinutes: 25,
    startTime: Date.now(),
  };
}

test('runSecurityCheckForState blocks off-task pages', async () => {
  const calls = {
    badgeText: [],
    badgeColor: [],
    debugEntries: [],
    executeScript: [],
    insertCSS: [],
    messages: [],
  };

  await runSecurityCheckForState(
    42,
    'https://example.com',
    'Example',
    createRunningState(),
    {
      appendDebugLog: async (entry) => {
        calls.debugEntries.push(entry);
      },
      classify: async () => ({ classification: 'off-task', score: 0.1, source: 'ml', usedPageSignals: false }),
      requestMlClassification: async () => {
        throw new Error('requestMlClassification should not be called');
      },
      actionApi: {
        setBadgeText(details) {
          calls.badgeText.push(details);
        },
        setBadgeBackgroundColor(details) {
          calls.badgeColor.push(details);
        },
      },
      tabsApi: {
        async get(tabId) {
          return { id: tabId, url: 'https://example.com' };
        },
        async sendMessage(tabId, message) {
          calls.messages.push({ tabId, message });
        },
        async query() {
          return [];
        },
      },
      scriptingApi: {
        async executeScript(details) {
          calls.executeScript.push(details);
        },
        async insertCSS(details) {
          calls.insertCSS.push(details);
        },
      },
      storageApi: {
        async set() {
          throw new Error('storageApi.set should not be called');
        },
      },
    },
  );

  assert.deepEqual(calls.badgeText, [{ text: 'BAD', tabId: 42 }]);
  assert.deepEqual(calls.badgeColor, [{ color: '#FF0000', tabId: 42 }]);
  assert.equal(calls.messages.length, 1);
  assert.deepEqual(calls.insertCSS, []);
  assert.deepEqual(calls.executeScript, []);
  assert.equal(calls.debugEntries.at(-1)?.status, 'classification-complete');
});

test('runSecurityCheckForState reinjects the content script when an off-task tab has no receiver', async () => {
  const calls = {
    badgeText: [],
    badgeColor: [],
    debugEntries: [],
    executeScript: [],
    insertCSS: [],
    messages: [],
  };
  let sendAttempts = 0;

  await runSecurityCheckForState(
    99,
    'https://www.youtube.com/watch?v=abc123',
    'Video',
    createRunningState(),
    {
      appendDebugLog: async (entry) => {
        calls.debugEntries.push(entry);
      },
      classify: async () => ({ classification: 'off-task', score: 0.1, source: 'ml', usedPageSignals: false }),
      requestMlClassification: async () => {
        throw new Error('requestMlClassification should not be called');
      },
      actionApi: {
        setBadgeText(details) {
          calls.badgeText.push(details);
        },
        setBadgeBackgroundColor(details) {
          calls.badgeColor.push(details);
        },
      },
      tabsApi: {
        async get(tabId) {
          return { id: tabId, url: 'https://www.youtube.com/watch?v=abc123' };
        },
        async sendMessage(tabId, message) {
          sendAttempts += 1;
          calls.messages.push({ tabId, message });

          if (sendAttempts === 1) {
            throw new Error('Could not establish connection. Receiving end does not exist.');
          }
        },
        async query() {
          return [];
        },
      },
      scriptingApi: {
        async executeScript(details) {
          calls.executeScript.push(details);
        },
        async insertCSS(details) {
          calls.insertCSS.push(details);
        },
      },
      storageApi: {
        async set() {
          throw new Error('storageApi.set should not be called');
        },
      },
    },
  );

  assert.deepEqual(calls.badgeText, [{ text: 'BAD', tabId: 99 }]);
  assert.deepEqual(calls.badgeColor, [{ color: '#FF0000', tabId: 99 }]);
  assert.equal(calls.messages.length, 2);
  assert.deepEqual(calls.insertCSS, [{ files: ['assets/content.css'], target: { tabId: 99 } }]);
  assert.deepEqual(calls.executeScript, [{ files: ['src/content/index.js'], target: { tabId: 99 } }]);
  assert.equal(calls.debugEntries[0]?.status, 'block-message-recovered');
  assert.equal(calls.debugEntries[0]?.metadata?.strategy, 'reinject-content-script');
  assert.equal(calls.debugEntries.at(-1)?.status, 'classification-complete');
});

test('runSecurityCheckForState does not inject scripts into restricted off-task tabs', async () => {
  const calls = {
    badgeText: [],
    badgeColor: [],
    debugEntries: [],
    executeScript: [],
    insertCSS: [],
    messages: [],
  };

  await runSecurityCheckForState(
    55,
    'chrome://extensions',
    'Extensions',
    createRunningState(),
    {
      appendDebugLog: async (entry) => {
        calls.debugEntries.push(entry);
      },
      classify: async () => ({ classification: 'off-task', score: 0.1, source: 'ml', usedPageSignals: false }),
      requestMlClassification: async () => {
        throw new Error('requestMlClassification should not be called');
      },
      actionApi: {
        setBadgeText(details) {
          calls.badgeText.push(details);
        },
        setBadgeBackgroundColor(details) {
          calls.badgeColor.push(details);
        },
      },
      tabsApi: {
        async get(tabId) {
          return { id: tabId, url: 'chrome://extensions' };
        },
        async sendMessage(tabId, message) {
          calls.messages.push({ tabId, message });
          throw new Error('Could not establish connection. Receiving end does not exist.');
        },
        async query() {
          return [];
        },
      },
      scriptingApi: {
        async executeScript(details) {
          calls.executeScript.push(details);
        },
        async insertCSS(details) {
          calls.insertCSS.push(details);
        },
      },
      storageApi: {
        async set() {
          throw new Error('storageApi.set should not be called');
        },
      },
    },
  );

  assert.deepEqual(calls.badgeText, [{ text: 'BAD', tabId: 55 }]);
  assert.deepEqual(calls.badgeColor, [{ color: '#FF0000', tabId: 55 }]);
  assert.equal(calls.messages.length, 1);
  assert.deepEqual(calls.insertCSS, []);
  assert.deepEqual(calls.executeScript, []);
  assert.equal(calls.debugEntries[0]?.status, 'block-message-skipped');
  assert.equal(calls.debugEntries[0]?.metadata?.reason, 'restricted-url');
  assert.equal(calls.debugEntries.at(-1)?.status, 'classification-complete');
});

test('runSecurityCheckForState marks on-task pages as good', async () => {
  const calls = {
    badgeText: [],
    badgeColor: [],
  };

  await runSecurityCheckForState(
    7,
    'https://example.com',
    'Example',
    createRunningState(),
    {
      appendDebugLog: async () => undefined,
      classify: async () => ({ classification: 'on-task', score: 0.8, source: 'ml', usedPageSignals: false }),
      requestMlClassification: async () => {
        throw new Error('requestMlClassification should not be called');
      },
      actionApi: {
        setBadgeText(details) {
          calls.badgeText.push(details);
        },
        setBadgeBackgroundColor(details) {
          calls.badgeColor.push(details);
        },
      },
      tabsApi: {
        async get(tabId) {
          return { id: tabId, url: 'https://example.com' };
        },
        async sendMessage() {
          throw new Error('sendMessage should not be called');
        },
        async query() {
          return [];
        },
      },
      scriptingApi: {
        async executeScript() {
          throw new Error('executeScript should not be called');
        },
        async insertCSS() {
          throw new Error('insertCSS should not be called');
        },
      },
      storageApi: {
        async set() {
          throw new Error('storageApi.set should not be called');
        },
      },
    },
  );

  assert.deepEqual(calls.badgeText, [{ text: 'GOOD', tabId: 7 }]);
  assert.deepEqual(calls.badgeColor, [{ color: '#00FF00', tabId: 7 }]);
});

test('runSecurityCheckForState clears badge for ambiguous pages', async () => {
  const calls = [];

  await runSecurityCheckForState(
    3,
    'https://example.com',
    'Example',
    createRunningState(),
    {
      appendDebugLog: async () => undefined,
      classify: async () => ({ classification: 'ambiguous', score: 0.45, source: 'ml', usedPageSignals: true }),
      requestMlClassification: async () => {
        throw new Error('requestMlClassification should not be called');
      },
      actionApi: {
        setBadgeText(details) {
          calls.push(details);
        },
        setBadgeBackgroundColor() {
          throw new Error('setBadgeBackgroundColor should not be called');
        },
      },
      tabsApi: {
        async get(tabId) {
          return { id: tabId, url: 'https://example.com' };
        },
        async sendMessage() {
          throw new Error('sendMessage should not be called');
        },
        async query() {
          return [];
        },
      },
      scriptingApi: {
        async executeScript() {
          throw new Error('executeScript should not be called');
        },
        async insertCSS() {
          throw new Error('insertCSS should not be called');
        },
      },
      storageApi: {
        async set() {
          throw new Error('storageApi.set should not be called');
        },
      },
    },
  );

  assert.deepEqual(calls, [{ text: '', tabId: 3 }]);
});

test('runSecurityCheckForState treats allowed domains as on-task overrides', async () => {
  const calls = {
    badgeColor: [],
    badgeText: [],
    classifyCalls: 0,
    debugEntries: [],
  };

  await runSecurityCheckForState(
    17,
    'https://docs.example.com/page',
    'Example',
    {
      ...createRunningState(),
      allowedDomains: ['docs.example.com'],
    },
    {
      appendDebugLog: async (entry) => {
        calls.debugEntries.push(entry);
      },
      classify: async () => {
        calls.classifyCalls += 1;
        return { classification: 'off-task', score: 0.2, source: 'ml', usedPageSignals: false };
      },
      requestMlClassification: async () => {
        throw new Error('requestMlClassification should not be called');
      },
      actionApi: {
        setBadgeText(details) {
          calls.badgeText.push(details);
        },
        setBadgeBackgroundColor(details) {
          calls.badgeColor.push(details);
        },
      },
      tabsApi: {
        async get() {
          throw new Error('get should not be called');
        },
        async sendMessage() {
          throw new Error('sendMessage should not be called');
        },
        async query() {
          return [];
        },
      },
      scriptingApi: {
        async executeScript() {
          throw new Error('executeScript should not be called');
        },
        async insertCSS() {
          throw new Error('insertCSS should not be called');
        },
      },
      storageApi: {
        async set() {
          throw new Error('storageApi.set should not be called');
        },
      },
    },
  );

  assert.equal(calls.classifyCalls, 0);
  assert.deepEqual(calls.badgeText, [{ text: 'GOOD', tabId: 17 }]);
  assert.deepEqual(calls.badgeColor, [{ color: '#00FF00', tabId: 17 }]);
  assert.equal(calls.debugEntries.at(-1)?.status, 'override-applied');
  assert.equal(calls.debugEntries.at(-1)?.metadata?.reason, 'user-allowed-domain');
});

test('runSecurityCheckForState treats active snoozes as on-task overrides', async () => {
  const calls = {
    badgeColor: [],
    badgeText: [],
    classifyCalls: 0,
    debugEntries: [],
  };

  await runSecurityCheckForState(
    18,
    'https://docs.example.com/page',
    'Example',
    {
      ...createRunningState(),
      snoozedDomains: {
        'docs.example.com': Date.now() + 60_000,
      },
    },
    {
      appendDebugLog: async (entry) => {
        calls.debugEntries.push(entry);
      },
      classify: async () => {
        calls.classifyCalls += 1;
        return { classification: 'off-task', score: 0.2, source: 'ml', usedPageSignals: false };
      },
      requestMlClassification: async () => {
        throw new Error('requestMlClassification should not be called');
      },
      actionApi: {
        setBadgeText(details) {
          calls.badgeText.push(details);
        },
        setBadgeBackgroundColor(details) {
          calls.badgeColor.push(details);
        },
      },
      tabsApi: {
        async get() {
          throw new Error('get should not be called');
        },
        async sendMessage() {
          throw new Error('sendMessage should not be called');
        },
        async query() {
          return [];
        },
      },
      scriptingApi: {
        async executeScript() {
          throw new Error('executeScript should not be called');
        },
        async insertCSS() {
          throw new Error('insertCSS should not be called');
        },
      },
      storageApi: {
        async set() {
          throw new Error('storageApi.set should not be called');
        },
      },
    },
  );

  assert.equal(calls.classifyCalls, 0);
  assert.deepEqual(calls.badgeText, [{ text: 'GOOD', tabId: 18 }]);
  assert.deepEqual(calls.badgeColor, [{ color: '#00FF00', tabId: 18 }]);
  assert.equal(calls.debugEntries.at(-1)?.status, 'override-applied');
  assert.equal(calls.debugEntries.at(-1)?.metadata?.reason, 'domain-snoozed');
});

test('runSecurityCheckForState expires snoozes and falls back to classification', async () => {
  const calls = {
    badgeColor: [],
    badgeText: [],
    classifyCalls: 0,
    debugEntries: [],
    storageSet: [],
  };

  await runSecurityCheckForState(
    19,
    'https://docs.example.com/page',
    'Example',
    {
      ...createRunningState(),
      snoozedDomains: {
        'docs.example.com': Date.now() - 1_000,
      },
    },
    {
      appendDebugLog: async (entry) => {
        calls.debugEntries.push(entry);
      },
      classify: async () => {
        calls.classifyCalls += 1;
        return { classification: 'on-task', score: 0.8, source: 'ml', usedPageSignals: false };
      },
      requestMlClassification: async () => {
        throw new Error('requestMlClassification should not be called');
      },
      actionApi: {
        setBadgeText(details) {
          calls.badgeText.push(details);
        },
        setBadgeBackgroundColor(details) {
          calls.badgeColor.push(details);
        },
      },
      tabsApi: {
        async get(tabId) {
          return { id: tabId, url: 'https://docs.example.com/page' };
        },
        async sendMessage() {
          throw new Error('sendMessage should not be called');
        },
        async query() {
          return [];
        },
      },
      scriptingApi: {
        async executeScript() {
          throw new Error('executeScript should not be called');
        },
        async insertCSS() {
          throw new Error('insertCSS should not be called');
        },
      },
      storageApi: {
        async set(details) {
          calls.storageSet.push(details);
        },
      },
    },
  );

  assert.equal(calls.classifyCalls, 1);
  assert.equal(calls.storageSet.length, 1);
  assert.deepEqual(calls.badgeText, [{ text: 'GOOD', tabId: 19 }]);
  assert.deepEqual(calls.badgeColor, [{ color: '#00FF00', tabId: 19 }]);
  assert.equal(calls.debugEntries[0]?.status, 'snooze-expired');
  assert.equal(calls.debugEntries.at(-1)?.status, 'classification-complete');
});

test('runSecurityCheckForState requests richer page signals for borderline classifications', async () => {
  const calls = {
    classifyArgs: [],
    debugEntries: [],
    messages: [],
  };

  await runSecurityCheckForState(
    27,
    'https://example.com/article',
    'Focus article',
    createRunningState(),
    {
      appendDebugLog: async (entry) => {
        calls.debugEntries.push(entry);
      },
      classify: async (url, title, goal, context) => {
        calls.classifyArgs.push({ context, goal, title, url });

        if (context.pageSignals) {
          return { classification: 'on-task', score: 0.71, source: 'ml', usedPageSignals: true };
        }

        return { classification: 'ambiguous', score: 0.45, source: 'ml', usedPageSignals: false };
      },
      requestMlClassification: async () => {
        throw new Error('requestMlClassification should not be called');
      },
      actionApi: {
        setBadgeText() {},
        setBadgeBackgroundColor() {},
      },
      tabsApi: {
        async get(tabId) {
          return { id: tabId, url: 'https://example.com/article' };
        },
        async sendMessage(tabId, message) {
          calls.messages.push({ tabId, message });

          if (message.type === 'EXTRACT_PAGE_SIGNALS') {
            return {
              ok: true,
              signals: {
                appMarkers: ['document-page'],
                durationMs: 12,
                extractedAt: Date.now(),
                headings: ['Focus article'],
                mainTextSnippet: 'A detailed guide to planning focused work.',
                metaDescription: 'Practical focus systems.',
                navLabels: ['Docs'],
                pathnameTokens: ['article'],
                signalCounts: {
                  appMarkers: 1,
                  headings: 1,
                  mainTextLength: 41,
                  navLabels: 1,
                  pathnameTokens: 1,
                },
                title: 'Focus article',
              },
            };
          }

          return undefined;
        },
        async query() {
          return [];
        },
      },
      scriptingApi: {
        async executeScript() {
          throw new Error('executeScript should not be called');
        },
        async insertCSS() {
          throw new Error('insertCSS should not be called');
        },
      },
      storageApi: {
        async set() {
          throw new Error('storageApi.set should not be called');
        },
      },
    },
  );

  assert.equal(calls.classifyArgs.length, 2);
  assert.equal(calls.classifyArgs[0].context.pageSignals, undefined);
  assert.equal(calls.classifyArgs[1].context.pageSignals.title, 'Focus article');
  assert.equal(calls.messages.length, 1);
  assert.equal(calls.messages[0].message.type, 'EXTRACT_PAGE_SIGNALS');
  assert.equal(calls.debugEntries.some((entry) => entry.status === 'signal-extraction-complete'), true);
  assert.equal(calls.debugEntries.find((entry) => entry.status === 'signal-extraction-complete')?.signalSnapshot?.title, 'Focus article');
});

test('runSecurityCheckForState drops stale classification results when the tab navigates', async () => {
  const calls = {
    badgeText: [],
    debugEntries: [],
  };

  await runSecurityCheckForState(
    28,
    'https://example.com/original',
    'Original',
    createRunningState(),
    {
      appendDebugLog: async (entry) => {
        calls.debugEntries.push(entry);
      },
      classify: async () => ({ classification: 'off-task', score: 0.1, source: 'ml', usedPageSignals: false }),
      requestMlClassification: async () => {
        throw new Error('requestMlClassification should not be called');
      },
      actionApi: {
        setBadgeText(details) {
          calls.badgeText.push(details);
        },
        setBadgeBackgroundColor() {
          throw new Error('setBadgeBackgroundColor should not be called');
        },
      },
      tabsApi: {
        async get(tabId) {
          return { id: tabId, url: 'https://example.com/new-location' };
        },
        async sendMessage() {
          throw new Error('sendMessage should not be called');
        },
        async query() {
          return [];
        },
      },
      scriptingApi: {
        async executeScript() {
          throw new Error('executeScript should not be called');
        },
        async insertCSS() {
          throw new Error('insertCSS should not be called');
        },
      },
      storageApi: {
        async set() {
          throw new Error('storageApi.set should not be called');
        },
      },
    },
  );

  assert.deepEqual(calls.badgeText, []);
  assert.equal(calls.debugEntries.at(-1)?.status, 'classification-skipped');
  assert.equal(calls.debugEntries.at(-1)?.metadata?.reason, 'stale-tab');
});

test('runSecurityCheckForState drops classification results when the tab lookup fails', async () => {
  const calls = {
    badgeText: [],
    debugEntries: [],
  };

  await runSecurityCheckForState(
    29,
    'https://example.com/original',
    'Original',
    createRunningState(),
    {
      appendDebugLog: async (entry) => {
        calls.debugEntries.push(entry);
      },
      classify: async () => ({ classification: 'off-task', score: 0.1, source: 'ml', usedPageSignals: false }),
      requestMlClassification: async () => {
        throw new Error('requestMlClassification should not be called');
      },
      actionApi: {
        setBadgeText(details) {
          calls.badgeText.push(details);
        },
        setBadgeBackgroundColor() {
          throw new Error('setBadgeBackgroundColor should not be called');
        },
      },
      tabsApi: {
        async get() {
          throw new Error('Tab was closed');
        },
        async sendMessage() {
          throw new Error('sendMessage should not be called');
        },
        async query() {
          return [];
        },
      },
      scriptingApi: {
        async executeScript() {
          throw new Error('executeScript should not be called');
        },
        async insertCSS() {
          throw new Error('insertCSS should not be called');
        },
      },
      storageApi: {
        async set() {
          throw new Error('storageApi.set should not be called');
        },
      },
    },
  );

  assert.deepEqual(calls.badgeText, []);
  assert.equal(calls.debugEntries.at(-1)?.status, 'classification-skipped');
  assert.equal(calls.debugEntries.at(-1)?.metadata?.reason, 'tab-unavailable');
});

test('runSecurityCheckForState falls back cleanly when restricted pages cannot provide page signals', async () => {
  const calls = {
    debugEntries: [],
    executeScript: [],
    messages: [],
  };

  await runSecurityCheckForState(
    30,
    'chrome://extensions',
    'Extensions',
    createRunningState(),
    {
      appendDebugLog: async (entry) => {
        calls.debugEntries.push(entry);
      },
      classify: async (_url, _title, _goal, context) => {
        if (context.pageSignals) {
          throw new Error('classify should not be retried with page signals on restricted pages');
        }

        return { classification: 'ambiguous', score: 0.45, source: 'ml', usedPageSignals: false };
      },
      requestMlClassification: async () => {
        throw new Error('requestMlClassification should not be called');
      },
      actionApi: {
        setBadgeText() {},
        setBadgeBackgroundColor() {},
      },
      tabsApi: {
        async get(tabId) {
          return { id: tabId, url: 'chrome://extensions' };
        },
        async sendMessage(tabId, message) {
          calls.messages.push({ tabId, message });
          throw new Error('Could not establish connection. Receiving end does not exist.');
        },
        async query() {
          return [];
        },
      },
      scriptingApi: {
        async executeScript(details) {
          calls.executeScript.push(details);
        },
        async insertCSS() {
          throw new Error('insertCSS should not be called');
        },
      },
      storageApi: {
        async set() {
          throw new Error('storageApi.set should not be called');
        },
      },
    },
  );

  assert.equal(calls.messages.length, 1);
  assert.deepEqual(calls.executeScript, []);
  assert.equal(calls.debugEntries.some((entry) => entry.status === 'signal-extraction-fallback'), true);
  assert.equal(
    calls.debugEntries.find((entry) => entry.status === 'signal-extraction-fallback')?.metadata?.reason,
    'restricted-url',
  );
});

test('runSecurityCheckForState falls back to the stage-one decision when page signal extraction times out', async () => {
  const calls = {
    badgeText: [],
    debugEntries: [],
  };

  await runSecurityCheckForState(
    31,
    'https://example.com/article',
    'Focus article',
    createRunningState(),
    {
      appendDebugLog: async (entry) => {
        calls.debugEntries.push(entry);
      },
      classify: async (_url, _title, _goal, context) => {
        if (context.pageSignals) {
          throw new Error('classify should not be retried after a timeout');
        }

        return { classification: 'ambiguous', score: 0.45, source: 'ml', usedPageSignals: false };
      },
      requestMlClassification: async () => {
        throw new Error('requestMlClassification should not be called');
      },
      actionApi: {
        setBadgeText(details) {
          calls.badgeText.push(details);
        },
        setBadgeBackgroundColor() {
          throw new Error('setBadgeBackgroundColor should not be called');
        },
      },
      tabsApi: {
        async get(tabId) {
          return { id: tabId, url: 'https://example.com/article' };
        },
        async sendMessage() {
          return new Promise(() => undefined);
        },
        async query() {
          return [];
        },
      },
      scriptingApi: {
        async executeScript() {
          throw new Error('executeScript should not be called');
        },
        async insertCSS() {
          throw new Error('insertCSS should not be called');
        },
      },
      storageApi: {
        async set() {
          throw new Error('storageApi.set should not be called');
        },
      },
    },
  );

  assert.deepEqual(calls.badgeText, [{ text: '', tabId: 31 }]);
  assert.equal(calls.debugEntries.some((entry) => entry.status === 'signal-extraction-timeout'), true);
  assert.equal(calls.debugEntries.at(-1)?.status, 'classification-complete');
});

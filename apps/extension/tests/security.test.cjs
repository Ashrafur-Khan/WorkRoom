const test = require('node:test');
const assert = require('node:assert/strict');

const noop = () => undefined;

global.chrome = {
  action: {
    setBadgeText: noop,
    setBadgeBackgroundColor: noop,
  },
  scripting: {
    executeScript: async () => undefined,
    insertCSS: async () => undefined,
  },
  tabs: {
    query: async () => [],
    sendMessage: async () => undefined,
  },
};

const { runSecurityCheckForState } = require('../.test-build/background/security.js');

function createRunningState() {
  return {
    isRunning: true,
    goal: 'Ship WorkRoom',
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
      classify: async () => 'off-task',
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
      classify: async () => 'off-task',
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
      classify: async () => 'off-task',
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
      classify: async () => 'on-task',
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
      classify: async () => 'ambiguous',
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
    },
  );

  assert.deepEqual(calls, [{ text: '', tabId: 3 }]);
});

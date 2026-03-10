const test = require('node:test');
const assert = require('node:assert/strict');

const noop = () => undefined;

global.chrome = {
  action: {
    setBadgeText: noop,
    setBadgeBackgroundColor: noop,
  },
  tabs: {
    query: async () => [],
    sendMessage: async () => undefined,
  },
};

const { runSecurityCheckForState } = require('../.test-build/background/security.js');

test('runSecurityCheckForState blocks off-task pages', async () => {
  const calls = {
    badgeText: [],
    badgeColor: [],
    messages: [],
  };

  await runSecurityCheckForState(
    42,
    'https://example.com',
    'Example',
    {
      isRunning: true,
      goal: 'Ship WorkRoom',
      durationMinutes: 25,
      startTime: Date.now(),
    },
    {
      appendDebugLog: async () => undefined,
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
    },
  );

  assert.deepEqual(calls.badgeText, [{ text: 'BAD', tabId: 42 }]);
  assert.deepEqual(calls.badgeColor, [{ color: '#FF0000', tabId: 42 }]);
  assert.equal(calls.messages.length, 1);
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
    {
      isRunning: true,
      goal: 'Ship WorkRoom',
      durationMinutes: 25,
      startTime: Date.now(),
    },
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
    {
      isRunning: true,
      goal: 'Ship WorkRoom',
      durationMinutes: 25,
      startTime: Date.now(),
    },
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
    },
  );

  assert.deepEqual(calls, [{ text: '', tabId: 3 }]);
});

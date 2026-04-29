const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createRunningState,
  normalizeSessionState,
  readSessionState,
} = require('../.test-build/lib/session-utilities.js');
const {
  appendDebugLog,
  getDebugLogs,
} = require('../.test-build/background/debug-log.js');

test('readSessionState preserves a valid running session without rewriting it', async () => {
  const storedState = createRunningState('Ship WorkRoom', 25, 1234567890);
  storedState.allowedDomains.push('docs.example.com');
  storedState.snoozedDomains['news.example.com'] = 1234567999;

  const writes = [];
  const storageApi = {
    async get() {
      return { sessionState: storedState };
    },
    async set(value) {
      writes.push(value);
    },
  };

  const result = await readSessionState(storageApi);

  assert.deepEqual(result, storedState);
  assert.deepEqual(writes, []);
});

test('normalizeSessionState rewrites malformed running-session fields to a valid shape', () => {
  const normalized = normalizeSessionState({
    allowedDomains: ['docs.example.com', 123, null],
    durationMinutes: 25,
    goal: 'Ship WorkRoom',
    isRunning: true,
    snoozedDomains: {
      'focus.example.com': 1234,
      'noise.example.com': 'bad',
    },
    startTime: 1000,
  });

  assert.equal(normalized.changed, true);
  assert.deepEqual(normalized.state, {
    allowedDomains: ['docs.example.com'],
    durationMinutes: 25,
    goal: 'Ship WorkRoom',
    isRunning: true,
    snoozedDomains: {
      'focus.example.com': 1234,
    },
    startTime: 1000,
  });
});

test('getDebugLogs drops malformed stored entries and writes back the normalized list', async () => {
  const validEntry = {
    source: 'bg',
    status: 'session-started',
    timestamp: 123,
  };
  const writes = [];
  const storageApi = {
    async get() {
      return {
        debugLogEntries: [
          validEntry,
          { source: 'bad', status: 42, timestamp: 'oops' },
        ],
      };
    },
    async set(value) {
      writes.push(value);
    },
  };

  const logs = await getDebugLogs(storageApi);

  assert.deepEqual(logs, [validEntry]);
  assert.deepEqual(writes, [{ debugLogEntries: [validEntry] }]);
});

test('appendDebugLog appends after normalizing malformed stored entries', async () => {
  const validEntry = {
    source: 'bg',
    status: 'session-started',
    timestamp: 123,
  };
  const nextEntry = {
    source: 'offscreen',
    status: 'model-ready',
    timestamp: 456,
  };
  const writes = [];
  const storageApi = {
    async get() {
      return {
        debugLogEntries: [validEntry, { status: 'bad-entry' }],
      };
    },
    async set(value) {
      writes.push(value);
    },
  };

  await appendDebugLog(nextEntry, storageApi);

  assert.deepEqual(writes, [{
    debugLogEntries: [validEntry, nextEntry],
  }]);
});

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  allowDomainForSession,
  allowSearchQueryForSession,
  createRunningState,
  detectSearchEngineQuery,
  normalizeSessionState,
  readSessionState,
  resolveSessionOverride,
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
    allowedSearchQueries: [],
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

test('detectSearchEngineQuery recognises every configured engine and normalizes the query', () => {
  const cases = [
    { url: 'https://www.google.com/search?q=React%20Hooks&hl=en', expected: { host: 'www.google.com', query: 'react hooks' } },
    { url: 'https://google.com/search?q=python', expected: { host: 'google.com', query: 'python' } },
    { url: 'https://www.bing.com/search?q=Sourdough', expected: { host: 'www.bing.com', query: 'sourdough' } },
    { url: 'https://duckduckgo.com/?q=ducks+swim', expected: { host: 'duckduckgo.com', query: 'ducks swim' } },
    { url: 'https://search.brave.com/search?q=brave', expected: { host: 'search.brave.com', query: 'brave' } },
    { url: 'https://www.startpage.com/do/search?query=foo', expected: { host: 'www.startpage.com', query: 'foo' } },
    { url: 'https://search.yahoo.com/search?p=yahoo', expected: { host: 'search.yahoo.com', query: 'yahoo' } },
    { url: 'https://www.ecosia.org/search?q=trees', expected: { host: 'www.ecosia.org', query: 'trees' } },
  ];

  for (const { url, expected } of cases) {
    assert.deepEqual(detectSearchEngineQuery(url), expected, `Expected ${url} to detect ${JSON.stringify(expected)}`);
  }
});

test('detectSearchEngineQuery returns null for non-search pages', () => {
  assert.equal(detectSearchEngineQuery('https://www.google.com/maps'), null);
  assert.equal(detectSearchEngineQuery('https://www.google.com/search'), null);
  assert.equal(detectSearchEngineQuery('https://www.google.com/search?q='), null);
  assert.equal(detectSearchEngineQuery('https://news.ycombinator.com/?q=foo'), null);
  assert.equal(detectSearchEngineQuery('not a url'), null);
});

test('allowSearchQueryForSession adds an entry without touching allowedDomains', () => {
  const state = createRunningState('Ship WorkRoom', 25, 1000);

  const result = allowSearchQueryForSession(state, { host: 'www.google.com', query: 'react hooks' });

  assert.equal(result.wasDuplicate, false);
  assert.deepEqual(state.allowedSearchQueries, [{ host: 'www.google.com', query: 'react hooks' }]);
  assert.deepEqual(state.allowedDomains, []);
});

test('allowSearchQueryForSession is idempotent for an existing entry', () => {
  const state = createRunningState('Ship WorkRoom', 25, 1000);
  state.allowedSearchQueries.push({ host: 'www.google.com', query: 'react hooks' });

  const result = allowSearchQueryForSession(state, { host: 'www.google.com', query: 'react hooks' });

  assert.equal(result.wasDuplicate, true);
  assert.equal(state.allowedSearchQueries.length, 1);
});

test('resolveSessionOverride matches a SERP allowance only for that host and query', () => {
  const state = createRunningState('Ship WorkRoom', 25, 1000);
  state.allowedSearchQueries.push({ host: 'www.google.com', query: 'react hooks' });

  assert.deepEqual(
    resolveSessionOverride(state, 'https://www.google.com/search?q=react%20hooks&hl=en'),
    { status: 'allowed-search-query', serp: { host: 'www.google.com', query: 'react hooks' } },
  );
  assert.deepEqual(
    resolveSessionOverride(state, 'https://www.google.com/search?q=celebrity+gossip'),
    { status: 'none' },
  );
  assert.deepEqual(
    resolveSessionOverride(state, 'https://www.google.com/maps'),
    { status: 'none' },
  );
});

test('resolveSessionOverride still recognises full-domain allowances', () => {
  const state = createRunningState('Ship WorkRoom', 25, 1000);
  allowDomainForSession(state, 'docs.example.com');

  assert.deepEqual(
    resolveSessionOverride(state, 'https://docs.example.com/anything'),
    { status: 'allowed' },
  );
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

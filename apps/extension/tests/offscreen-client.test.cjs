const test = require('node:test');
const assert = require('node:assert/strict');

global.chrome = {
  offscreen: {
    Reason: {
      WORKERS: 'WORKERS',
    },
    closeDocument: async () => undefined,
    createDocument: async () => undefined,
  },
  runtime: {
    getContexts: async () => [],
    getURL: (path) => path,
    sendMessage: async () => undefined,
  },
};

const {
  closeOffscreenDocument,
  configureOffscreenClientForTesting,
  ensureOffscreenDocument,
  requestMlClassification,
  resetOffscreenClientForTesting,
} = require('../.test-build/lib/offscreen-client.js');

test.afterEach(() => {
  resetOffscreenClientForTesting();
});

test('ensureOffscreenDocument creates the document once and reports reuse on later calls', async () => {
  const debugEntries = [];
  let exists = false;
  let createCount = 0;

  configureOffscreenClientForTesting({
    createDocument: async () => {
      createCount += 1;
      exists = true;
    },
    hasOffscreenDocument: async () => exists,
  });

  await ensureOffscreenDocument(async (entry) => {
    debugEntries.push(entry);
  });
  await ensureOffscreenDocument(async (entry) => {
    debugEntries.push(entry);
  });

  assert.equal(createCount, 1);
  assert.deepEqual(
    debugEntries.map((entry) => entry.status),
    ['offscreen-created', 'offscreen-reused'],
  );
});

test('closeOffscreenDocument reports a skipped close when no document exists', async () => {
  const debugEntries = [];

  configureOffscreenClientForTesting({
    hasOffscreenDocument: async () => false,
  });

  await closeOffscreenDocument(async (entry) => {
    debugEntries.push(entry);
  });

  assert.equal(debugEntries.at(-1)?.status, 'offscreen-close-skipped');
});

test('closeOffscreenDocument still closes after the offscreen close message fails', async () => {
  const debugEntries = [];
  let exists = true;
  let closeCount = 0;

  configureOffscreenClientForTesting({
    closeDocument: async () => {
      closeCount += 1;
      exists = false;
    },
    hasOffscreenDocument: async () => exists,
    sendRuntimeMessage: async (message) => {
      assert.deepEqual(message, { type: 'ML_OFFSCREEN_CLOSE' });
      throw new Error('close ping failed');
    },
  });

  await closeOffscreenDocument(async (entry) => {
    debugEntries.push(entry);
  });

  assert.equal(closeCount, 1);
  assert.deepEqual(
    debugEntries.map((entry) => entry.status),
    ['offscreen-close-message-failed', 'offscreen-closed'],
  );
  assert.match(debugEntries[0].error, /close ping failed/i);
});

test('requestMlClassification logs and throws when the offscreen document returns no response', async () => {
  const debugEntries = [];
  let exists = false;

  configureOffscreenClientForTesting({
    createDocument: async () => {
      exists = true;
    },
    hasOffscreenDocument: async () => exists,
    sendRuntimeMessage: async (message) => {
      if (message.type === 'ML_CLASSIFY_REQUEST') {
        return undefined;
      }

      return undefined;
    },
  });

  await assert.rejects(
    () =>
      requestMlClassification(
        {
          goal: 'Ship WorkRoom',
          requestId: 'req-no-response',
          title: 'Focus page',
          url: 'https://example.com/focus',
        },
        async (entry) => {
          debugEntries.push(entry);
        },
      ),
    /no response/i,
  );

  assert.equal(debugEntries[0]?.status, 'offscreen-created');
  assert.equal(debugEntries.at(-1)?.status, 'offscreen-response-invalid');
  assert.equal(debugEntries.at(-1)?.metadata?.hasResponse, false);
});

test('requestMlClassification logs and throws when the offscreen document returns an invalid response', async () => {
  const debugEntries = [];

  configureOffscreenClientForTesting({
    hasOffscreenDocument: async () => true,
    sendRuntimeMessage: async () => ({ backend: 'wasm', modelState: 'ready' }),
  });

  await assert.rejects(
    () =>
      requestMlClassification(
        {
          goal: 'Ship WorkRoom',
          requestId: 'req-invalid-response',
          title: 'Focus page',
          url: 'https://example.com/focus',
        },
        async (entry) => {
          debugEntries.push(entry);
        },
      ),
    /invalid ml response/i,
  );

  assert.equal(debugEntries[0]?.status, 'offscreen-reused');
  assert.equal(debugEntries.at(-1)?.status, 'offscreen-response-invalid');
  assert.equal(debugEntries.at(-1)?.metadata?.hasResponse, true);
});

test('requestMlClassification logs request failures before rethrowing', async () => {
  const debugEntries = [];

  configureOffscreenClientForTesting({
    hasOffscreenDocument: async () => true,
    sendRuntimeMessage: async () => {
      throw new Error('transport down');
    },
  });

  await assert.rejects(
    () =>
      requestMlClassification(
        {
          goal: 'Ship WorkRoom',
          requestId: 'req-send-failure',
          tabId: 44,
          title: 'Focus page',
          url: 'https://example.com/focus',
        },
        async (entry) => {
          debugEntries.push(entry);
        },
      ),
    /transport down/i,
  );

  assert.equal(debugEntries[0]?.status, 'offscreen-reused');
  assert.equal(debugEntries.at(-1)?.status, 'offscreen-request-failed');
  assert.equal(debugEntries.at(-1)?.tabId, 44);
});

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildNormalizedPageContext,
  createSignalSnapshot,
  extractPageSignalsFromDocument,
  hasMeaningfulPageSignals,
} = require('../.test-build/lib/page-signals.js');

function createElement({ content, hidden = false, textContent = '' } = {}) {
  return {
    hidden,
    textContent,
    getAttribute(name) {
      if (name === 'content') {
        return content ?? null;
      }

      return null;
    },
    getClientRects() {
      return { length: hidden ? 0 : 1 };
    },
  };
}

function createFakeDocument(definition) {
  return {
    title: definition.title,
    querySelector(selector) {
      const values = definition.single[selector];
      return Array.isArray(values) ? values[0] ?? null : values ?? null;
    },
    querySelectorAll(selector) {
      return definition.multi[selector] ?? [];
    },
  };
}

test('extractPageSignalsFromDocument captures bounded semantic signals', () => {
  const documentRef = createFakeDocument({
    title: 'Deep Work Article',
    single: {
      'meta[name="description"]': createElement({ content: 'Practical focus advice for knowledge work.' }),
      main: createElement({ textContent: 'Long-form article about focus, planning, and deep work rituals.' }),
      'article': null,
      '[role="main"]': null,
      '.markdown-body': null,
      '.post': null,
      body: createElement({ textContent: 'Fallback body text' }),
      'video, [data-testid="video-player"], [itemprop="video"]': null,
      '[role="feed"], [data-testid*="feed"]': null,
      '[data-testid="repository-container"], .markdown-body': null,
      '.monaco-editor, [contenteditable="true"], [role="textbox"]': null,
      '[role="log"], [aria-live="polite"], [aria-live="assertive"]': null,
    },
    multi: {
      'h1, h2, h3': [
        createElement({ textContent: 'Deep Work' }),
        createElement({ textContent: 'Focus Systems' }),
      ],
      'nav a, nav button, header a, header button, [role="navigation"] a, [role="navigation"] button': [
        createElement({ textContent: 'Docs' }),
        createElement({ textContent: 'Pricing' }),
      ],
    },
  });

  const signals = extractPageSignalsFromDocument(documentRef, 'https://example.com/articles/deep-work');

  assert.equal(signals.title, 'Deep Work Article');
  assert.deepEqual(signals.headings, ['Deep Work', 'Focus Systems']);
  assert.equal(signals.metaDescription, 'Practical focus advice for knowledge work.');
  assert.match(signals.mainTextSnippet, /focus, planning/i);
  assert.deepEqual(signals.navLabels, ['Docs', 'Pricing']);
  assert.deepEqual(signals.pathnameTokens, ['articles', 'deep', 'work']);
  assert.equal(hasMeaningfulPageSignals(signals), true);
});

test('buildNormalizedPageContext combines extracted signals with url context', () => {
  const context = buildNormalizedPageContext({
    pageSignals: {
      appMarkers: ['document-page'],
      durationMs: 5,
      extractedAt: 1,
      headings: ['Deep Work'],
      mainTextSnippet: 'Focus rituals and planning checklist',
      metaDescription: 'Guide to focused execution',
      navLabels: ['Docs'],
      pathnameTokens: ['guides', 'focus'],
      signalCounts: {
        appMarkers: 1,
        headings: 1,
        mainTextLength: 35,
        navLabels: 1,
        pathnameTokens: 2,
      },
      title: 'Deep Work Guide',
    },
    title: 'Ignored Title',
    url: 'https://docs.example.com/guides/focus',
  });

  assert.match(context, /deep work guide/);
  assert.match(context, /guide to focused execution/);
  assert.match(context, /document page/);
  assert.match(context, /guides focus/);
  assert.match(context, /docs example/);
});

test('createSignalSnapshot keeps only debug-safe signal fields', () => {
  const snapshot = createSignalSnapshot({
    appMarkers: ['repository-page'],
    durationMs: 8,
    extractedAt: 1,
    headings: ['Pull request review'],
    mainTextSnippet: 'Reviewing a focused code change.',
    metaDescription: 'Repo work',
    navLabels: ['Files changed'],
    pathnameTokens: ['pull', '123'],
    signalCounts: {
      appMarkers: 1,
      headings: 1,
      mainTextLength: 31,
      navLabels: 1,
      pathnameTokens: 2,
    },
    title: 'PR #123',
  });

  assert.deepEqual(Object.keys(snapshot).sort(), [
    'appMarkers',
    'headings',
    'mainTextSnippet',
    'metaDescription',
    'navLabels',
    'pathnameTokens',
    'title',
  ]);
});

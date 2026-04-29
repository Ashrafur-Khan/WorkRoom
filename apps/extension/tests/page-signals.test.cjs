const test = require('node:test');
const assert = require('node:assert/strict');

const {
  extractPageSignalsFromDocument,
} = require('../.test-build/lib/page-signals.js');
const {
  buildNormalizedPageContext,
  createSignalSnapshot,
  hasMeaningfulPageSignals,
} = require('../.test-build/lib/page-context.js');

function createElement({ attributes = {}, content, hidden = false, innerText, multi = {}, textContent = '' } = {}) {
  return {
    hidden,
    innerText,
    textContent,
    getAttribute(name) {
      if (name === 'content') {
        return content ?? attributes.content ?? null;
      }

      return attributes[name] ?? null;
    },
    getClientRects() {
      return { length: hidden ? 0 : 1 };
    },
    querySelectorAll(selector) {
      return multi[selector] ?? [];
    },
  };
}

function createFakeDocument(definition) {
  return {
    title: definition.title,
    querySelector(selector) {
      const values = definition.single?.[selector];
      return Array.isArray(values) ? values[0] ?? null : values ?? null;
    },
    querySelectorAll(selector) {
      return definition.multi?.[selector] ?? [];
    },
  };
}

test('extractPageSignalsFromDocument captures structured types, section hints, and bounded paragraph openings', () => {
  const mainParagraphs = [
    createElement({ textContent: 'This guide explains focus rituals in practical terms. Extra details are omitted.' }),
    createElement({ textContent: 'Planning deep work blocks reduces context switching across the week.' }),
    createElement({ textContent: 'A short review habit keeps each session aligned with the goal.' }),
    createElement({ textContent: 'Ignored because only three snippets are kept.' }),
  ];

  const documentRef = createFakeDocument({
    title: 'Deep Work Article',
    single: {
      'meta[name="description"]': createElement({ content: 'Practical focus advice for knowledge work.' }),
      'meta[property="og:type"]': createElement({ content: 'article' }),
      main: createElement({
        multi: { p: mainParagraphs },
        textContent: 'Pricing Docs Sidebar Noise',
      }),
      article: null,
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
      'nav[aria-label*="breadcrumb" i] a': [
        createElement({ textContent: 'Knowledge Base' }),
        createElement({ textContent: 'Focus' }),
      ],
      'nav[aria-label*="breadcrumb" i] [aria-current]': [createElement({ textContent: 'Deep Work' })],
      '[role="tab"][aria-selected="true"]': [createElement({ textContent: 'Overview' })],
      'script[type="application/ld+json"]': [
        createElement({
          textContent: JSON.stringify({
            '@type': 'Article',
            '@graph': [{ '@type': 'FAQPage' }],
          }),
        }),
      ],
    },
  });

  const signals = extractPageSignalsFromDocument(documentRef, 'https://docs.example.com/articles/deep-work');

  assert.equal(signals.title, 'Deep Work Article');
  assert.deepEqual(signals.structuredTypes, ['article', 'faq page']);
  assert.deepEqual(signals.sectionHints, ['Knowledge Base', 'Focus', 'Deep Work', 'Overview']);
  assert.deepEqual(signals.headings, ['Deep Work', 'Focus Systems']);
  assert.equal(signals.mainTextSnippets.length, 3);
  assert.equal(signals.mainTextSnippets[0], 'This guide explains focus rituals in practical terms.');
  assert.match(signals.mainTextSnippets[1], /^Planning deep work blocks reduces context switching/);
  assert.match(signals.mainTextSnippets[2], /^A short review habit keeps each session aligned/);
  assert.deepEqual(signals.pageMarkers, ['document-page']);
  assert.deepEqual(signals.pathnameTokens, ['articles', 'deep', 'work']);
  assert.equal(signals.signalCounts.structuredTypes, 2);
  assert.equal(signals.signalCounts.sectionHints, 4);
  assert.equal(signals.signalCounts.mainSnippetCount, 3);
  assert.equal(hasMeaningfulPageSignals(signals), true);
});

test('extractPageSignalsFromDocument ignores malformed JSON-LD while keeping valid structured types', () => {
  const documentRef = createFakeDocument({
    title: 'Product Page',
    single: {
      'meta[name="description"]': null,
      'meta[property="og:type"]': null,
      main: null,
      article: null,
      '[role="main"]': null,
      '.markdown-body': null,
      '.post': null,
      body: null,
      'video, [data-testid="video-player"], [itemprop="video"]': null,
      '[role="feed"], [data-testid*="feed"]': null,
      '[data-testid="repository-container"], .markdown-body': null,
      '.monaco-editor, [contenteditable="true"], [role="textbox"]': null,
      '[role="log"], [aria-live="polite"], [aria-live="assertive"]': null,
    },
    multi: {
      'h1, h2, h3': [],
      'script[type="application/ld+json"]': [
        createElement({ textContent: '{invalid json' }),
        createElement({
          textContent: JSON.stringify({
            '@graph': [{ '@type': ['Product', 'WebPage'] }],
          }),
        }),
      ],
    },
  });

  const signals = extractPageSignalsFromDocument(documentRef, 'https://example.com/store/widget');

  assert.deepEqual(signals.structuredTypes, ['product', 'web page']);
});

test('buildNormalizedPageContext combines richer signals in the intended order', () => {
  const context = buildNormalizedPageContext({
    pageSignals: {
      durationMs: 5,
      extractedAt: 1,
      headings: ['Getting started'],
      mainTextSnippets: ['Async functions pause execution'],
      metaDescription: 'Guide to focused execution',
      pageMarkers: ['document-page'],
      pathnameTokens: ['guides', 'focus'],
      sectionHints: ['tutorials', 'concurrency'],
      signalCounts: {
        headings: 1,
        mainSnippetCount: 1,
        mainTextLength: 31,
        pageMarkers: 1,
        pathnameTokens: 2,
        sectionHints: 2,
        structuredTypes: 1,
      },
      structuredTypes: ['article'],
      title: 'Deep Work Guide',
    },
    title: 'Ignored Title',
    url: 'https://docs.example.com/guides/focus',
  });

  assert.equal(
    context,
    'deep work guide. guide to focused execution. type article. section tutorials concurrency. headings getting started. main async functions pause execution. markers document page. path guides focus. docs example',
  );
});

test('createSignalSnapshot keeps only debug-safe signal fields', () => {
  const snapshot = createSignalSnapshot({
    durationMs: 8,
    extractedAt: 1,
    headings: ['Pull request review'],
    mainTextSnippets: ['Reviewing a focused code change.'],
    metaDescription: 'Repo work',
    pageMarkers: ['repository-page'],
    pathnameTokens: ['pull', '123'],
    sectionHints: ['Files changed'],
    signalCounts: {
      headings: 1,
      mainSnippetCount: 1,
      mainTextLength: 31,
      pageMarkers: 1,
      pathnameTokens: 2,
      sectionHints: 1,
      structuredTypes: 1,
    },
    structuredTypes: ['article'],
    title: 'PR #123',
  });

  assert.deepEqual(Object.keys(snapshot).sort(), [
    'headings',
    'mainTextSnippets',
    'metaDescription',
    'pageMarkers',
    'pathnameTokens',
    'sectionHints',
    'structuredTypes',
    'title',
  ]);
});

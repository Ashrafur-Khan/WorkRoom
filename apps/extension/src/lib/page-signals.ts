import type { PageSignals, SignalSnapshot } from '../types';
import { extractHostnameTokens, normalizeText } from './ml-helpers';

const MAX_HEADINGS = 6;
const MAX_SECTION_HINTS = 6;
const MAX_STRUCTURED_TYPES = 6;
const MAX_PATHNAME_TOKENS = 6;
const MAX_TEXT_LENGTH = 320;
const MAX_LABEL_LENGTH = 48;
const MAX_MAIN_SNIPPETS = 3;
const MAX_MAIN_SNIPPET_LENGTH = 60;
const MAX_JSON_LD_SCRIPTS = 4;
const MIN_PARAGRAPH_LENGTH = 40;

const HEADING_SELECTOR = 'h1, h2, h3';
const MAIN_CONTENT_SELECTORS = ['main', 'article', '[role="main"]', '.markdown-body', '.post', 'body'];
const BREADCRUMB_SELECTORS = [
  'nav[aria-label*="breadcrumb" i] a',
  'nav[aria-label*="breadcrumb" i] [aria-current]',
  '[role="navigation"][aria-label*="breadcrumb" i] a',
  '[role="navigation"][aria-label*="breadcrumb" i] [aria-current]',
  '[data-testid*="breadcrumb" i] a',
  '[data-testid*="breadcrumb" i] [aria-current]',
  '[aria-label*="breadcrumb" i] li',
];
const ACTIVE_SECTION_SELECTORS = [
  'nav [aria-current="page"]',
  'nav [aria-current="step"]',
  'header [aria-current="page"]',
  'header [aria-current="step"]',
  '[role="navigation"] [aria-current="page"]',
  '[role="navigation"] [aria-current="step"]',
  '[role="tab"][aria-selected="true"]',
  '[aria-selected="true"][role="tab"]',
  '[role="treeitem"][aria-selected="true"]',
  '[role="option"][aria-selected="true"]',
  '[data-testid*="tab" i][aria-selected="true"]',
];
const APP_MARKER_SELECTORS = {
  chat: '[role="log"], [aria-live="polite"], [aria-live="assertive"]',
  docs: '.monaco-editor, [contenteditable="true"], [role="textbox"]',
  feed: '[role="feed"], [data-testid*="feed"]',
  repository: '[data-testid="repository-container"], .markdown-body',
  video: 'video, [data-testid="video-player"], [itemprop="video"]',
};

type MinimalElement = {
  getAttribute?: (name: string) => string | null;
  getClientRects?: () => { length: number };
  hidden?: boolean;
  innerText?: string | null;
  querySelectorAll?: (selector: string) => ArrayLike<MinimalElement>;
  textContent?: string | null;
};

type QueryableDocument = Pick<Document, 'querySelector' | 'querySelectorAll' | 'title'>;
type QueryableNode = Pick<Document | Element, 'querySelectorAll'>;

function sanitizeText(input: string | null | undefined, maxLength: number): string {
  const collapsed = (input ?? '')
    .replace(/\s+/g, ' ')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted-email]')
    .replace(/\b\d{6,}\b/g, '[redacted-number]')
    .trim();

  return collapsed.slice(0, maxLength);
}

function isProbablyVisible(element: MinimalElement | null | undefined): boolean {
  if (!element) {
    return false;
  }

  if (element.hidden) {
    return false;
  }

  if (element.getAttribute?.('aria-hidden') === 'true') {
    return false;
  }

  const rects = element.getClientRects?.();
  if (rects && rects.length === 0) {
    return false;
  }

  return true;
}

function getElementText(element: MinimalElement | null | undefined, maxLength: number): string {
  if (!isProbablyVisible(element)) {
    return '';
  }

  return sanitizeText(element?.innerText ?? element?.textContent ?? '', maxLength);
}

function dedupeStrings(values: string[], maxItems: number): string[] {
  const unique = new Set<string>();

  for (const value of values) {
    if (!value) {
      continue;
    }

    const key = value.toLowerCase();
    if (unique.has(key)) {
      continue;
    }

    unique.add(key);

    if (unique.size >= maxItems) {
      break;
    }
  }

  return [...unique].map((value) => values.find((entry) => entry.toLowerCase() === value) ?? value);
}

function queryAll(node: QueryableNode | MinimalElement | null | undefined, selector: string): MinimalElement[] {
  if (!node?.querySelectorAll) {
    return [];
  }

  return Array.from(node.querySelectorAll(selector) as ArrayLike<MinimalElement>);
}

function queryMetaContent(documentRef: QueryableDocument, selector: string): string {
  const element = documentRef.querySelector(selector) as MinimalElement | null;
  return sanitizeText(element?.getAttribute?.('content') ?? '', MAX_TEXT_LENGTH);
}

function extractHeadings(documentRef: QueryableDocument): string[] {
  return dedupeStrings(
    queryAll(documentRef, HEADING_SELECTOR).map((element) => getElementText(element, MAX_LABEL_LENGTH)),
    MAX_HEADINGS,
  );
}

function normalizeStructuredTypeValue(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }

  const lastSegment = trimmed.split(/[\/#]/g).pop() ?? trimmed;
  const spaced = lastSegment
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ');

  return normalizeText(spaced);
}

function appendStructuredTypeValue(rawValue: unknown, values: string[]): void {
  if (values.length >= MAX_STRUCTURED_TYPES) {
    return;
  }

  if (typeof rawValue === 'string') {
    const normalized = normalizeStructuredTypeValue(rawValue);
    if (normalized) {
      values.push(normalized);
    }
    return;
  }

  if (Array.isArray(rawValue)) {
    for (const entry of rawValue) {
      appendStructuredTypeValue(entry, values);
      if (values.length >= MAX_STRUCTURED_TYPES) {
        return;
      }
    }
  }
}

function collectJsonLdStructuredTypes(node: unknown, values: string[]): void {
  if (values.length >= MAX_STRUCTURED_TYPES || node === null || node === undefined) {
    return;
  }

  if (Array.isArray(node)) {
    for (const entry of node) {
      collectJsonLdStructuredTypes(entry, values);
      if (values.length >= MAX_STRUCTURED_TYPES) {
        return;
      }
    }
    return;
  }

  if (typeof node !== 'object') {
    return;
  }

  const record = node as Record<string, unknown>;
  appendStructuredTypeValue(record['@type'], values);
  collectJsonLdStructuredTypes(record['@graph'], values);
}

function extractStructuredTypes(documentRef: QueryableDocument): string[] {
  const values: string[] = [];

  appendStructuredTypeValue(queryMetaContent(documentRef, 'meta[property="og:type"]'), values);

  const scripts = queryAll(documentRef, 'script[type="application/ld+json"]').slice(0, MAX_JSON_LD_SCRIPTS);

  for (const script of scripts) {
    const raw = script.textContent?.trim();
    if (!raw) {
      continue;
    }

    try {
      collectJsonLdStructuredTypes(JSON.parse(raw), values);
    } catch {
      continue;
    }

    if (values.length >= MAX_STRUCTURED_TYPES) {
      break;
    }
  }

  return dedupeStrings(values, MAX_STRUCTURED_TYPES);
}

function extractTextsForSelectors(
  documentRef: QueryableDocument,
  selectors: string[],
  maxLength: number,
  maxItems: number,
): string[] {
  return dedupeStrings(
    selectors.flatMap((selector) => queryAll(documentRef, selector).map((element) => getElementText(element, maxLength))),
    maxItems,
  );
}

function extractSectionHints(documentRef: QueryableDocument): string[] {
  const breadcrumbs = extractTextsForSelectors(documentRef, BREADCRUMB_SELECTORS, MAX_LABEL_LENGTH, MAX_SECTION_HINTS);

  if (breadcrumbs.length >= MAX_SECTION_HINTS) {
    return breadcrumbs;
  }

  const activeLabels = extractTextsForSelectors(
    documentRef,
    ACTIVE_SECTION_SELECTORS,
    MAX_LABEL_LENGTH,
    MAX_SECTION_HINTS,
  );

  return dedupeStrings([...breadcrumbs, ...activeLabels], MAX_SECTION_HINTS);
}

function extractOpeningSnippet(input: string): string {
  const sanitized = sanitizeText(input, MAX_TEXT_LENGTH);
  if (sanitized.length < MIN_PARAGRAPH_LENGTH) {
    return '';
  }

  const firstSentenceMatch = sanitized.match(/^(.{1,200}?[.!?])(?:\s|$)/);
  const candidate = firstSentenceMatch?.[1] ?? sanitized;

  return sanitizeText(candidate, MAX_MAIN_SNIPPET_LENGTH);
}

function extractMainTextSnippets(documentRef: QueryableDocument): string[] {
  for (const selector of MAIN_CONTENT_SELECTORS) {
    const candidate = documentRef.querySelector(selector) as MinimalElement | null;
    const snippets = dedupeStrings(
      queryAll(candidate, 'p')
        .map((element) => getElementText(element, MAX_TEXT_LENGTH))
        .map((text) => extractOpeningSnippet(text))
        .filter(Boolean),
      MAX_MAIN_SNIPPETS,
    );

    if (snippets.length > 0) {
      return snippets;
    }
  }

  return [];
}

function extractPathnameTokens(url: string): string[] {
  try {
    const pathname = new URL(url).pathname.toLowerCase();

    return dedupeStrings(
      pathname
        .split(/[^a-z0-9]+/g)
        .map((token) => token.trim())
        .filter((token) => token.length > 2),
      MAX_PATHNAME_TOKENS,
    );
  } catch {
    return [];
  }
}

function detectPageMarkers(documentRef: QueryableDocument, url: string): string[] {
  const markers: string[] = [];

  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname.toLowerCase();

    if (pathname.includes('/watch') || pathname.includes('/video') || pathname.includes('/shorts')) {
      markers.push('video-page');
    }

    if (pathname.includes('/feed') || pathname.includes('/explore') || pathname === '/home') {
      markers.push('feed-page');
    }

    if (pathname.includes('/pull/') || pathname.includes('/issues/') || hostname.includes('github.com')) {
      markers.push('repository-page');
    }

    if (hostname.includes('docs.') || hostname.includes('notion.') || pathname.includes('/doc')) {
      markers.push('document-page');
    }

    if (pathname.includes('/chat') || pathname.includes('/messages')) {
      markers.push('chat-page');
    }
  } catch {
    return [];
  }

  for (const [marker, selector] of Object.entries(APP_MARKER_SELECTORS)) {
    if (documentRef.querySelector(selector)) {
      markers.push(`${marker}-surface`);
    }
  }

  return dedupeStrings(markers, MAX_HEADINGS);
}

function buildLabeledSection(label: string, values: string[] | string | undefined): string {
  const normalizedValues = Array.isArray(values)
    ? values.map((value) => normalizeText(value)).filter(Boolean)
    : [normalizeText(values ?? '')].filter(Boolean);

  if (normalizedValues.length === 0) {
    return '';
  }

  return `${label} ${normalizedValues.join(' ')}`.trim();
}

export function extractPageSignalsFromDocument(
  documentRef: QueryableDocument,
  url: string,
  now = Date.now(),
): PageSignals {
  const startedAt = now;
  const title = sanitizeText(documentRef.title, MAX_TEXT_LENGTH);
  const headings = extractHeadings(documentRef);
  const metaDescription =
    queryMetaContent(documentRef, 'meta[name="description"]') ||
    queryMetaContent(documentRef, 'meta[property="og:description"]');
  const structuredTypes = extractStructuredTypes(documentRef);
  const sectionHints = extractSectionHints(documentRef);
  const mainTextSnippets = extractMainTextSnippets(documentRef);
  const pathnameTokens = extractPathnameTokens(url);
  const pageMarkers = detectPageMarkers(documentRef, url);
  const mainTextLength = mainTextSnippets.join(' ').length;

  return {
    durationMs: Math.max(Date.now() - startedAt, 0),
    extractedAt: startedAt,
    headings,
    mainTextSnippets,
    metaDescription,
    pageMarkers,
    pathnameTokens,
    sectionHints,
    signalCounts: {
      headings: headings.length,
      mainSnippetCount: mainTextSnippets.length,
      mainTextLength,
      pageMarkers: pageMarkers.length,
      pathnameTokens: pathnameTokens.length,
      sectionHints: sectionHints.length,
      structuredTypes: structuredTypes.length,
    },
    structuredTypes,
    title,
  };
}

export function hasMeaningfulPageSignals(signals: PageSignals): boolean {
  return Boolean(
    signals.metaDescription ||
      signals.structuredTypes.length > 0 ||
      signals.sectionHints.length > 0 ||
      signals.headings.length > 0 ||
      signals.mainTextSnippets.length > 0 ||
      signals.pageMarkers.length > 0 ||
      signals.pathnameTokens.length > 0,
  );
}

export function buildNormalizedPageContext(input: {
  pageSignals?: PageSignals;
  title: string;
  url: string;
}): string {
  const baseTitle = normalizeText(sanitizeText(input.pageSignals?.title ?? input.title, MAX_TEXT_LENGTH));
  const sections = [
    baseTitle,
    normalizeText(input.pageSignals?.metaDescription ?? ''),
    buildLabeledSection('type', input.pageSignals?.structuredTypes),
    buildLabeledSection('section', input.pageSignals?.sectionHints),
    buildLabeledSection('headings', input.pageSignals?.headings),
    buildLabeledSection('main', input.pageSignals?.mainTextSnippets),
    buildLabeledSection('markers', input.pageSignals?.pageMarkers),
    buildLabeledSection('path', input.pageSignals?.pathnameTokens),
    normalizeText(extractHostnameTokens(input.url).join(' ')),
  ].filter(Boolean);

  return dedupeStrings(sections, sections.length).join('. ').trim();
}

export function createSignalSnapshot(signals: PageSignals): SignalSnapshot {
  return {
    headings: signals.headings,
    mainTextSnippets: signals.mainTextSnippets,
    metaDescription: signals.metaDescription,
    pageMarkers: signals.pageMarkers,
    pathnameTokens: signals.pathnameTokens,
    sectionHints: signals.sectionHints,
    structuredTypes: signals.structuredTypes,
    title: signals.title,
  };
}

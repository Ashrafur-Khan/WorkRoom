import type { PageSignals, SignalSnapshot } from '../types';
import { extractHostnameTokens, normalizeText } from './ml-helpers';

const MAX_HEADINGS = 6;
const MAX_LABELS = 8;
const MAX_PATHNAME_TOKENS = 6;
const MAX_TEXT_LENGTH = 320;
const MAX_LABEL_LENGTH = 48;
const MIN_MAIN_TEXT_LENGTH = 40;

const HEADING_SELECTOR = 'h1, h2, h3';
const NAV_SELECTOR = 'nav a, nav button, header a, header button, [role="navigation"] a, [role="navigation"] button';
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
  textContent?: string | null;
};

type QueryableDocument = Pick<Document, 'querySelector' | 'querySelectorAll' | 'title'>;

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

function queryAll(documentRef: QueryableDocument, selector: string): MinimalElement[] {
  return Array.from(documentRef.querySelectorAll(selector) as ArrayLike<MinimalElement>);
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

function extractMainText(documentRef: QueryableDocument): string {
  const candidates = ['main', 'article', '[role="main"]', '.markdown-body', '.post', 'body'];

  for (const selector of candidates) {
    const candidate = documentRef.querySelector(selector) as MinimalElement | null;
    const text = getElementText(candidate, MAX_TEXT_LENGTH);

    if (text.length >= MIN_MAIN_TEXT_LENGTH) {
      return text;
    }
  }

  return '';
}

function extractNavLabels(documentRef: QueryableDocument): string[] {
  return dedupeStrings(
    queryAll(documentRef, NAV_SELECTOR).map((element) => getElementText(element, MAX_LABEL_LENGTH)),
    MAX_LABELS,
  );
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

function detectAppMarkers(documentRef: QueryableDocument, url: string): string[] {
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
  const mainTextSnippet = extractMainText(documentRef);
  const navLabels = extractNavLabels(documentRef);
  const pathnameTokens = extractPathnameTokens(url);
  const appMarkers = detectAppMarkers(documentRef, url);

  return {
    appMarkers,
    durationMs: Math.max(Date.now() - startedAt, 0),
    extractedAt: startedAt,
    headings,
    mainTextSnippet,
    metaDescription,
    navLabels,
    pathnameTokens,
    signalCounts: {
      appMarkers: appMarkers.length,
      headings: headings.length,
      mainTextLength: mainTextSnippet.length,
      navLabels: navLabels.length,
      pathnameTokens: pathnameTokens.length,
    },
    title,
  };
}

export function hasMeaningfulPageSignals(signals: PageSignals): boolean {
  return Boolean(
    signals.metaDescription ||
      signals.headings.length > 0 ||
      signals.mainTextSnippet ||
      signals.navLabels.length > 0 ||
      signals.appMarkers.length > 0 ||
      signals.pathnameTokens.length > 0,
  );
}

export function buildNormalizedPageContext(input: {
  pageSignals?: PageSignals;
  title: string;
  url: string;
}): string {
  const baseTitle = sanitizeText(input.pageSignals?.title ?? input.title, MAX_TEXT_LENGTH);
  const sections = [
    baseTitle,
    input.pageSignals?.metaDescription ?? '',
    input.pageSignals?.headings.join(' ') ?? '',
    input.pageSignals?.mainTextSnippet ?? '',
    input.pageSignals?.navLabels.join(' ') ?? '',
    input.pageSignals?.appMarkers.join(' ') ?? '',
    input.pageSignals?.pathnameTokens.join(' ') ?? '',
    extractHostnameTokens(input.url).join(' '),
  ]
    .map((section) => normalizeText(section))
    .filter(Boolean);

  return dedupeStrings(sections, sections.length).join(' ').trim();
}

export function createSignalSnapshot(signals: PageSignals): SignalSnapshot {
  return {
    appMarkers: signals.appMarkers,
    headings: signals.headings,
    mainTextSnippet: signals.mainTextSnippet,
    metaDescription: signals.metaDescription,
    navLabels: signals.navLabels,
    pathnameTokens: signals.pathnameTokens,
    title: signals.title,
  };
}

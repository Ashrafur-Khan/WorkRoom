import type { PageSignals, SignalSnapshot } from '../types';
import { extractHostnameTokens, normalizeText } from './ml-helpers';

const MAX_TEXT_LENGTH = 320;

function sanitizeText(input: string | null | undefined, maxLength: number): string {
  const collapsed = (input ?? '')
    .replace(/\s+/g, ' ')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted-email]')
    .replace(/\b\d{6,}\b/g, '[redacted-number]')
    .trim();

  return collapsed.slice(0, maxLength);
}

function dedupeStrings(values: string[]): string[] {
  const unique = new Set<string>();

  for (const value of values) {
    if (!value) {
      continue;
    }

    const key = value.toLowerCase();
    if (!unique.has(key)) {
      unique.add(key);
    }
  }

  return [...unique].map((value) => values.find((entry) => entry.toLowerCase() === value) ?? value);
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

  return dedupeStrings(sections).join('. ').trim();
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

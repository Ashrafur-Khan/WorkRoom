import type { DebugLogEntry, DebugMetadata, SignalSnapshot } from '../types';

const DEBUG_LOG_STORAGE_KEY = 'debugLogEntries';
const DEBUG_LOG_LIMIT = 150;

type SessionStorageApi = Pick<typeof chrome.storage.session, 'get' | 'set'>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isDebugMetadata(value: unknown): value is DebugMetadata {
  return (
    isRecord(value) &&
    Object.values(value).every(
      (entry) =>
        typeof entry === 'string' ||
        typeof entry === 'number' ||
        typeof entry === 'boolean' ||
        entry === null,
    )
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isSignalSnapshot(value: unknown): value is SignalSnapshot {
  return (
    isRecord(value) &&
    typeof value.metaDescription === 'string' &&
    typeof value.title === 'string' &&
    isStringArray(value.headings) &&
    isStringArray(value.mainTextSnippets) &&
    isStringArray(value.pageMarkers) &&
    isStringArray(value.pathnameTokens) &&
    isStringArray(value.sectionHints) &&
    isStringArray(value.structuredTypes)
  );
}

export function isDebugLogEntry(value: unknown): value is DebugLogEntry {
  if (!isRecord(value)) {
    return false;
  }

  return (
    (value.source === 'bg' || value.source === 'offscreen') &&
    typeof value.status === 'string' &&
    typeof value.timestamp === 'number' &&
    (value.backend === undefined || typeof value.backend === 'string') &&
    (value.cacheHit === undefined || typeof value.cacheHit === 'boolean') &&
    (value.error === undefined || typeof value.error === 'string') &&
    (value.metadata === undefined || isDebugMetadata(value.metadata)) &&
    (value.requestId === undefined || typeof value.requestId === 'string') &&
    (value.score === undefined || value.score === null || typeof value.score === 'number') &&
    (value.signalSnapshot === undefined || isSignalSnapshot(value.signalSnapshot)) &&
    (value.tabId === undefined || typeof value.tabId === 'number')
  );
}

function normalizeDebugLogEntries(raw: unknown): {
  changed: boolean;
  entries: DebugLogEntry[];
} {
  if (!Array.isArray(raw)) {
    return { changed: raw !== undefined, entries: [] };
  }

  const entries = raw.filter(isDebugLogEntry).slice(-DEBUG_LOG_LIMIT);

  return {
    changed: entries.length !== raw.length,
    entries,
  };
}

async function readNormalizedDebugLogs(
  storageApi: SessionStorageApi = chrome.storage.session,
): Promise<{ changed: boolean; entries: DebugLogEntry[] }> {
  const result = await storageApi.get(DEBUG_LOG_STORAGE_KEY) as Record<string, unknown>;
  return normalizeDebugLogEntries(result[DEBUG_LOG_STORAGE_KEY]);
}

export async function appendDebugLog(
  entry: DebugLogEntry,
  storageApi: SessionStorageApi = chrome.storage.session,
): Promise<void> {
  const { changed, entries } = await readNormalizedDebugLogs(storageApi);
  const next = [...entries, entry].slice(-DEBUG_LOG_LIMIT);
  const previousLastEntry = entries.length > 0 ? entries[entries.length - 1] : undefined;
  const nextLastEntry = next.length > 0 ? next[next.length - 1] : undefined;

  if (changed || next.length !== entries.length || nextLastEntry !== previousLastEntry) {
    await storageApi.set({ [DEBUG_LOG_STORAGE_KEY]: next });
  }
}

export async function getDebugLogs(
  storageApi: SessionStorageApi = chrome.storage.session,
): Promise<DebugLogEntry[]> {
  const normalized = await readNormalizedDebugLogs(storageApi);

  if (normalized.changed) {
    await storageApi.set({ [DEBUG_LOG_STORAGE_KEY]: normalized.entries });
  }

  return normalized.entries;
}

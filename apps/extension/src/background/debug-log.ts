import type { DebugLogEntry } from '../types';

const DEBUG_LOG_STORAGE_KEY = 'debugLogEntries';
const DEBUG_LOG_LIMIT = 150;

export async function appendDebugLog(entry: DebugLogEntry): Promise<void> {
  const result = await chrome.storage.session.get(DEBUG_LOG_STORAGE_KEY);
  const existing = (result[DEBUG_LOG_STORAGE_KEY] as DebugLogEntry[] | undefined) ?? [];
  const next = [...existing, entry].slice(-DEBUG_LOG_LIMIT);

  await chrome.storage.session.set({ [DEBUG_LOG_STORAGE_KEY]: next });
}

export async function getDebugLogs(): Promise<DebugLogEntry[]> {
  const result = await chrome.storage.session.get(DEBUG_LOG_STORAGE_KEY);
  return (result[DEBUG_LOG_STORAGE_KEY] as DebugLogEntry[] | undefined) ?? [];
}

export async function clearDebugLogs(): Promise<void> {
  await chrome.storage.session.remove(DEBUG_LOG_STORAGE_KEY);
}

import type { RunningSessionState, SessionState } from '../types';

type LocalStorageApi = Pick<typeof chrome.storage.local, 'get' | 'set'>;

type DomainOverrideStatus =
  | { status: 'allowed' }
  | { expiresAt: number; status: 'expired' | 'snoozed' }
  | { status: 'none' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function areStringArraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function areSnoozedDomainsEqual(
  left: Record<string, number>,
  right: Record<string, number>,
): boolean {
  const leftEntries = Object.entries(left);
  const rightEntries = Object.entries(right);

  if (leftEntries.length !== rightEntries.length) {
    return false;
  }

  return leftEntries.every(([key, value]) => right[key] === value);
}

function normalizeAllowedDomains(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((domain): domain is string => typeof domain === 'string');
}

function normalizeSnoozedDomains(value: unknown): Record<string, number> {
  if (!isRecord(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, number] => typeof entry[0] === 'string' && typeof entry[1] === 'number' && Number.isFinite(entry[1]),
    ),
  );
}

function isValidRunningStateFields(state: Record<string, unknown>): state is Record<string, unknown> & {
  durationMinutes: number;
  goal: string;
  startTime: number;
} {
  return (
    typeof state.goal === 'string' &&
    typeof state.durationMinutes === 'number' &&
    Number.isFinite(state.durationMinutes) &&
    state.durationMinutes > 0 &&
    typeof state.startTime === 'number' &&
    Number.isFinite(state.startTime)
  );
}

export function safeParseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

export function createIdleState(): SessionState {
  return { isRunning: false };
}

export function createRunningState(
  goal: string,
  durationMinutes: number,
  startTime = Date.now(),
): RunningSessionState {
  return {
    allowedDomains: [],
    durationMinutes,
    goal,
    isRunning: true,
    snoozedDomains: {},
    startTime,
  };
}

export function getDomainFromUrl(url: string): string | null {
  return safeParseUrl(url)?.hostname.toLowerCase() ?? null;
}

export function normalizeSessionState(raw: unknown): {
  changed: boolean;
  state: SessionState;
} {
  if (raw === undefined) {
    return {
      changed: false,
      state: createIdleState(),
    };
  }

  if (!isRecord(raw) || raw.isRunning !== true) {
    return {
      changed: !isRecord(raw) || Object.keys(raw).length !== 1 || raw.isRunning !== false,
      state: createIdleState(),
    };
  }

  if (!isValidRunningStateFields(raw)) {
    return {
      changed: true,
      state: createIdleState(),
    };
  }

  const rawAllowedDomains = raw.allowedDomains;
  const rawSnoozedDomains = raw.snoozedDomains;
  const allowedDomains = normalizeAllowedDomains(rawAllowedDomains);
  const snoozedDomains = normalizeSnoozedDomains(rawSnoozedDomains);
  const normalizedState: RunningSessionState = {
    allowedDomains,
    durationMinutes: raw.durationMinutes,
    goal: raw.goal,
    isRunning: true,
    snoozedDomains,
    startTime: raw.startTime,
  };

  const changed =
    !Array.isArray(rawAllowedDomains) ||
    allowedDomains.length !== rawAllowedDomains.length ||
    !areStringArraysEqual(allowedDomains, rawAllowedDomains.filter((value): value is string => typeof value === 'string')) ||
    !isRecord(rawSnoozedDomains) ||
    Object.keys(snoozedDomains).length !== Object.keys(rawSnoozedDomains).length ||
    !areSnoozedDomainsEqual(snoozedDomains, normalizeSnoozedDomains(rawSnoozedDomains)) ||
    raw.goal !== normalizedState.goal ||
    raw.durationMinutes !== normalizedState.durationMinutes ||
    raw.startTime !== normalizedState.startTime ||
    raw.isRunning !== true;

  return {
    changed,
    state: normalizedState,
  };
}

export async function readSessionState(
  storageApi: LocalStorageApi = chrome.storage.local,
): Promise<SessionState> {
  const result = await storageApi.get('sessionState') as { sessionState?: unknown };
  const normalized = normalizeSessionState(result.sessionState);

  if (normalized.changed) {
    await storageApi.set({ sessionState: normalized.state });
  }

  return normalized.state;
}

export async function writeSessionState(
  state: SessionState,
  storageApi: Pick<typeof chrome.storage.local, 'set'> = chrome.storage.local,
): Promise<void> {
  await storageApi.set({ sessionState: state });
}

export function allowDomainForSession(
  state: RunningSessionState,
  domain: string,
): { wasDuplicate: boolean } {
  const wasDuplicate = state.allowedDomains.includes(domain);

  if (!wasDuplicate) {
    state.allowedDomains.push(domain);
  }

  delete state.snoozedDomains[domain];

  return { wasDuplicate };
}

export function snoozeDomainForSession(
  state: RunningSessionState,
  domain: string,
  durationMinutes: number,
  now = Date.now(),
): { expiresAt: number } {
  const expiresAt = now + durationMinutes * 60 * 1000;
  state.snoozedDomains[domain] = expiresAt;

  return { expiresAt };
}

export function resolveSessionOverride(
  state: RunningSessionState,
  domain: string,
  now = Date.now(),
): DomainOverrideStatus {
  if (state.allowedDomains.includes(domain)) {
    return { status: 'allowed' };
  }

  const expiresAt = state.snoozedDomains[domain];

  if (!expiresAt) {
    return { status: 'none' };
  }

  if (expiresAt <= now) {
    return { expiresAt, status: 'expired' };
  }

  return { expiresAt, status: 'snoozed' };
}

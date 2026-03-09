// src/types.ts
export type Classification = 'on-task' | 'off-task' | 'ambiguous';

export type SessionState =
  | { isRunning: false }
  | {
      isRunning: true;
      goal: string;
      durationMinutes: number;
      startTime: number;
    };
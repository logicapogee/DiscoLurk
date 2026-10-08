import type { RunId, RunPlanSnapshot, ScheduleId, TriggerCause } from '@disco-lurk/core';

export interface PlannedRun {
  snapshot: RunPlanSnapshot;
  status: 'pending' | 'started' | 'skipped' | 'missed';
}

export interface HistoryEntry {
  at: string;
  snapshotId: string;
  cause: TriggerCause;
  outcome: 'started' | 'skipped' | 'missed';
  reason?: string;
  runId?: RunId;
}

export interface ScheduleState {
  paused: boolean;
  runOnStartConsumed: boolean;
  /** Local dates (in the schedule's zone) whose runs are already materialized. */
  generatedDays: string[];
  planned: PlannedRun[];
  history: HistoryEntry[];
}

export interface SchedulerState {
  schemaVersion: 1;
  schedules: Record<ScheduleId, ScheduleState>;
}

export interface ScheduleStore {
  load(): Promise<SchedulerState | null>;
  save(state: SchedulerState): Promise<void>;
}

export class MemoryScheduleStore implements ScheduleStore {
  private data: string | null = null;

  async load(): Promise<SchedulerState | null> {
    return this.data ? (JSON.parse(this.data) as SchedulerState) : null;
  }

  async save(state: SchedulerState): Promise<void> {
    this.data = JSON.stringify(state);
  }
}

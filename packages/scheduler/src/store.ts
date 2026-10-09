import type { ErrorCode, RunId, RunOutcome, RunPlanSnapshot, ScheduleId, StopCause, TriggerCause } from '@disco-lurk/core';

export interface PlannedRun {
  snapshot: RunPlanSnapshot;
  status: 'pending' | 'started' | 'skipped' | 'missed';
}

/** How a started run ended. */
export interface RunEnding {
  at: string;
  outcome: RunOutcome;
  stopCause: StopCause;
  failure?: ErrorCode;
}

export interface HistoryEntry {
  at: string;
  snapshotId: string;
  cause: TriggerCause;
  outcome: 'started' | 'skipped' | 'missed';
  reason?: string;
  runId?: RunId;
  ended?: RunEnding;
}

export interface ScheduleState {
  paused: boolean;
  runOnStartConsumed: boolean;
  /** The trigger and zone the pending plan was made for; a change replans the runs not yet due. */
  planKey?: string;
  /** Local dates (in the schedule's zone) whose daily-window runs are already materialized. */
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
  /** Serializes `state` before returning, so later changes to it never reach the stored copy. */
  save(state: SchedulerState): Promise<void>;
}

/** Instances sharing one `cell` see the same persisted state, as two processes opening one file would. */
export class MemoryScheduleStore implements ScheduleStore {
  constructor(private readonly cell: { data: string | null } = { data: null }) {}

  async load(): Promise<SchedulerState | null> {
    return this.cell.data ? (JSON.parse(this.cell.data) as SchedulerState) : null;
  }

  async save(state: SchedulerState): Promise<void> {
    this.cell.data = JSON.stringify(state);
  }
}

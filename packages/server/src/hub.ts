// The parts of the server that carry no HTTP or socket code, so runs and schedules can be driven
// from the CLI as well.
import type { ServerFrame } from './contract';

/** An error with the HTTP status the server answers it with. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}

type FrameListener = (frame: ServerFrame, encoded: string) => void;

/** Frames published here reach every authenticated WebSocket. */
export class EventHub {
  private listeners = new Set<FrameListener>();

  subscribe(fn: FrameListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** `encoded` is the frame's JSON when the caller already has it, so it is serialized once. */
  publish(frame: ServerFrame, encoded = JSON.stringify(frame)): void {
    for (const fn of this.listeners) fn(frame, encoded);
  }
}


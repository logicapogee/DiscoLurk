import { stopRequest } from '@disco-lurk/core';

interface StopSignals {
  /** Aborts with a stop request: the first Ctrl+C (`user`) or SIGTERM (`app-exit`). */
  signal: AbortSignal;
  /** Aborts on a second Ctrl+C or on SIGTERM; it cuts short what a graceful stop would still do. */
  exitSignal: AbortSignal;
}

/**
 * The first Ctrl+C asks for a graceful stop and the second forces it, as SIGTERM does at once.
 * After that the handler steps aside, so one more Ctrl+C ends the process the default way.
 */
export function installStopHandlers(onFirstInterrupt?: () => void): StopSignals {
  const stop = new AbortController();
  const exit = new AbortController();
  const onInterrupt = () => {
    if (!stop.signal.aborted) {
      onFirstInterrupt?.();
      stop.abort(stopRequest('user'));
      return;
    }
    exit.abort();
    process.off('SIGINT', onInterrupt);
  };
  process.on('SIGINT', onInterrupt);
  process.once('SIGTERM', () => {
    stop.abort(stopRequest('app-exit'));
    exit.abort();
  });
  return { signal: stop.signal, exitSignal: exit.signal };
}

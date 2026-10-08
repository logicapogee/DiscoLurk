/**
 * Page reads that may come up empty without anything being wrong: a wait that ran out, or a query
 * that raced a navigation and lost its execution context. Everything else is a real failure.
 */
export function expectedMiss(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === 'TimeoutError' || err.message.includes('Execution context was destroyed');
}

/** Playwright's error for a call on a page, context or browser that has gone away. */
export function targetClosed(err: unknown): boolean {
  return err instanceof Error && err.name === 'TargetClosedError';
}

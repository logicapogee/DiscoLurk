import type { Readable } from 'node:stream';

type Cleanup = () => Promise<void>;

/** The shell allows 15 s for shutdown before it kills the sidecar. */
export const SHUTDOWN_BUDGET_MS = 15_000;

/**
 * One shutdown path for every trigger (/shutdown, SIGTERM, stdin EOF): run sessions are cancelled
 * and browsers, Profile locks and logs are released by whoever registered them, newest first.
 */
export class SidecarLifecycle {
  private cleanups: Array<{ name: string; run: Cleanup }> = [];
  private stopping: Promise<void> | null = null;
  private finish: () => void = () => {};
  /** Settles once a shutdown, from any trigger, has finished its cleanups. */
  readonly done = new Promise<void>((resolve) => (this.finish = resolve));

  constructor(
    private readonly log: (message: string) => void = () => {},
    private readonly budgetMs = SHUTDOWN_BUDGET_MS,
  ) {}

  register(name: string, run: Cleanup): () => void {
    const entry = { name, run };
    this.cleanups.push(entry);
    return () => {
      this.cleanups = this.cleanups.filter((c) => c !== entry);
    };
  }

  shutdown(reason: string): Promise<void> {
    this.stopping ??= this.runCleanups(reason);
    return this.stopping;
  }

  private async runCleanups(reason: string): Promise<void> {
    this.log(`shutdown: ${reason}`);
    const work = (async () => {
      for (const { name, run } of this.cleanups.slice().reverse()) {
        try {
          await run();
        } catch (err) {
          this.log(`shutdown: ${name} failed: ${String(err)}`);
        }
      }
    })();
    let timer: NodeJS.Timeout | undefined;
    const budget = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        this.log(`shutdown: cleanup exceeded ${this.budgetMs} ms`);
        resolve();
      }, this.budgetMs);
    });
    await Promise.race([work, budget]);
    clearTimeout(timer);
    this.finish();
  }

  /**
   * The shell holds the write end of the sidecar's stdin, so EOF means the shell is gone, even if it
   * was killed without a chance to call /shutdown.
   */
  watchParent(stdin: Readable): void {
    stdin.on('end', () => void this.shutdown('stdin closed'));
    stdin.on('error', () => void this.shutdown('stdin error'));
    stdin.resume();
  }
}

interface CrashWatch {
  readonly crashed: boolean;
  dispose(): void;
}

/**
 * An error nothing caught still ends the process, but through the same shutdown as a signal:
 * runs stop as an app exit, browsers and Profile locks are released and history is written, then
 * the process exits with `exitCode`.
 */
export function exitOnCrash(
  lifecycle: { shutdown(reason: string): Promise<void> },
  log: (message: string) => void,
  exitCode: number,
  target: NodeJS.EventEmitter = process,
  exit: (code: number) => void = (code) => process.exit(code),
): CrashWatch {
  let crashed = false;
  const onCrash = (kind: string) => (err: unknown) => {
    log(`${kind}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    if (crashed) return;
    crashed = true;
    void lifecycle.shutdown(kind).finally(() => exit(exitCode));
  };
  const rejection = onCrash('unhandledRejection');
  const exception = onCrash('uncaughtException');
  target.on('unhandledRejection', rejection);
  target.on('uncaughtException', exception);
  return {
    get crashed() {
      return crashed;
    },
    dispose() {
      target.off('unhandledRejection', rejection);
      target.off('uncaughtException', exception);
    },
  };
}

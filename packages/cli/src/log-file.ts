import { appendFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export const LOG_KEEP_DAYS = 7;
const LOG_NAME = /^sidecar-(\d{4}-\d{2}-\d{2})\.log$/;

/** The local calendar day, so a file holds what the user saw as one day. */
export function localDay(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/**
 * `<dir>/sidecar-YYYY-MM-DD.log`, one file per local day; files older than `keepDays` days are
 * deleted when a new day's file is opened. Each line is appended synchronously, so the lines
 * written just before a crash are on disk.
 */
export class DailyLog {
  private day = '';

  constructor(
    readonly dir: string,
    private readonly now: () => Date = () => new Date(),
    private readonly keepDays = LOG_KEEP_DAYS,
  ) {}

  write(message: string): void {
    const at = this.now();
    const day = localDay(at);
    try {
      if (day !== this.day) {
        mkdirSync(this.dir, { recursive: true });
        this.day = day;
        this.prune(at);
      }
      appendFileSync(join(this.dir, `sidecar-${day}.log`), `${at.toISOString()} ${message}\n`);
    } catch {
      // A full or read-only disk loses log lines; the sidecar keeps serving, and stderr still has them.
    }
  }

  private prune(at: Date): void {
    const oldest = localDay(new Date(at.getFullYear(), at.getMonth(), at.getDate() - (this.keepDays - 1)));
    for (const name of readdirSync(this.dir)) {
      const day = LOG_NAME.exec(name)?.[1];
      if (day !== undefined && day < oldest) unlinkSync(join(this.dir, name));
    }
  }
}

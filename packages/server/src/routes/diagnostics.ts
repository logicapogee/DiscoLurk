import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Route } from '../server';
import { toJsonl } from '../store';
import { ok, safeFileName, stamp, type AppContext } from './context';

/** The newest daily log files and the runs whose event logs go into a bundle. */
const LOG_FILES = 2;
const RUN_LOGS = 5;
const RECENT_RUNS = 20;

/**
 * Token-like values a log line may carry (a minted `serve` token, an Authorization header) are
 * replaced before the line leaves the machine.
 */
export function redact(text: string): string {
  return text.replace(/(token[^:\n]*:\s*)\S+/gi, '$1<redacted>').replace(/(Bearer\s+)\S+/g, '$1<redacted>');
}

export interface DiagnosticsBundle {
  generatedAt: string;
  doctor: unknown;
  settings: unknown;
  sites: unknown;
  profiles: unknown;
  runs: unknown;
  /** Event logs of the newest runs, as JSONL. */
  events: Record<string, string>;
  /** The newest sidecar log files, redacted. */
  logs: Record<string, string>;
}

/**
 * What a bug report needs and nothing that signs in: the doctor report, settings, sites, Profile
 * states (never their directories), recent runs with their event logs and the newest log files.
 */
export async function collectDiagnostics(ctx: AppContext, doctor: () => Promise<unknown>): Promise<DiagnosticsBundle> {
  const runs = ctx.history.list(RECENT_RUNS);
  const events: Record<string, string> = {};
  for (const r of runs.slice(0, RUN_LOGS)) events[r.runId] = toJsonl((await ctx.history.readEvents(r.runId)).events);
  const logDir = join(ctx.dataDir, 'logs');
  const names = (await readdir(logDir).catch(() => [] as string[])).filter((n) => n.endsWith('.log')).sort().slice(-LOG_FILES);
  const logs: Record<string, string> = {};
  for (const n of names) logs[n] = redact(await readFile(join(logDir, n), 'utf8').catch(() => ''));
  return {
    generatedAt: new Date(ctx.clock.now()).toISOString(),
    doctor: await doctor().catch((err: unknown) => ({ error: String(err) })),
    settings: ctx.settings.get(),
    sites: ctx.catalog.sites,
    profiles: (await ctx.profiles.list((id) => ctx.gate.isBusy(id))).map(({ proxy: _proxy, ...p }) => p),
    runs,
    events,
    logs,
  };
}

export function diagnosticRoutes(ctx: AppContext, doctor: () => Promise<unknown>): Route[] {
  return [
    {
      // A remote browser downloads the bundle as one JSON file.
      method: 'GET',
      path: '/diagnostics',
      handle: async () => {
        const bundle = await collectDiagnostics(ctx, doctor);
        return {
          status: 200,
          text: JSON.stringify(bundle, null, 2),
          contentType: 'application/json; charset=utf-8',
          headers: { 'Content-Disposition': `attachment; filename="disco-lurk-diagnostics-${stamp(ctx.clock)}.json"` },
        };
      },
    },
    {
      // The desktop webview has no download manager: the bundle is written as a directory instead.
      method: 'POST',
      path: '/diagnostics',
      handle: async () => {
        const bundle = await collectDiagnostics(ctx, doctor);
        const dir = join(ctx.dataDir, 'exports', `diagnostics-${stamp(ctx.clock)}`);
        await mkdir(join(dir, 'runs'), { recursive: true });
        await mkdir(join(dir, 'logs'), { recursive: true });
        const { events, logs, ...summary } = bundle;
        await writeFile(join(dir, 'summary.json'), JSON.stringify(summary, null, 2));
        for (const [runId, text] of Object.entries(events)) await writeFile(join(dir, 'runs', `${safeFileName(runId)}.events.jsonl`), text);
        for (const [name, text] of Object.entries(logs)) await writeFile(join(dir, 'logs', name), text);
        return ok({ path: dir });
      },
    },
  ];
}

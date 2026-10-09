// Packaging gate for the final `lurk` binary:
//   1. launch system Chrome  2. persistent context  3. one locator click on a local static page
//   4. screenshot, Profile written, clean close with no leftover browser process
//   5. run again from a path outside the repository (Profile reused; sidecar ready line, token kept out of
//      argv and environment, loopback-only listener, /health, /shutdown, stdin EOF)
// Only a loopback static server is contacted; no real site is visited.
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({ options: { binary: { type: 'string' }, headed: { type: 'boolean', default: false } } });

const triple = /^host: (\S+)$/m.exec(execFileSync('rustc', ['-vV'], { encoding: 'utf8' }))?.[1] ?? '';
const binary = values.binary ?? join(root, 'dist/sidecar', `lurk-${triple}${process.platform === 'win32' ? '.exe' : ''}`);
if (!existsSync(binary)) {
  console.error(`Binary not found: ${binary}. Run \`pnpm build:sidecar\` first.`);
  process.exit(1);
}

type Step = { step: string; ok: boolean; detail: string };
const steps: Step[] = [];
const record = (step: string, ok: boolean, detail: string) => {
  steps.push({ step, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${step}: ${detail}`);
};

function serveStatic(dir: string): Promise<Server> {
  const server = createServer((req, res) => {
    const name = new URL(req.url ?? '/', 'http://x').pathname.replace(/^\/$/, '/index.html');
    const file = join(dir, name);
    if (!file.startsWith(dir) || !existsSync(file)) {
      res.statusCode = 404;
      return res.end();
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function runBinary(bin: string, args: string[], cwd: string): Promise<{ code: number | null; stdout: string; stderr: string; pid: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d));
    child.stderr.on('data', (d: Buffer) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr, pid: child.pid ?? -1 }));
  });
}

/** Processes still holding the Profile; Chrome passes it as --user-data-dir. */
function processesUsing(profileDir: string): string[] {
  // Windows has no `ps`; CIM lists every process with its full command line.
  const out =
    process.platform === 'win32'
      ? execFileSync('powershell', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.CommandLine)" }'], { encoding: 'utf8' })
      : execFileSync('ps', ['-ax', '-o', 'pid=,command='], { encoding: 'utf8' });
  return out.split('\n').filter((l) => l.includes(profileDir));
}

async function selftestRun(label: string, bin: string, cwd: string, url: string, profileDir: string, screenshot: string) {
  const args = ['selftest', '--url', url, '--profile-dir', profileDir, '--screenshot', screenshot];
  if (values.headed) args.push('--headed');
  const started = Date.now();
  const r = await runBinary(bin, args, cwd);
  const line = r.stdout.trim().split('\n').at(-1) ?? '{}';
  let result: Record<string, unknown> = {};
  try {
    result = JSON.parse(line) as Record<string, unknown>;
  } catch {
    // reported below as a failed step
  }
  const ms = Date.now() - started;
  record(
    `${label} launch system Chrome + persistent context`,
    r.code === 0 && result.ok === true,
    r.code === 0 ? `Chrome ${String(result.browserVersion)} in ${ms} ms, cwd ${cwd}` : `exit ${r.code}: ${String(result.error ?? r.stderr).slice(0, 800)}`,
  );
  record(
    `${label} locator click on local page`,
    typeof result.clickedTo === 'string' && result.clickedTo.endsWith('/landing.html'),
    `landed on ${String(result.clickedTo)}`,
  );
  record(`${label} navigator.webdriver is false`, result.webdriver === false, `webdriver=${String(result.webdriver)}`);
  const shotOk = existsSync(screenshot) && statSync(screenshot).size > 1000 && readFileSync(screenshot).subarray(1, 4).toString() === 'PNG';
  record(`${label} screenshot`, shotOk, shotOk ? `${screenshot} (${statSync(screenshot).size} bytes)` : 'missing or not a PNG');
  const profileWritten = existsSync(join(profileDir, 'Local State')) && existsSync(join(profileDir, 'Default'));
  record(`${label} Profile written`, profileWritten, profileDir);
  const leftovers = processesUsing(profileDir);
  record(`${label} browser process reclaimed`, leftovers.length === 0, leftovers.length ? leftovers.join(' | ').slice(0, 400) : 'no process holds the Profile');
  return result;
}

/** Starts `lurk sidecar` the way the shell does and reads its ready line. */
async function startSidecar(bin: string, cwd: string) {
  // stdin stays an open pipe, as under the shell; closing it is the parent-gone signal.
  const child = spawn(bin, ['sidecar'], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = new Promise<number | null>((resolve) => child.on('close', resolve));
  const ready = await new Promise<{ port: number; token: string } | null>((resolve) => {
    let buffered = '';
    const timer = setTimeout(() => resolve(null), 10_000);
    child.stdout.on('data', (d: Buffer) => {
      buffered += d;
      for (const line of buffered.split('\n').slice(0, -1)) {
        try {
          const msg = JSON.parse(line) as { event?: string; port?: number; token?: string };
          if (msg.event === 'ready' && msg.port && msg.token) {
            clearTimeout(timer);
            return resolve({ port: msg.port, token: msg.token });
          }
        } catch {
          // not the ready line
        }
      }
    });
    child.on('close', () => resolve(null));
  });
  return { child, exited, ready, token: ready?.token ?? '', base: `http://127.0.0.1:${ready?.port ?? 0}` };
}

async function waitHealth(base: string): Promise<unknown> {
  for (let i = 0; i < 100; i++) {
    try {
      return await (await fetch(`${base}/health`)).json();
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  return null;
}

const within = <T,>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), ms))]);

async function sidecarRun(bin: string, cwd: string) {
  const a = await startSidecar(bin, cwd);
  record('run 2 sidecar ready line', a.ready !== null, a.ready ? `port ${a.ready.port}, ${Buffer.byteLength(a.token)}-byte token` : 'none within 10 s');
  const health = a.ready ? await waitHealth(a.base) : null;
  record('run 2 sidecar /health', health !== null, JSON.stringify(health));
  const argv = execFileSync('ps', ['-o', 'command=', '-p', String(a.child.pid)], { encoding: 'utf8' }).trim();
  record('run 2 token absent from argv', a.token !== '' && !argv.includes(a.token), argv);
  const env = execFileSync('ps', ['eww', '-o', 'command=', '-p', String(a.child.pid)], { encoding: 'utf8' });
  record('run 2 token absent from environment', a.token !== '' && !env.includes(a.token), 'checked ps eww');
  const listening = execFileSync('lsof', ['-nP', '-a', '-p', String(a.child.pid), '-iTCP', '-sTCP:LISTEN'], { encoding: 'utf8' })
    .split('\n')
    .slice(1)
    .filter(Boolean)
    .map((l) => l.split(/\s+/).at(-2) ?? '');
  record(
    'run 2 sidecar listens on 127.0.0.1 only',
    listening.length > 0 && listening.every((addr) => addr.startsWith('127.0.0.1:')),
    listening.join(', '),
  );
  const unauth = await fetch(`${a.base}/shutdown`, { method: 'POST' }).then((r) => r.status, () => -1);
  record('run 2 sidecar rejects unauthenticated /shutdown', unauth === 401, `HTTP ${unauth}`);
  const shut = await fetch(`${a.base}/shutdown`, { method: 'POST', headers: { Authorization: `Bearer ${a.token}` } }).then(
    (r) => r.status,
    () => -1,
  );
  const code = await within(a.exited, 15_000);
  if (code === 'timeout') a.child.kill('SIGKILL');
  record('run 2 sidecar /shutdown exits cleanly', shut === 202 && code === 0, `HTTP ${shut}, exit ${String(code)}`);

  const b = await startSidecar(bin, cwd);
  const up = b.ready ? await waitHealth(b.base) : null;
  b.child.stdin.end();
  const eof = await within(b.exited, 15_000);
  if (eof === 'timeout') b.child.kill('SIGKILL');
  record('run 2 sidecar exits when stdin closes', up !== null && eof === 0, `health ${up ? 'ok' : 'none'}, exit ${String(eof)}`);
}

const work = mkdtempSync(join(tmpdir(), 'disco-lurk-gate-'));
const profileDir = join(work, 'profiles', 'gate', 'p1');
const server = await serveStatic(join(root, 'scripts/gate'));
const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/index.html`;
console.log(`binary ${binary}\nwork dir ${work}\n`);

try {
  const first = await selftestRun('run 1', binary, root, url, profileDir, join(work, 'run1.png'));
  record('run 1 fresh Profile', first.previousMarker === null, `previousMarker=${String(first.previousMarker)}`);

  const installDir = join(work, 'installed', 'DiscoLurk');
  mkdirSync(installDir, { recursive: true });
  const installed = join(installDir, process.platform === 'win32' ? 'lurk.exe' : 'lurk');
  copyFileSync(binary, installed);
  chmodSync(installed, 0o755);
  const second = await selftestRun('run 2', installed, installDir, url, profileDir, join(work, 'run2.png'));
  record('run 2 reused the Profile from run 1', second.previousMarker === first.marker, `previousMarker=${String(second.previousMarker)} expected=${String(first.marker)}`);
  await sidecarRun(installed, installDir);
} finally {
  server.close();
}

const failed = steps.filter((s) => !s.ok);
const report = { binary, workDir: work, at: new Date().toISOString(), passed: failed.length === 0, steps };
mkdirSync(join(root, 'dist/gate'), { recursive: true });
writeFileSync(join(root, 'dist/gate/result.json'), JSON.stringify(report, null, 2));
console.log(`\n${failed.length === 0 ? 'GATE PASSED' : `GATE FAILED (${failed.length} step(s))`} — dist/gate/result.json`);
process.exit(failed.length === 0 ? 0 : 1);

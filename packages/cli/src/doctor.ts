import { execFile } from 'node:child_process';
import { access, constants, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { BrowserChannel, Category, Site } from '@disco-lurk/core';
import { LOCK_FILE, processAlive, readLock } from '@disco-lurk/site-discourse';

const run = promisify(execFile);

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'skipped';

export interface DoctorCheck {
  id: string;
  title: string;
  status: CheckStatus;
  detail: string;
  fix?: string;
}

export interface DoctorReport {
  version: string;
  platform: string;
  arch: string;
  generatedAt: string;
  checks: DoctorCheck[];
}

export interface DoctorOptions {
  version: string;
  profilesDir: string;
  /** Checked for availability; ignored when `listeningPort` says the server already owns it. */
  port?: number;
  listeningPort?: number;
  /** Sites whose Profiles and category configuration are checked, with the categories each would run. */
  sites?: Array<{ site: Site; categories: () => Promise<Category[]> }>;
  /** The connectivity probe reaches the real site, so it only runs when explicitly requested. */
  network?: boolean;
  signal?: AbortSignal;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

/** Playwright's own install locations for `channel: 'chrome' | 'msedge'`. */
export function browserCandidates(channel: BrowserChannel, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  const home = env.HOME ?? '';
  if (platform === 'darwin') {
    const app = channel === 'chrome' ? 'Google Chrome.app/Contents/MacOS/Google Chrome' : 'Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
    return [`/Applications/${app}`, join(home, 'Applications', app)];
  }
  if (platform === 'win32') {
    const rel = channel === 'chrome' ? 'Google\\Chrome\\Application\\chrome.exe' : 'Microsoft\\Edge\\Application\\msedge.exe';
    return [env.LOCALAPPDATA, env.PROGRAMFILES, env['PROGRAMFILES(X86)']].filter(Boolean).map((root) => `${root}\\${rel}`);
  }
  return channel === 'chrome' ? ['/opt/google/chrome/chrome'] : ['/opt/microsoft/msedge/msedge'];
}

async function firstExisting(paths: string[]): Promise<string | null> {
  for (const p of paths) {
    try {
      await access(p, constants.X_OK);
      return p;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

async function browserCheck(channel: BrowserChannel, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): Promise<DoctorCheck> {
  const title = channel === 'chrome' ? 'Google Chrome' : 'Microsoft Edge';
  const path = await firstExisting(browserCandidates(channel, platform, env));
  if (!path) {
    return {
      id: `browser-${channel}`,
      title,
      status: channel === 'chrome' ? 'warn' : 'skipped',
      detail: '未找到',
      fix: '安装 Google Chrome 或 Microsoft Edge 后重试',
    };
  }
  let version = '版本未知';
  if (platform !== 'win32') {
    try {
      version = (await run(path, ['--version'], { timeout: 10_000 })).stdout.trim();
    } catch {
      // the path is still usable even if --version fails
    }
  }
  return { id: `browser-${channel}`, title, status: 'ok', detail: `${version} · ${path}` };
}

async function profilesCheck(dir: string): Promise<DoctorCheck> {
  const probe = join(dir, `.lurk-write-test-${process.pid}`);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(probe, 'ok');
    await rm(probe);
    return { id: 'profiles-writable', title: 'Profile 目录可写', status: 'ok', detail: dir };
  } catch (err) {
    return {
      id: 'profiles-writable',
      title: 'Profile 目录可写',
      status: 'fail',
      detail: `${dir}: ${(err as Error).message}`,
      fix: '检查该目录的权限与磁盘空间',
    };
  }
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}

async function portCheck(opts: DoctorOptions): Promise<DoctorCheck> {
  if (opts.listeningPort !== undefined) {
    return { id: 'port', title: '端口', status: 'ok', detail: `sidecar 正在监听 127.0.0.1:${opts.listeningPort}` };
  }
  const port = opts.port ?? 8080;
  return (await portFree(port))
    ? { id: 'port', title: '端口', status: 'ok', detail: `127.0.0.1:${port} 可用` }
    : { id: 'port', title: '端口', status: 'fail', detail: `127.0.0.1:${port} 已被占用`, fix: '换一个端口（--port）或关闭占用该端口的程序' };
}

async function webviewCheck(platform: NodeJS.Platform): Promise<DoctorCheck> {
  if (platform === 'darwin') {
    try {
      const plist = '/System/Library/Frameworks/WebKit.framework/Resources/Info.plist';
      const { stdout } = await run('plutil', ['-extract', 'CFBundleVersion', 'raw', plist], { timeout: 5000 });
      return { id: 'webview', title: 'WebView', status: 'ok', detail: `WKWebView (WebKit ${stdout.trim()})` };
    } catch (err) {
      return { id: 'webview', title: 'WebView', status: 'warn', detail: `无法读取 WebKit 版本：${(err as Error).message}` };
    }
  }
  return { id: 'webview', title: 'WebView', status: 'skipped', detail: '此平台的 WebView 版本检测尚未实现' };
}

async function connectivityCheck(opts: DoctorOptions): Promise<DoctorCheck> {
  const title = '站点连通性（HEAD https://linux.do）';
  if (!opts.network) return { id: 'connectivity', title, status: 'skipped', detail: '未请求（--network 时检查）' };
  try {
    const signal = AbortSignal.any([AbortSignal.timeout(10_000), ...(opts.signal ? [opts.signal] : [])]);
    const res = await fetch('https://linux.do', { method: 'HEAD', redirect: 'manual', signal });
    return { id: 'connectivity', title, status: 'ok', detail: `HTTP ${res.status}` };
  } catch (err) {
    return { id: 'connectivity', title, status: 'fail', detail: (err as Error).message, fix: '检查网络；若配置了代理，尝试清空代理' };
  }
}

async function profileList(dir: string, siteId: string): Promise<string[]> {
  const root = join(dir, siteId);
  const names = await readdir(root, { withFileTypes: true }).catch(() => []);
  const out: string[] = [];
  for (const entry of names.filter((e) => e.isDirectory())) {
    const lock = await readLock(join(root, entry.name, LOCK_FILE));
    out.push(lock && processAlive(lock.pid) ? `${entry.name}（被 PID ${lock.pid} 占用）` : entry.name);
  }
  return out;
}

/** Which Profiles exist per site, and whether one is held by a running browser. */
async function profileInventoryCheck(dir: string, sites: Site[]): Promise<DoctorCheck> {
  const parts: string[] = [];
  const missing: string[] = [];
  for (const site of sites) {
    const list = await profileList(dir, site.id);
    if (list.length === 0) missing.push(site.id);
    parts.push(`${site.id}: ${list.length ? list.join(', ') : '无'}`);
  }
  return {
    id: 'profiles',
    title: 'Profile',
    status: missing.length === sites.length ? 'warn' : 'ok',
    detail: parts.join('；'),
    ...(missing.length ? { fix: missing.map((id) => `lurk login --site ${id}`).join('；') } : {}),
  };
}

/** The categories a run would use without `--categories`. */
async function siteCheck(site: Site, categories: () => Promise<Category[]>): Promise<DoctorCheck> {
  const title = `站点 ${site.id}（${site.displayName}）`;
  let list: Category[];
  try {
    list = await categories();
  } catch (err) {
    return { id: `site-${site.id}`, title, status: 'fail', detail: (err as Error).message, fix: `删除该文件后运行 lurk login --site ${site.id} 重新发现板块` };
  }
  const enabled = list.filter((c) => c.enabledByDefault).length;
  const source = site.categorySource === 'builtin' ? '内置板块' : '已发现板块';
  const detail = `${source} ${list.length} 个，启用 ${enabled} 个；进度来源 ${site.progressSource}；clickEntryRequired=${String(site.behaviorVerified.clickEntryRequired)}`;
  if (list.length === 0) return { id: `site-${site.id}`, title, status: 'warn', detail, fix: `运行 lurk login --site ${site.id} 发现板块` };
  if (enabled === 0) return { id: `site-${site.id}`, title, status: 'warn', detail, fix: '运行时用 --categories 指定板块' };
  return { id: `site-${site.id}`, title, status: 'ok', detail };
}

/** Checks the environment a run needs: browsers, Profiles, data files and, optionally, the network. */
export async function runDoctor(opts: DoctorOptions): Promise<DoctorReport> {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const checks = await Promise.all([
    browserCheck('chrome', platform, env),
    browserCheck('msedge', platform, env),
    profilesCheck(opts.profilesDir),
    portCheck(opts),
    webviewCheck(platform),
    connectivityCheck(opts),
    ...(opts.sites ? [profileInventoryCheck(opts.profilesDir, opts.sites.map((s) => s.site)), ...opts.sites.map((s) => siteCheck(s.site, s.categories))] : []),
  ]);
  if (!checks.some((c) => c.id.startsWith('browser-') && c.status === 'ok')) {
    checks[0] = { ...checks[0]!, status: 'fail', fix: '需要系统 Chrome 或 Edge（不捆绑浏览器）。安装后重新运行 lurk doctor' };
  }
  return {
    version: opts.version,
    platform,
    arch: process.arch,
    generatedAt: new Date().toISOString(),
    checks,
  };
}

export function formatDoctor(report: DoctorReport): string {
  const mark: Record<CheckStatus, string> = { ok: '✓', warn: '!', fail: '✗', skipped: '-' };
  const lines = [`DiscoLurk ${report.version} · ${report.platform}-${report.arch}`];
  for (const c of report.checks) {
    lines.push(`${mark[c.status]} ${c.title}: ${c.detail}`);
    if (c.fix && c.status !== 'ok') lines.push(`    → ${c.fix}`);
  }
  return lines.join('\n');
}

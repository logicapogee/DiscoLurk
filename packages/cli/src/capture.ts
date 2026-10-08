import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, type Page } from 'playwright-core';
import { RunError, systemClock, systemSleeper, type BrowserChannel, type LevelSnapshot, type Site } from '@disco-lurk/core';
import {
  CATEGORY_LINK,
  categoryLinks,
  CONNECT_READY,
  findLeaks,
  HEADED_WIDTH,
  hostLabels,
  IGNORE_DEFAULT_ARGS,
  LAUNCH_ARGS,
  launchProfile,
  likedMarkers,
  parseConnect,
  parseDocument,
  parseFloorCounter,
  parseTopicList,
  PageView,
  parseTrustLevel,
  PROGRESS_READY_MS,
  readUsername,
  rowSelector,
  sanitizeHtml,
  scrubWith,
  SELECTORS,
  SORTED_BY_POSTS_QUERY,
  setWindowSize,
  topicUrlPattern,
  TRUST_LEVEL_READY_MS,
  TRUST_LEVEL_SELECTORS,
  waitForCurrentUser,
  type CategoryLink,
  type ListRow,
} from '@disco-lurk/site-discourse';

export interface CaptureOptions {
  site: Site;
  profileDir: string;
  outDir: string;
  channel: BrowserChannel;
  signal: AbortSignal;
  /** Runs only these steps (with the steps they depend on); the rest keep their earlier fixtures. */
  steps?: ReadonlySet<string>;
  log(message: string): void;
  ask(question: string): Promise<string>;
}

interface StepRecord {
  ok: boolean;
  note: string;
  files: string[];
  [detail: string]: unknown;
}

export interface CaptureReport {
  siteId: string;
  capturedAt: string;
  discourseVersion: string | null;
  steps: Record<string, StepRecord>;
}

/** Narrow enough for Discourse to swap the timeline for `#topic-progress` (§4.3), still under 1000. */
const NARROW_WIDTHS = [880, 760];
const BIG_TOPIC_REPLIES = 100;
const MAX_LIST_TRIES = 10;
/**
 * Reply-count cell of a list row; a capture-only aid for picking topics, not part of Appendix A.
 * The `gf-` cell is docofcard's theme, which replaces the stock columns.
 */
const REPLIES_CELL = 'td.posts .number, td.num.posts span.number, .posts-map .number, .gf-stat-posts .gf-stat-number';

export const CAPTURE_STEPS = ['categories', 'list', 'list-sorted', 'topic', 'progress', 'liked', 'login-form'] as const;

// `list` reads its candidates from the categories page on discovered sites, so it always runs after it.
const STEP_DEPENDS: Record<string, string[]> = {
  list: ['categories'],
  'list-sorted': ['categories', 'list'],
  topic: ['categories', 'list', 'list-sorted'],
};

/** The requested steps plus whatever state they need from earlier steps. */
export function expandSteps(requested: string[]): Set<string> {
  const out = new Set<string>();
  for (const r of requested) {
    if (!(CAPTURE_STEPS as readonly string[]).includes(r)) throw new Error(`unknown capture step ${r}; known: ${CAPTURE_STEPS.join(', ')}`);
    for (const d of STEP_DEPENDS[r] ?? []) out.add(d);
    out.add(r);
  }
  return out;
}

/** `1.2k` style abbreviations from Discourse's number helper. */
function abbreviated(raw: string): number | null {
  const m = /([\d.,]+)\s*([kKmM万])?/.exec(raw.trim());
  if (!m) return null;
  const base = Number(m[1]!.replace(/,/g, ''));
  const unit = m[2]?.toLowerCase();
  return Math.round(base * (unit === 'k' ? 1_000 : unit === 'm' ? 1_000_000 : unit === '万' ? 10_000 : 1));
}

interface Row extends ListRow {
  replies: number | null;
}

function rowsOf(html: string): Row[] {
  const doc = parseDocument(html);
  return parseTopicList(doc).map((r) => ({
    ...r,
    replies: abbreviated(doc.querySelector(rowSelector(r.id))?.querySelector(REPLIES_CELL)?.textContent ?? ''),
  }));
}

/**
 * Development command behind `lurk capture` (Phase 0): with the user's own login in an app-owned
 * Profile, visits each page kind once at Appendix B's pace and stores sanitized HTML fixtures.
 * Topics are entered only by clicking their list row (T08); nothing is liked, typed or submitted.
 */
export async function captureFixtures(opts: CaptureOptions): Promise<CaptureReport> {
  const { site, signal, log } = opts;
  const base = site.baseUrl;
  const sleep = (ms: number) => systemSleeper.sleep(ms, signal);
  const pause = (minS: number, maxS: number) => sleep((minS + Math.random() * (maxS - minS)) * 1000);
  const report: CaptureReport = { siteId: site.id, capturedAt: new Date().toISOString(), discourseVersion: null, steps: {} };
  let identities: string[] = [];
  const mapping = new Map<string, string>();

  await mkdir(opts.outDir, { recursive: true });

  const save = async (name: string, html: string): Promise<string> => {
    const clean = sanitizeHtml(html, identities, hostLabels(base));
    for (const [k, v] of clean.mapping) mapping.set(k, v);
    const leaks = findLeaks(clean.html, identities);
    const file = leaks.length ? `${name}.leak.html` : `${name}.html`;
    await writeFile(join(opts.outDir, file), clean.html);
    if (leaks.length) log(`  ! ${file}: identity survived sanitizing (${leaks.length} hit(s)); kept out of git, see .gitignore`);
    else log(`  saved ${file}`);
    return file;
  };
  const step = async (name: string, run: () => Promise<StepRecord>) => {
    if (opts.steps && !opts.steps.has(name)) return;
    log(`\n[${name}]`);
    try {
      report.steps[name] = await run();
    } catch (err) {
      if (signal.aborted) throw err;
      report.steps[name] = { ok: false, note: String((err as Error).message ?? err).split('\n')[0]!, files: [] };
    }
    const r = report.steps[name]!;
    log(`  ${r.ok ? 'ok' : 'FAILED'}: ${r.note}`);
  };

  const session = await launchProfile({ profileDir: opts.profileDir, runId: `capture-${Date.now()}`, channel: opts.channel, headless: false });
  const page = session.page;
  try {
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    log(`Log in to ${site.displayName} in the Chrome window. Checking #current-user every 5 s for up to 300 s; the page is never reloaded.`);
    const view = new PageView(page);
    const loggedIn = await waitForCurrentUser(view, {
      signal,
      onPoll: (ms) => log(`  waiting for login… ${Math.round(ms / 1000)} s`),
    });
    if (!loggedIn) throw new RunError('needs-auth', 'No #current-user within 300 s');
    report.discourseVersion = await page.locator('meta[name="generator"]').getAttribute('content', { timeout: 2_000 }).catch(() => null);
    const username = await readUsername(view, base);
    if (!username) throw new RunError('needs-auth', 'Could not read the username from the /my/activity redirect');
    identities = [username];
    log(`Logged in (username read from the /my redirect; it is replaced in every fixture).`);
    await pause(1, 2);

    let categories: CategoryLink[] = [];
    await step('categories', async () => {
      await page.goto(new URL('/categories', base).href, { waitUntil: 'domcontentloaded' });
      await page.locator(CATEGORY_LINK).first().waitFor({ timeout: 20_000 });
      await pause(1, 2);
      const html = await page.content();
      categories = categoryLinks(parseDocument(html), base);
      const file = await save('categories', html);
      return { ok: categories.length > 0, note: `${categories.length} category links`, files: [file], categoryCount: categories.length };
    });

    const listCandidates =
      site.categorySource === 'builtin'
        ? (site.builtinCategories ?? []).filter((c) => c.enabledByDefault).map((c) => ({ name: c.name, path: c.path, id: c.id }))
        : categories;

    let listPath: string | null = null;
    let big: Row | null = null;
    await step('list', async () => {
      let best: { path: string; html: string; score: number; rows: Row[] } | null = null;
      for (const c of listCandidates.slice(0, MAX_LIST_TRIES)) {
        if (best) await pause(2, 5);
        await page.goto(new URL(c.path, base).href, { waitUntil: 'domcontentloaded' });
        const appeared = await page.locator(SELECTORS.topicRow).first().waitFor({ timeout: 20_000 }).then(() => true, () => false);
        if (!appeared) continue;
        await pause(1, 2);
        const html = await page.content();
        const rows = rowsOf(html);
        // A row with 100+ replies lets the topic step find its long topic on this same list.
        const hasBig = rows.some((r) => !r.pinned && (r.replies ?? 0) >= BIG_TOPIC_REPLIES);
        const score = (rows.some((r) => r.pinned) ? 2 : 0) + (rows.some((r) => r.unread) ? 2 : 0) + (hasBig ? 1 : 0);
        log(`  ${c.path}: ${rows.length} rows, ${rows.filter((r) => r.pinned).length} pinned, ${rows.filter((r) => r.unread).length} new-topic, ${hasBig ? 'has' : 'no'} 100+ topic`);
        if (!best || score > best.score) best = { path: c.path, html, score, rows };
        if (score === 5) break;
      }
      if (!best) return { ok: false, note: 'no category list rendered topic rows', files: [] };
      listPath = best.path;
      // The later steps sort and click on this list, so the browser returns to it when a later category was the last one tried.
      if (new URL(page.url()).pathname !== best.path) {
        await pause(2, 5);
        await page.goto(new URL(best.path, base).href, { waitUntil: 'domcontentloaded' });
        await page.locator(SELECTORS.topicRow).first().waitFor({ timeout: 20_000 });
        await pause(1, 2);
      }
      const file = await save('list', best.html);
      return {
        ok: best.score >= 4,
        note: best.score >= 4 ? `${best.path} has pinned and new-topic rows` : `${best.path}: best found lacks pinned or new-topic rows`,
        files: [file],
        path: best.path,
        rows: best.rows.length,
        pinned: best.rows.filter((r) => r.pinned).length,
        newTopic: best.rows.filter((r) => r.unread).length,
        unreadPosts: best.rows.filter((r) => r.unreadPosts).length,
      };
    });

    await step('list-sorted', async () => {
      if (!listPath) return { ok: false, note: 'no list page to sort', files: [] };
      await pause(2, 5);
      await page.goto(new URL(`${listPath}?${SORTED_BY_POSTS_QUERY}`, base).href, { waitUntil: 'domcontentloaded' });
      await page.locator(SELECTORS.topicRow).first().waitFor({ timeout: 15_000 });
      await sleep(1_000);
      const html = await page.content();
      const rows = rowsOf(html);
      big = rows.find((r) => !r.pinned && (r.replies ?? 0) >= BIG_TOPIC_REPLIES && r.hasTitleLink) ?? null;
      // Without a readable reply count, the top of a posts-sorted list is the best guess; the floor
      // counter's total recorded by the topic step shows whether it really has 100+ floors.
      if (!big && rows.every((r) => r.replies === null)) big = rows.find((r) => !r.pinned && r.hasTitleLink) ?? null;
      const file = await save('list-sorted', html);
      return {
        ok: true,
        note: `opened ?${SORTED_BY_POSTS_QUERY} (T02); ${big ? `topic ${big.id} has ${big.replies} replies` : `no topic with ≥${BIG_TOPIC_REPLIES} replies`}`,
        files: [file],
        url: scrubWith(mapping, page.url()),
      };
    });

    const enter = async (id: string): Promise<boolean> => {
      const link = page.locator(`${rowSelector(id)} ${SELECTORS.topicLink}`).first();
      await link.scrollIntoViewIfNeeded();
      await pause(0.5, 1.5);
      await link.click();
      return Promise.any([
        page.waitForURL(topicUrlPattern(id), { timeout: 15_000 }),
        page.locator(SELECTORS.firstPostById).waitFor({ timeout: 15_000 }),
      ]).then(
        () => true,
        () => false,
      );
    };
    const back = async (id: string) => {
      await page.goBack({ waitUntil: 'commit' });
      await page.locator(rowSelector(id)).waitFor({ state: 'visible', timeout: 15_000 });
      await pause(2, 3);
    };
    const readOnce = async () => {
      await pause(2, 4);
      await page.mouse.move(HEADED_WIDTH / 2, 400);
      await page.mouse.wheel(0, 600 + Math.random() * 600);
      await sleep(500);
    };
    const counter = () => page.content().then((html) => parseFloorCounter(parseDocument(html)));

    await step('topic', async () => {
      const topic = big as Row | null;
      if (!topic) return { ok: false, note: `no topic with ≥${BIG_TOPIC_REPLIES} replies on the sorted list`, files: [] };
      if (!(await enter(topic.id))) return { ok: false, note: `clicked topic ${topic.id} but the topic URL / #post_1 never appeared`, files: [] };
      const files: string[] = [];
      await page.locator(SELECTORS.floorWide).first().waitFor({ timeout: 10_000 }).catch(() => {});
      await pause(1, 3);
      await readOnce();
      await readOnce();
      const wide = await counter();
      files.push(await save('topic-wide', await page.content()));

      let narrowWidth = 0;
      for (const width of NARROW_WIDTHS) {
        await setWindowSize(page, width);
        narrowWidth = width;
        const shown = await page
          .waitForFunction((sel) => document.querySelectorAll(sel).length >= 3, SELECTORS.floorNarrow, { timeout: 10_000 })
          .then(() => true, () => false);
        if (shown) break;
      }
      await pause(1, 2);
      const narrow = await counter();
      files.push(await save('topic-narrow', await page.content()));
      await setWindowSize(page, HEADED_WIDTH);
      await pause(1, 2);
      await back(topic.id);
      const ok = wide?.layout === 'wide' && narrow?.layout === 'narrow';
      return {
        ok,
        note: `wide ${JSON.stringify(wide)}, narrow at ${narrowWidth}px ${JSON.stringify(narrow)}`,
        files,
        topicId: topic.id,
        replies: topic.replies,
        narrowWidth,
        returnedUrl: scrubWith(mapping, page.url()),
      };
    });

    await step('progress', async () => {
      if (site.progressSource === 'none' || !site.progressUrl) return { ok: true, note: 'site has no progress page', files: [] };
      await pause(2, 5);
      return site.progressSource === 'connect-linuxdo'
        ? captureConnect(page, site.progressUrl, { save, sleep, ask: opts.ask, log })
        : captureTrustLevel(page, site.progressUrl, { save, sleep, scrub: (s) => scrubWith(mapping, s) });
    });

    await step('liked', async () => {
      for (let attempt = 1; attempt <= 3; attempt++) {
        const answer = (
          await opts.ask(
            'In the Chrome window, open a topic where you ALREADY liked a post and leave that post on screen. Do not press any like button.\n' +
              'Then type the floor number of the liked post and press Enter (type s to skip).',
          )
        ).trim();
        if (answer.toLowerCase() === 's') return { ok: false, note: 'skipped by the user', files: [] };
        const floor = Number(answer);
        if (!Number.isInteger(floor) || floor < 1) {
          log('  please type the floor number, e.g. 12');
          continue;
        }
        await pause(1, 2);
        const html = await page.content();
        const doc = parseDocument(html);
        const marks = likedMarkers(doc.querySelector(`.topic-post[data-post-number="${floor}"]`) ?? doc);
        // The user's word that this floor is liked is the ground truth; recording that floor's like
        // controls shows which marker the site really uses, including one Appendix A does not list.
        const post = doc.querySelector(`.topic-post[data-post-number="${floor}"], #post_${floor}`);
        if (!post) {
          log(`  floor ${floor} is not rendered on this page; scroll it into view and try again`);
          continue;
        }
        const controls = Array.from(post.querySelectorAll('.post-controls button, .post-controls [class*="reaction"], .post-controls [class*="like"]'))
          .map((el) => `${el.tagName.toLowerCase()}.${(el.getAttribute('class') ?? '').trim().split(/\s+/).join('.')}${el.getAttribute('title') ? `[title="${el.getAttribute('title')}"]` : ''}`)
          .filter((sig, i, all) => all.indexOf(sig) === i);
        const file = await save('liked', html);
        return {
          ok: true,
          note: `floor ${floor}; A03 markers on that floor ${JSON.stringify(marks)}`,
          files: [file],
          likedFloor: floor,
          likedFloorControls: controls,
          url: scrubWith(mapping, page.url()),
        };
      }
      return { ok: false, note: 'no liked floor recorded after 3 attempts', files: [] };
    });

    await step('login-form', async () => {
      await pause(1, 2);
      // A separate, empty browser: the login form only renders for a visitor without a session.
      const browser = await chromium.launch({ channel: opts.channel, headless: false, args: LAUNCH_ARGS, ignoreDefaultArgs: IGNORE_DEFAULT_ARGS });
      try {
        const visitor = await (await browser.newContext({ viewport: null })).newPage();
        await visitor.goto(new URL('/login', base).href, { waitUntil: 'domcontentloaded' });
        await visitor.locator(SELECTORS.loginUsername).waitFor({ timeout: 20_000 });
        await pause(1, 2);
        const file = await save('login', await visitor.content());
        return { ok: true, note: 'login form rendered for a signed-out visitor', files: [file] };
      } finally {
        await browser.close();
      }
    });
  } finally {
    await session.close();
  }
  const metaPath = join(opts.outDir, 'capture.json');
  if (opts.steps) {
    const earlier = await readFile(metaPath, 'utf8').then((t) => JSON.parse(t) as CaptureReport, () => null);
    if (earlier) report.steps = { ...earlier.steps, ...report.steps };
  }
  await writeFile(metaPath, JSON.stringify(report, null, 2) + '\n');
  return report;
}

interface ProgressDeps {
  save(name: string, html: string): Promise<string>;
  sleep(ms: number): Promise<void>;
}

const values = (s: LevelSnapshot | null) => Object.fromEntries((s?.metrics ?? []).map((m) => [m.label, m.current]));

/** S07 for connect: enter, wait 2 s, reload, wait for the page, then read. */
async function captureConnect(
  page: Page,
  url: string,
  deps: ProgressDeps & { ask(q: string): Promise<string>; log(m: string): void },
): Promise<StepRecord> {
  const files: string[] = [];
  const ready = () => page.locator(CONNECT_READY).first().waitFor({ timeout: PROGRESS_READY_MS }).then(() => true, () => false);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  let authorizePage = false;
  if (!(await ready())) {
    authorizePage = true;
    files.push(await deps.save('connect-authorize', await page.content()));
    await deps.ask('connect did not show the progress page (an authorization page?). Finish it in the Chrome window until the progress page shows, then press Enter.');
    if (!(await ready())) return { ok: false, note: 'connect progress structure never appeared', files, authorizePage };
  }
  await deps.sleep(2_000);
  const before = parseConnect(parseDocument(await page.content()));
  await page.reload({ waitUntil: 'domcontentloaded' });
  if (!(await ready())) return { ok: false, note: 'connect progress structure missing after reload', files, authorizePage };
  await deps.sleep(1_000);
  const html = await page.content();
  const after = parseConnect(parseDocument(html));
  files.push(await deps.save('connect', html));
  return {
    ok: true,
    note: `${after.metrics.length} metrics, level ${String(after.level)} → ${String(after.nextLevel)}`,
    files,
    authorizePage,
    beforeReload: values(before),
    afterReload: values(after),
  };
}

/**
 * S07 for the docofcard trust level page. Also answers §17: the loader-to-table time, and whether
 * a reload changes the values (a cache like connect's).
 */
async function captureTrustLevel(page: Page, url: string, deps: ProgressDeps & { scrub(s: string): string }): Promise<StepRecord> {
  const S = TRUST_LEVEL_SELECTORS;
  const files: string[] = [];
  let loaderHtml: string | null = null;
  const untilTable = async (): Promise<{ loaderMs: number | null; tableMs: number }> => {
    const start = systemClock.monotonic();
    let loaderSeen: number | null = null;
    while (systemClock.monotonic() - start < TRUST_LEVEL_READY_MS) {
      const [loader, rows] = await Promise.all([
        page.locator(S.loader).count().catch(() => 0),
        page.locator(S.rows).count().catch(() => 0),
      ]);
      if (rows > 0) {
        const tableMs = systemClock.monotonic() - start;
        return { loaderMs: loaderSeen === null ? null : tableMs - (loaderSeen - start), tableMs };
      }
      if (loader > 0 && loaderSeen === null) {
        loaderSeen = systemClock.monotonic();
        loaderHtml ??= await page.content().catch(() => null);
      }
      await deps.sleep(50);
    }
    throw new RunError('page-timeout', `no ${S.rows} within ${TRUST_LEVEL_READY_MS / 1000} s`);
  };

  await page.goto(url, { waitUntil: 'commit' });
  const first = await untilTable();
  const before = parseTrustLevel(parseDocument(await page.content()));
  await page.reload({ waitUntil: 'commit' });
  const second = await untilTable();
  await deps.sleep(1_000);
  const html = await page.content();
  const after = parseTrustLevel(parseDocument(html));
  files.push(await deps.save('trust-level', html));
  if (loaderHtml) files.push(await deps.save('trust-level-loader', loaderHtml));
  const snap = (p: typeof after) => (p.state === 'ready' ? p.snapshot : null);
  return {
    ok: after.state === 'ready',
    note: `${snap(after)?.metrics.length ?? 0} rows; loader ${loaderHtml ? 'captured' : 'not caught (table rendered first)'}`,
    files,
    redirectedTo: deps.scrub(page.url()),
    timings: { firstLoad: first, afterReload: second },
    beforeReload: values(snap(before)),
    afterReload: values(snap(after)),
  };
}

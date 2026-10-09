// Runs every selector of the design's table and both progress parsers over the captured fixtures
// and writes docs/PHASE0_REPORT.md. Counts come from linkedom and, unless --no-browser, are
// cross-checked in headless system Chrome with the fixture loaded offline (scripts off, every
// request aborted). Nothing here touches a real site.
//   pnpm verify:selectors [--no-browser] [--fixtures <dir>] [--report <file>]
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium, type Browser } from 'playwright-core';
import {
  categoryLinks,
  isLiked,
  editorKind,
  LIKE_FALLBACK_SELECTORS,
  CATEGORY_NAME_SELECTORS,
  likedMarkers,
  parseConnect,
  parseDocument,
  parseFloorCounter,
  parseTopicList,
  parseTrustLevel,
  progressModuleFor,
  SELECTORS,
  TRUST_LEVEL_SELECTORS,
  type SelectorName,
} from '@disco-lurk/site-discourse';
import { BUILTIN_SITES } from '../packages/cli/src/sites';

const { values: cli } = parseArgs({
  options: { 'no-browser': { type: 'boolean' }, fixtures: { type: 'string' }, report: { type: 'string' } },
});
const fixturesDir = resolve(cli.fixtures ?? 'tests/fixtures');
const reportPath = resolve(cli.report ?? 'docs/PHASE0_REPORT.md');
const useBrowser = !cli['no-browser'];

const LOGGED_IN = ['categories', 'list', 'list-sorted', 'topic-wide', 'topic-narrow', 'reply-editor', 'liked'];
const TOPICS = ['topic-wide', 'topic-narrow', 'reply-editor', 'liked'];

interface Expectation {
  /** Fixtures in which the selector must match; `any` means at least one of them suffices. */
  in: string[];
  mode: 'each' | 'any';
  min?: number;
  /** Selectors sharing a group pass together when any one of them matches (liked markers, editors). */
  group?: string;
  /** Words used to suggest replacements found in the fixture when the selector misses. */
  hints: string[];
  note?: string;
}

/**
 * Selectors whose miss is a fact about the data at capture time, not a broken selector; recorded as
 * such instead of failing (rulings on the fixture report).
 */
const ABSENT_IN_DATA: Record<string, Partial<Record<SelectorName, string>>> = {
  docofcard: {
    newTopicBadge:
      '数据上未出现，无法验证：本次 10 个板块均无从未访问的话题；同日首次采集曾在 /c/bank/6 见过 1 次。新话题徽标在该站的有效性留待列表点击计数的在线验证',
  },
};

/** Site facts found while capturing fixtures that the selector table cannot show. */
const SITE_NOTES: Record<string, string[]> = {
  docofcard: [
    '列表由站点主题渲染（`gf-*`），表头没有排序按钮；两站统一用 `?order=posts` 按回复数排序进入，本次 list-sorted 即由该地址打开。',
    '`/c/uncategorized/1` 有时渲染成新闻流卡片（`docofcard-news-feed`），没有 `tr.topic-list-item`；collectTopics 按空板块跳过并记 `empty-category`。',
    '信任等级页的 loader 在表格出现后仍留在 DOM 中；就绪只看表格行（上限 10 s）。',
  ],
};

/** Where each selector of the design's table is expected to match, by fixture kind. */
const EXPECT: Record<SelectorName, Expectation> = {
  currentUser: { in: LOGGED_IN, mode: 'each', hints: ['current-user', 'header-dropdown', 'user-menu'] },
  loginUsername: { in: ['login'], mode: 'each', hints: ['login', 'account-name', 'username'] },
  loginPassword: { in: ['login'], mode: 'each', hints: ['password'] },
  loginButton: { in: ['login'], mode: 'each', hints: ['login-button', 'btn-primary', 'submit'] },
  topicRow: { in: ['list', 'list-sorted'], mode: 'each', hints: ['topic-list-item', 'topic-list'] },
  pinnedRow: { in: ['list'], mode: 'each', hints: ['pinned'] },
  topicLink: { in: ['list', 'list-sorted'], mode: 'each', hints: ['raw-topic-link', 'title'] },
  newTopicBadge: { in: ['list'], mode: 'each', hints: ['new-topic', 'badge-notification'] },
  unreadPostsBadge: {
    in: ['list', 'list-sorted'],
    mode: 'any',
    hints: ['unread-posts', 'badge-notification'],
    note: 'only rendered for topics with new replies since the last visit; used by the useUnreadList switch',
  },
  floorWide: { in: ['topic-wide'], mode: 'each', hints: ['timeline'] },
  floorNarrow: { in: ['topic-narrow'], mode: 'each', min: 3, hints: ['topic-progress', 'nums'] },
  firstPost: { in: TOPICS, mode: 'any', hints: ['data-post-number', 'topic-post'] },
  firstPostById: { in: TOPICS, mode: 'any', hints: ['post_'] },
  likeButton: { in: ['topic-wide', 'liked'], mode: 'each', hints: ['like', 'reaction'] },
  likedReacted: { in: ['liked'], mode: 'any', hints: ['has-reacted', 'reaction'] },
  likedIcon: { in: ['liked'], mode: 'any', hints: ['d-liked', 'reaction'], note: 'second evidence' },
  replyOpen: { in: ['reply-editor'], mode: 'each', hints: ['topic-footer', 'create', 'reply'] },
  replyTextarea: { in: ['reply-editor'], mode: 'any', group: 'editor', hints: ['reply-control', 'textarea', 'editor'], note: 'textarea or .d-editor-input is enough' },
  replyEditor: { in: ['reply-editor'], mode: 'any', group: 'editor', hints: ['d-editor', 'ProseMirror', 'editor'], note: 'textarea or .d-editor-input is enough' },
  replySubmit: { in: ['reply-editor'], mode: 'each', hints: ['reply-control', 'create', 'submit'] },
};

const CONNECT_SELECTORS = [
  '.card-subtitle',
  '.card-title',
  '.tl3-ring',
  '.tl3-ring-label',
  '.tl3-ring-current',
  '.tl3-ring-target',
  '.tl3-bar-item',
  '.tl3-bar-label',
  '.tl3-bar-nums',
  '.tl3-quota-card',
  '.tl3-quota-label',
  '.tl3-quota-nums',
  '.tl3-veto-item',
  '.tl3-veto-label',
  '.tl3-veto-value',
];

type Counts = Record<string, { dom: number; browser: number | null }>;

async function browserCounts(browser: Browser | null, html: string, selectors: string[]): Promise<Record<string, number> | null> {
  if (!browser) return null;
  const context = await browser.newContext({ javaScriptEnabled: false, offline: true });
  try {
    const page = await context.newPage();
    await page.route('**/*', (route) => route.abort());
    await page.setContent(html, { waitUntil: 'domcontentloaded' });
    const out: Record<string, number> = {};
    for (const s of selectors) out[s] = await page.locator(s).count();
    return out;
  } finally {
    await context.close();
  }
}

/** Distinct `tag.class` signatures (with counts) of elements whose id or class mentions a hint. */
function candidates(doc: Document, hints: string[]): string[] {
  const seen = new Map<string, number>();
  for (const el of Array.from(doc.querySelectorAll('*'))) {
    const cls = (el.getAttribute('class') ?? '').trim();
    const id = el.getAttribute('id') ?? '';
    const attrs = Array.from(el.attributes).map((a) => a.name).join(' ');
    const hay = `${cls} ${id} ${attrs}`.toLowerCase();
    if (!hints.some((h) => hay.includes(h.toLowerCase()))) continue;
    const sig = `${el.tagName.toLowerCase()}${id ? `#${id}` : ''}${cls ? '.' + cls.split(/\s+/).slice(0, 4).join('.') : ''}`;
    seen.set(sig, (seen.get(sig) ?? 0) + 1);
  }
  return [...seen.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([sig, n]) => `\`${sig}\` ×${n}`);
}

const short = (v: unknown) => {
  const s = JSON.stringify(v);
  return s.length > 300 ? s.slice(0, 297) + '…' : s;
};

function parseResult(kind: string, doc: Document, baseUrl: string): string {
  try {
    switch (kind) {
      case 'list':
      case 'list-sorted': {
        const rows = parseTopicList(doc);
        return short({
          rows: rows.length,
          pinned: rows.filter((r) => r.pinned).length,
          newTopic: rows.filter((r) => r.unread).length,
          unreadPosts: rows.filter((r) => r.unreadPosts).length,
          withoutTitleLink: rows.filter((r) => !r.hasTitleLink).length,
          sample: rows.slice(0, 3).map((r) => ({ id: r.id, pinned: r.pinned, unread: r.unread })),
        });
      }
      case 'topic-wide':
      case 'topic-narrow':
        return short(parseFloorCounter(doc));
      case 'liked':
        return short(likedMarkers(doc));
      case 'reply-editor':
        return short({ editor: editorKind(doc) });
      case 'categories': {
        const links = categoryLinks(doc, baseUrl);
        return short({ categoryLinks: links.length, sample: links.slice(0, 5) });
      }
      case 'connect':
        return short(parseConnect(doc));
      case 'trust-level':
      case 'trust-level-loader':
        return short(parseTrustLevel(doc));
      default:
        return '—';
    }
  } catch (err) {
    return `🔴 ${(err as Error).name}: ${(err as Error).message}`;
  }
}

async function main() {
  const browser = useBrowser ? await chromium.launch({ channel: 'chrome', headless: true }).catch(() => null) : null;
  const out: string[] = [];
  const failures: string[] = [];
  const connectLabels: string[] = [];
  out.push('# fixture 与选择器复核报告', '');
  out.push(`> 由 \`pnpm verify:selectors\` 生成于 ${new Date().toISOString()}；计数来源 linkedom${browser ? '，并在无头 Chrome 中离线复核（脚本关闭、请求全部拦截）' : '（未做浏览器复核）'}。`);
  out.push('> 🔴 = 未命中或解析异常（附 fixture 中的替代候选，附录 A 未改动，待确认）。', '');
  out.push(
    '## 采集方法',
    '',
    '`lurk capture` 用应用专属 Profile 启动有头 Chrome，用户本人登录后按附录 B 的节奏访问；候选话题只从列表点击进入，不点赞、不输入、不提交。经规格方确认的做法：',
    '',
    '- 窄布局快照在窗口宽 880 px 下保存（< 1000 px，低于 Discourse 切换时间线的宽度）。',
    '- 登录表单 fixture 来自另开的未登录浏览器访问 `/login`。',
    '- 已赞话题由用户本人在采集窗口中导航打开，程序只读取 DOM。',
    '- 回复编辑器在一个短话题中打开（长话题须加载到底部才渲染 footer 按钮），随后关闭。',
    '',
  );

  for (const site of BUILTIN_SITES) {
    const dir = join(fixturesDir, site.id);
    out.push(`## ${site.id}（${site.displayName}）`, '');
    const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.html') && !f.endsWith('.leak.html')) : [];
    const leaks = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.leak.html')) : [];
    if (files.length === 0) {
      out.push('🔴 尚无 fixture：先运行 `pnpm lurk capture --site ' + site.id + '`。', '');
      failures.push(`${site.id}: no fixtures`);
      continue;
    }
    if (leaks.length) {
      out.push(`🔴 脱敏后仍含身份信息、未纳入版本库：${leaks.join('、')}`, '');
      failures.push(`${site.id}: leaked ${leaks.join(', ')}`);
    }
    const metaPath = join(dir, 'capture.json');
    type CaptureMeta = { capturedAt: string; discourseVersion: string | null; steps: Record<string, { ok: boolean; note: string } & Record<string, unknown>> };
    const meta = existsSync(metaPath) ? (JSON.parse(readFileSync(metaPath, 'utf8')) as CaptureMeta) : null;
    if (meta) {
      out.push(`采集于 ${meta.capturedAt}，Discourse \`${meta.discourseVersion ?? '未知'}\`。`, '');
      out.push('| 采集步骤 | 结果 | 说明 |', '|---|---|---|');
      for (const [name, r] of Object.entries(meta.steps)) out.push(`| ${name} | ${r.ok ? 'ok' : '🔴'} | ${r.note.replace(/\|/g, '\\|')} |`);
      out.push('');
      const liked = meta.steps.liked;
      if (liked?.ok) {
        const { ok: _ok, note: _note, files: _files, ...detail } = liked;
        out.push('已赞楼层（用户指认）上的点赞控件：', '', '```json', JSON.stringify(detail, null, 2), '```', '');
      }
      const progress = meta.steps.progress;
      if (progress) {
        const { ok: _ok, note: _note, files: _files, ...detail } = progress;
        out.push('进度页采集细节（强刷前后、loader 耗时、授权页）：', '', '```json', JSON.stringify(detail, null, 2), '```', '');
      }
    }

    const kinds = new Map(files.map((f) => [f.replace(/\.html$/, ''), f]));
    const docs = new Map<string, Document>();
    const counts = new Map<string, Counts>();
    const progressSelectors =
      site.progressSource === 'connect-linuxdo' ? CONNECT_SELECTORS : site.progressSource === 'trust-level-docofcard' ? Object.values(TRUST_LEVEL_SELECTORS) : [];
    const all = [...Object.values(SELECTORS), ...LIKE_FALLBACK_SELECTORS, ...CATEGORY_NAME_SELECTORS, ...progressSelectors];
    for (const [kind, file] of kinds) {
      const html = readFileSync(join(dir, file), 'utf8');
      const doc = parseDocument(html);
      docs.set(kind, doc);
      const b = await browserCounts(browser, html, all);
      const c: Counts = {};
      for (const s of all) c[s] = { dom: doc.querySelectorAll(s).length, browser: b?.[s] ?? null };
      counts.set(kind, c);
    }
    const cell = (kind: string, sel: string) => {
      const c = counts.get(kind)?.[sel];
      if (!c) return '—';
      return c.browser === null || c.browser === c.dom ? String(c.dom) : `🔴 ${c.dom} / Chrome ${c.browser}`;
    };

    out.push('### 附录 A 选择器', '');
    out.push('| 选择器 | 期望出现于 | 命中数（fixture: 数量） | 判定 |', '|---|---|---|---|');
    const misses: string[] = [];
    const entries = Object.entries(SELECTORS) as Array<[SelectorName, string]>;
    const passes = (name: SelectorName) => {
      const e = EXPECT[name];
      const sel = SELECTORS[name];
      const present = e.in.filter((k) => kinds.has(k));
      const hit = (k: string) => (counts.get(k)?.[sel]?.dom ?? 0) >= (e.min ?? 1);
      return present.length > 0 && (e.mode === 'each' ? present.every(hit) : present.some(hit));
    };
    for (const [name, sel] of entries) {
      const e = EXPECT[name];
      const present = e.in.filter((k) => kinds.has(k));
      const missingFixtures = e.in.filter((k) => !kinds.has(k));
      const hits = present.map((k) => `${k}: ${cell(k, sel)}`).join('<br>') || '—';
      const self = passes(name);
      const groupHit = e.group ? entries.some(([other]) => EXPECT[other].group === e.group && passes(other)) : false;
      let verdict: string;
      const absent = ABSENT_IN_DATA[site.id]?.[name];
      const optional = name === 'unreadPostsBadge' || absent !== undefined;
      if (present.length === 0) verdict = `🔴 缺 fixture（${missingFixtures.join('、')}）`;
      else if (absent && !self) verdict = absent;
      else if (name === 'unreadPostsBadge' && !self) {
        const rows = present.flatMap((k) => parseTopicList(docs.get(k)!));
        const visited = rows.filter((r) => !r.pinned && !r.unread).length;
        verdict = `未出现，无法验证（${present.join('、')} 中 ${visited} 个已访问话题均无此徽标；fixture 无独立信号可确认它们当时没有新回复）`;
      }
      else if (self) verdict = missingFixtures.length ? `ok（缺 ${missingFixtures.join('、')}）` : 'ok';
      else if (groupHit) verdict = 'ok（同组其他选择器命中）';
      else verdict = '🔴 未命中';
      out.push(`| \`${sel}\` | ${e.in.join('、')}${e.mode === 'any' ? '（任一）' : ''}${e.min ? `，≥${e.min}` : ''} | ${hits} | ${verdict} |`);
      if (verdict.startsWith('🔴')) failures.push(`${site.id}: ${sel}${present.length ? '' : '（缺 fixture）'}`);
      if (present.length > 0 && !self && !groupHit && !optional) {
        const sugg = present.map((k) => `${k}: ${candidates(docs.get(k)!, e.hints).join('，') || '无'}`);
        misses.push(`- 🔴 \`${sel}\`${e.note ? `（${e.note}）` : ''}\n  - 替代候选：${sugg.join('；')}`);
      }
    }
    out.push('');
    if (misses.length) out.push('未命中选择器的替代候选：', '', ...misses, '');

    const likedStep = meta?.steps.liked as { likedFloor?: number } | undefined;
    if (kinds.has('liked') && likedStep?.likedFloor) {
      const floor = likedStep.likedFloor;
      const doc = docs.get('liked')!;
      const post = doc.querySelector(`.topic-post[data-post-number="${floor}"]`);
      const others = Array.from(doc.querySelectorAll('.topic-post[data-post-number]')).filter((p) => p !== post);
      out.push(
        `已赞判定（以用户指认的第 ${floor} 楼为准）：该楼 ${post ? JSON.stringify(likedMarkers(post)) : '未渲染'}，判定 ${post && isLiked(post) ? '已赞' : '🔴 未识别'}；` +
          `同页其余 ${others.length} 个楼层中判为已赞的 ${others.filter((p) => isLiked(p)).length} 个。`,
        '',
      );
      if (!post || !isLiked(post)) failures.push(`${site.id}: liked state of floor ${floor} not recognised`);
    }
    out.push('### 点赞备用选择器（仅诊断用）', '');
    out.push('| 选择器 | 命中数 |', '|---|---|');
    for (const sel of LIKE_FALLBACK_SELECTORS) {
      out.push(`| \`${sel}\` | ${['topic-wide', 'liked'].filter((k) => kinds.has(k)).map((k) => `${k}: ${cell(k, sel)}`).join('<br>') || '—'} |`);
    }
    out.push('');

    if (progressSelectors.length) {
      const pk = site.progressSource === 'connect-linuxdo' ? ['connect'] : ['trust-level', 'trust-level-loader'];
      out.push(`### 进度页选择器（${site.progressSource === 'connect-linuxdo' ? 'connect.linux.do' : '信任等级页'}）`, '');
      out.push('| 选择器 | 命中数 |', '|---|---|');
      for (const sel of progressSelectors) {
        const hits = pk.filter((k) => kinds.has(k)).map((k) => `${k}: ${cell(k, sel)}`);
        const zero = pk.filter((k) => kinds.has(k)).every((k) => (counts.get(k)?.[sel]?.dom ?? 0) === 0);
        if (zero) failures.push(`${site.id}: ${sel}${hits.length ? '' : '（缺进度页 fixture）'}`);
        out.push(`| \`${sel}\` | ${hits.join('<br>') || '🔴 无进度页 fixture'}${zero && hits.length ? ' 🔴' : ''} |`);
      }
      out.push('');
    }

    if (kinds.has('categories')) {
      const doc = docs.get('categories')!;
      const links = categoryLinks(doc, site.baseUrl);
      out.push('### categories 页（附录 A 板块发现）', '');
      out.push('| 名称选择器 | 命中数 |', '|---|---|');
      for (const sel of CATEGORY_NAME_SELECTORS) out.push(`| \`${sel}\` | ${cell('categories', sel)} |`);
      out.push('', `slug/id 取自 \`a[href]\` 的 \`/c/<slug>/<id>\`，名称只取链接内的上表选择器（子板块与话题行上的徽章不算板块条目）：解析出 ${links.length} 个板块。`, '');
      out.push('| 名称 | 路径 | id |', '|---|---|---|', ...links.map((c) => `| ${c.name} | \`${c.path}\` | ${c.id} |`), '');
      if (links.length === 0) failures.push(`${site.id}: categories page yielded no named category`);
    }

    if (SITE_NOTES[site.id]) out.push('### 站点事实（记录）', '', ...SITE_NOTES[site.id]!.map((n) => `- ${n}`), '');

    out.push('### 解析结果', '');
    out.push('| fixture | 解析结果 |', '|---|---|');
    for (const [kind, doc] of docs) out.push(`| ${kind} | \`${parseResult(kind, doc, site.baseUrl).replace(/\|/g, '\\|')}\` |`);
    out.push('');

    if (site.progressSource === 'connect-linuxdo' && docs.has('connect')) {
      try {
        const module = progressModuleFor(site)!;
        for (const m of parseConnect(docs.get('connect')!).metrics) {
          connectLabels.push(`| ${m.label} | ${m.current} | ${m.required ?? '—'} | \`${module.labelMap[m.label] ?? 'other'}\` |`);
        }
      } catch {
        // The parse failure is already reported in the table above.
      }
    }
  }

  out.push('## CONNECT-002：connect 标签 → MetricKey', '');
  if (connectLabels.length) out.push('| 页面标签 | 当前值 | 要求 | 当前映射 |', '|---|---|---|---|', ...connectLabels, '');
  else out.push('🔴 尚无 linuxdo connect fixture。', '');

  out.push('## 汇总', '');
  out.push(failures.length ? failures.map((f) => `- 🔴 ${f}`).join('\n') : '- 全部选择器在两站 fixture 上命中，解析正常。', '');
  writeFileSync(reportPath, out.join('\n'));
  await browser?.close();
  console.log(`${reportPath}: ${failures.length ? `${failures.length} problem(s)` : 'all selectors matched'}`);
  process.exitCode = failures.length ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

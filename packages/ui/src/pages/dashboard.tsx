import { estimateMetrics, type LevelSnapshot, type RunStats } from '@disco-lurk/core';
import type { ActiveRun, ProfileView } from '@disco-lurk/server/contract';
import { copy } from '../copy';
import { dateTime, duration } from '../format';
import { useStore } from '../store';

type Meter = { label: string; current: number; required: number; limit: boolean; met: boolean; estimated: boolean; delta: number | null };

/**
 * One meter per requirement that has a target. During a run the value is the local estimate where
 * one exists; afterwards it is the site's final reading.
 */
function meters(levels: { initial: LevelSnapshot | null; final: LevelSnapshot | null }, stats: RunStats | undefined, baselineMissing: boolean): Meter[] {
  const shown = levels.final ?? levels.initial;
  if (!shown) return [];
  const estimates = !levels.final && stats ? estimateMetrics(levels.initial, stats) : [];
  return shown.metrics.flatMap((m) => {
    if (m.required === null) return [];
    const est = estimates.find((e) => e.label === m.label)?.estimated ?? null;
    const current = est ?? m.current;
    const limit = m.limit === true;
    const before = levels.final && !baselineMissing ? levels.initial?.metrics.find((x) => x.label === m.label) : undefined;
    return [{ label: m.label, current, required: m.required, limit, met: limit ? current <= m.required : current >= m.required, estimated: est !== null, delta: before ? m.current - before.current : null }];
  });
}

function GoalMeter(props: { m: Meter }) {
  const { m } = props;
  const pct = m.required > 0 ? Math.min(100, (m.current / m.required) * 100) : 100;
  return (
    <li class={`meter${m.met ? ' met' : ''}`}>
      <div class="meter-head">
        <span class="meter-label">{m.label}</span>
        <span class="meter-value">
          {m.delta !== null && m.delta > 0 && <span class="meter-delta">+{m.delta}</span>}
          <strong>{m.current}</strong>
          <span class="muted"> / {m.required}</span>
        </span>
      </div>
      <div class="meter-track" role="meter" aria-label={m.label} aria-valuemin={0} aria-valuemax={m.required} aria-valuenow={Math.min(m.current, m.required)}>
        <div class="meter-fill" style={{ width: `${pct}%` }} />
      </div>
      <div class="meter-foot">
        {m.met ? <span class="ok">✓ {copy.dashboard.done}</span> : <span>{copy.dashboard.left(m.required - m.current)}</span>}
        {m.estimated && <span class="badge">{copy.levels.estimateBadge}</span>}
      </div>
    </li>
  );
}

function LimitRow(props: { m: Meter }) {
  const { m } = props;
  return (
    <li class={`limit${m.met ? ' met' : ' over'}`}>
      <span class="limit-mark" aria-hidden="true">
        {m.met ? '✓' : '✕'}
      </span>
      <span class="limit-label">{m.label}</span>
      <span class="limit-value">
        <strong>{m.current}</strong>
        <span class="muted"> · {copy.dashboard.ceiling(m.required)}</span>
      </span>
      {!m.met && <span class="limit-over">{copy.dashboard.over}</span>}
    </li>
  );
}

function LevelHero(props: { snapshot: LevelSnapshot | null; goals: Meter[]; profiles: ProfileView[] }) {
  const s = props.snapshot;
  const met = props.goals.filter((g) => g.met).length;
  const total = props.goals.length;
  const pct = s?.percent ?? (total ? Math.round((met / total) * 100) : 0);
  return (
    <div class="hero">
      <div class="hero-level">
        <span class="hero-caption">{copy.levels.level}</span>
        <span class="hero-number">{s?.level ?? '—'}</span>
        {s?.nextLevel !== undefined && <span class="hero-next">→ {s.nextLevel}</span>}
      </div>
      <div class="hero-progress">
        <div class="hero-progress-head">
          <span>{total ? copy.dashboard.met(met, total) : copy.dashboard.noProgress}</span>
          <strong>{total || s?.percent !== undefined ? `${pct}%` : ''}</strong>
        </div>
        <div class="meter-track big">
          <div class="meter-fill" style={{ width: `${pct}%` }} />
        </div>
      </div>
      <ul class="hero-accounts">
        {props.profiles.length === 0 && <li class="muted">{copy.common.none}</li>}
        {props.profiles.map((p) => (
          <li key={p.id}>
            <span class={`chip status-${p.status}`}>{copy.profiles.statuses[p.status]}</span>
            <span>{p.health?.username ? `@${p.health.username}` : p.name}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function StatTiles(props: { stats: RunStats | undefined; title: string; when: string }) {
  const c = props.stats?.confirmed;
  const s = copy.stats;
  const tiles = [
    { label: s.topics, value: c?.topics },
    { label: s.floors, value: c?.floors },
    { label: s.likes, value: c ? c.likes + c.replyLikes : undefined },
    { label: s.replies, value: c?.replies },
    { label: s.elapsed, value: props.stats ? duration(props.stats.elapsedMs) : undefined },
  ];
  return (
    <div class="tiles-block">
      <div class="tiles-head">
        <h3>{props.title}</h3>
        <span class="muted">{props.when}</span>
      </div>
      <div class="tiles">
        {tiles.map((t) => (
          <div class="tile" key={t.label}>
            <span class="tile-value">{t.value ?? '—'}</span>
            <span class="tile-label">{t.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Per site: where the account stands against the next level, and what the latest run did. */
export function DashboardPage(props: { go(page: 'run'): void }) {
  const [state] = useStore();
  const active = Object.values(state.runs).filter((r) => !r.result);
  return (
    <div class="page dashboard">
      <h1>{copy.dashboard.title}</h1>
      {state.sites.map(({ site }) => {
        const profiles = state.profiles.filter((p) => p.siteId === site.id);
        const last = state.history.find((r) => r.plan.siteId === site.id);
        const running: ActiveRun[] = active.filter((r) => r.plan.siteId === site.id);
        // The run going now, else the last one that ended.
        const now = running[0];
        const stats = now ? state.live[now.runId]?.stats : last?.result.stats;
        const levels = now ? (state.live[now.runId]?.levels ?? { initial: null, final: null }) : (last?.result.levels ?? { initial: null, final: null });
        // A run that has not read the progress page yet still shows where the last one left off.
        const shownLevels = levels.initial || levels.final ? levels : (last?.result.levels ?? levels);
        const all = meters(shownLevels, now ? stats : undefined, !now && last?.result.baseline === 'missing');
        const goals = all.filter((m) => !m.limit);
        const limits = all.filter((m) => m.limit);
        const when = now ? copy.states[now.state] : last ? `${dateTime(last.endedAt)} · ${copy.states[last.result.outcome]}` : copy.dashboard.never;
        return (
          <section class="panel site" key={site.id}>
            <div class="panel-head">
              <div class="site-title">
                <h2>{site.displayName}</h2>
                <span class="muted">{site.baseUrl.replace(/^https?:\/\//, '')}</span>
              </div>
              <div class="row">
                <span class={`chip ${now ? `state-${now.state}` : ''}`}>{running.length ? `${copy.dashboard.running} ${running.length}` : copy.dashboard.idle}</span>
                <button type="button" onClick={() => props.go('run')}>
                  {copy.dashboard.openRun}
                </button>
              </div>
            </div>
            <div class="site-top">
              <LevelHero snapshot={shownLevels.final ?? shownLevels.initial} goals={goals} profiles={profiles} />
              <StatTiles stats={stats} title={now ? copy.dashboard.thisRun : copy.dashboard.lastRunStats} when={when} />
            </div>
            {goals.length > 0 && (
              <>
                <h3 class="section-title">{copy.dashboard.goals}</h3>
                <ul class="meters">
                  {goals.map((m) => (
                    <GoalMeter key={m.label} m={m} />
                  ))}
                </ul>
              </>
            )}
            {limits.length > 0 && (
              <>
                <h3 class="section-title">{copy.dashboard.limits}</h3>
                <ul class="limits">
                  {limits.map((m) => (
                    <LimitRow key={m.label} m={m} />
                  ))}
                </ul>
              </>
            )}
          </section>
        );
      })}
    </div>
  );
}

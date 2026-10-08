import { estimateMetrics, reportedTopicsShortfall, type LevelSnapshot, type MetricKey, type RunEvent, type RunResult, type RunStats } from '@disco-lurk/core';
import { copy } from '../copy';
import { duration } from '../format';

type Row = { label: string; attempted: number; confirmed: number; reported?: MetricKey; note?: string };

function reportedDelta(stats: RunStats, key: MetricKey | undefined): string {
  const r = key ? stats.reported?.[key] : undefined;
  if (!r) return '—';
  if (r.initial === undefined) return `= ${r.final}`;
  const d = r.final - r.initial;
  return `${d >= 0 ? '+' : ''}${d}`;
}

/** Attempted, confirmed and site-reported counts side by side, each in its own colour. */
export function StatsPanel(props: { stats: RunStats }) {
  const { attempted: a, confirmed: c } = props.stats;
  const s = copy.stats;
  const rows: Row[] = [
    { label: s.topics, attempted: a.topics, confirmed: c.topics, reported: 'topicsViewed' },
    { label: s.floors, attempted: a.floors, confirmed: c.floors, reported: 'postsRead' },
    { label: s.likes, attempted: a.likes, confirmed: c.likes, reported: 'likesGiven', note: '站点"点赞"含主帖与回复点赞' },
    { label: s.replyLikes, attempted: a.replyLikes, confirmed: c.replyLikes },
    { label: s.replies, attempted: a.replies, confirmed: c.replies, reported: 'repliesPosted' },
  ];
  return (
    <div class="panel">
      <div class="panel-head">
        <h3>{s.title}</h3>
        <span class="muted">
          {s.elapsed} {duration(props.stats.elapsedMs)} · {s.estimatedFloors} {props.stats.estimatedFloors}
        </span>
      </div>
      <table class="stats">
        <thead>
          <tr>
            <th />
            <th class="t-attempted">{s.attempted}</th>
            <th class="t-confirmed">{s.confirmed}</th>
            <th class="t-reported">{s.reported}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label}>
              <th scope="row">{r.label}</th>
              <td class="t-attempted">{r.attempted}</td>
              <td class="t-confirmed">{r.confirmed}</td>
              <td class="t-reported" title={r.note}>
                {reportedDelta(props.stats, r.reported)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function head(s: LevelSnapshot | null) {
  if (!s) return null;
  return [s.username ? `@${s.username}` : null, s.level !== undefined ? `${copy.levels.level} ${s.level}` : null, s.nextLevel !== undefined ? `${copy.levels.nextLevel} ${s.nextLevel}` : null, s.percent !== undefined ? `${s.percent}%` : null]
    .filter(Boolean)
    .join(' · ');
}

/** The progress page before and after, with the local estimate marked as such. */
export function LevelTable(props: { result: RunResult; events: readonly RunEvent[] }) {
  const { levels, baseline, stats } = props.result;
  const l = copy.levels;
  if (baseline === 'not-applicable') return <div class="panel muted">{l.notApplicable}</div>;
  const estimates = estimateMetrics(levels.initial, stats);
  const labels = [...new Set([...(levels.initial?.metrics ?? []), ...(levels.final?.metrics ?? [])].map((m) => m.label))];
  const shortfall = reportedTopicsShortfall(stats);
  const lagWarned = props.events.some((e) => e.type === 'warning' && e.code === 'site-lag');
  return (
    <div class="panel">
      <div class="panel-head">
        <h3>{l.title}</h3>
        <span class="muted">{head(levels.final ?? levels.initial)}</span>
      </div>
      {baseline === 'missing' && <div class="notice warn">{l.noBaseline}</div>}
      {shortfall !== null ? <div class="notice warn">{l.lag(shortfall)}</div> : lagWarned && <div class="notice warn">{l.lagGeneric}</div>}
      <table class="levels">
        <thead>
          <tr>
            <th>{l.metric}</th>
            <th>{l.initial}</th>
            <th>
              {l.estimate} <span class="badge">{l.estimateBadge}</span>
            </th>
            <th>{l.final}</th>
            <th>{l.target}</th>
            <th>{l.delta}</th>
          </tr>
        </thead>
        <tbody>
          {labels.map((label) => {
            const a = levels.initial?.metrics.find((m) => m.label === label);
            const b = levels.final?.metrics.find((m) => m.label === label);
            const est = estimates.find((m) => m.label === label)?.estimated ?? null;
            const req = (b ?? a)?.required;
            const delta = a && b && baseline === 'present' ? b.current - a.current : null;
            return (
              <tr key={label}>
                <th scope="row">{label}</th>
                <td>{a?.current ?? '—'}</td>
                <td class="estimate">{est ?? '—'}</td>
                <td>{b?.current ?? '—'}</td>
                <td>{req ?? '—'}</td>
                <td class={delta !== null && delta > 0 ? 't-confirmed' : ''}>{delta === null ? '—' : `${delta >= 0 ? '+' : ''}${delta}`}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p class="hint">{l.estimateNote}</p>
    </div>
  );
}

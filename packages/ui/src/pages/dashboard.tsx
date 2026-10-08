import { copy } from '../copy';
import { dateTime } from '../format';
import { useStore } from '../store';

/** Per site: accounts, the latest level reading and what runs right now. */
export function DashboardPage(props: { go(page: 'run'): void }) {
  const [state] = useStore();
  const active = Object.values(state.runs).filter((r) => !r.result);
  return (
    <div class="page">
      <h1>{copy.dashboard.title}</h1>
      {state.sites.map(({ site }) => {
        const profiles = state.profiles.filter((p) => p.siteId === site.id);
        const last = state.history.find((r) => r.plan.siteId === site.id);
        const level = last?.result.levels.final ?? last?.result.levels.initial;
        const running = active.filter((r) => r.plan.siteId === site.id);
        return (
          <section class="panel" key={site.id}>
            <div class="panel-head">
              <h3>{site.displayName}</h3>
              <span class={`chip ${running.length ? 'state-browsing' : ''}`}>{running.length ? `${copy.dashboard.running} ${running.length}` : copy.dashboard.idle}</span>
            </div>
            <div class="kv">
              <span>{copy.dashboard.accounts}</span>
              <span>
                {profiles.length === 0
                  ? copy.common.none
                  : profiles.map((p) => `${p.health?.username ?? p.name}（${copy.profiles.statuses[p.status]}）`).join('、')}
              </span>
              <span>{copy.levels.level}</span>
              <span>
                {level
                  ? [level.level, level.nextLevel !== undefined ? `→ ${level.nextLevel}` : null, level.percent !== undefined ? `${level.percent}%` : null].filter((x) => x !== null && x !== undefined).join(' ')
                  : '—'}
              </span>
              <span>{copy.dashboard.lastRun}</span>
              <span>
                {last
                  ? `${dateTime(last.endedAt)} · ${copy.states[last.result.outcome]} · ${last.result.stats.confirmed.topics} ${copy.stats.topics}`
                  : copy.dashboard.never}
              </span>
            </div>
            {running.map((r) => (
              <div key={r.runId} class="status-bar">
                <span class={`chip state-${r.state}`}>{copy.states[r.state]}</span> {r.presetName} · {r.plan.profileId}
                <button type="button" onClick={() => props.go('run')}>
                  {copy.nav.run}
                </button>
              </div>
            ))}
          </section>
        );
      })}
    </div>
  );
}

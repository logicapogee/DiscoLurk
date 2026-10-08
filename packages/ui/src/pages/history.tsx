import type { RunEvent } from '@disco-lurk/core';
import type { RunRecord } from '@disco-lurk/server/contract';
import { useEffect, useState } from 'preact/hooks';
import { LogPanel } from '../components/log';
import { LevelTable, StatsPanel } from '../components/stats';
import { copy } from '../copy';
import { dateTime, duration } from '../format';
import { useStore } from '../store';

function Details(props: { record: RunRecord }) {
  const [, store] = useStore();
  const [events, setEvents] = useState<RunEvent[] | null>(null);
  useEffect(() => {
    store.api.runEvents(props.record.runId).then(setEvents, () => setEvents([]));
  }, [props.record.runId]);
  const r = props.record.result;
  return (
    <div class="details">
      {r.failure && (
        <div class="notice error">
          {copy.history.failure}：{copy.errors[r.failure.code]} · {r.failure.message}
        </div>
      )}
      <div class="columns">
        <StatsPanel stats={r.stats} />
        <LevelTable result={r} events={events ?? []} />
      </div>
      {events && <LogPanel api={store.api} runId={props.record.runId} events={events} />}
    </div>
  );
}

export function HistoryPage() {
  const [state, store] = useStore();
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => void store.refreshHistory(), []);
  const siteName = (id: string) => state.sites.find((s) => s.site.id === id)?.site.displayName ?? id;
  return (
    <div class="page">
      <h1>{copy.history.title}</h1>
      {state.history.length === 0 && <p class="muted">{copy.history.empty}</p>}
      <ul class="history">
        {state.history.map((rec) => {
          const r = rec.result;
          const c = r.stats.confirmed;
          return (
            <li class="panel" key={rec.runId}>
              <div class="panel-head">
                <h3>
                  <span class={`chip state-${r.outcome}`}>{copy.states[r.outcome]}</span> {rec.presetName}
                </h3>
                <span class="muted">
                  {siteName(rec.plan.siteId)} · {rec.plan.profileId} · {rec.plan.scheduleId ? copy.history.scheduled : copy.history.manual}
                </span>
              </div>
              <div class="kv">
                <span>{copy.history.started}</span>
                <span>{dateTime(rec.startedAt)}</span>
                <span>{copy.stats.elapsed}</span>
                <span>{duration(r.stats.elapsedMs)}</span>
                <span>{copy.history.cause}</span>
                <span>{copy.stopCauses[r.stopCause] ?? r.stopCause}</span>
                <span>{copy.stats.confirmed}</span>
                <span>
                  {c.topics} {copy.stats.topics} · {c.floors} {copy.stats.floors} · {c.likes + c.replyLikes} {copy.stats.likes} · {c.replies} {copy.stats.replies}
                </span>
              </div>
              <button type="button" onClick={() => setOpen(open === rec.runId ? null : rec.runId)} aria-expanded={open === rec.runId}>
                {open === rec.runId ? copy.history.hide : copy.history.details}
              </button>
              {open === rec.runId && <Details record={rec} />}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

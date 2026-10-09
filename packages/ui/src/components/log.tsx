import type { RunEvent } from '@disco-lurk/core';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { LoggedEvent } from '@disco-lurk/server/contract';
import type { Api } from '../api';
import { copy } from '../copy';
import { clockTime, eventText } from '../format';
import { platform } from '../platform';

const TYPES = Object.keys(copy.log.types) as Array<RunEvent['type']>;
const DEFAULT_TYPES = TYPES.filter((t) => t !== 'stats');
/** Rendering every line of a long run would stall the webview; the export still has all of them. */
const SHOWN = 800;

const level = (e: RunEvent) => (e.type === 'error' ? 'error' : e.type === 'warning' ? 'warn' : e.type === 'state' ? 'state' : 'info');

/** Exports through the sidecar to a file on the desktop, as a download in a browser. */
async function exportLog(api: Api, runId: string, types: string[]): Promise<string> {
  if (platform.desktop) {
    const res = await api.raw('POST', `/runs/${encodeURIComponent(runId)}/export`, { types });
    return copy.common.exportedTo(((await res.json()) as { path: string }).path);
  }
  const text = await api.runLog(runId, types);
  const url = URL.createObjectURL(new Blob([text], { type: 'application/x-ndjson' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${runId}.jsonl`;
  a.click();
  URL.revokeObjectURL(url);
  return '';
}

export function LogPanel(props: { api: Api; runId: string; events: readonly LoggedEvent[] }) {
  const [types, setTypes] = useState<Set<RunEvent['type']>>(new Set(DEFAULT_TYPES));
  const [note, setNote] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const shown = props.events.filter((e) => types.has(e.type));
  const tail = shown.slice(-SHOWN);

  useEffect(() => {
    const el = box.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 80) el.scrollTop = el.scrollHeight;
  }, [tail.length]);

  const flip = (t: RunEvent['type']) => {
    const next = new Set(types);
    if (next.has(t)) next.delete(t);
    else next.add(t);
    setTypes(next);
  };

  return (
    <div class="panel">
      <div class="panel-head">
        <h3>{copy.log.title}</h3>
        <button
          type="button"
          onClick={() =>
            exportLog(props.api, props.runId, [...types]).then(setNote, (err: unknown) => setNote(copy.common.error(err instanceof Error ? err.message : String(err))))
          }
        >
          {copy.log.exportFiltered}
        </button>
      </div>
      <div class="filters" role="group" aria-label={copy.log.filter}>
        {TYPES.map((t) => (
          <label key={t} class={`chip${types.has(t) ? ' on' : ''}`}>
            <input type="checkbox" checked={types.has(t)} onChange={() => flip(t)} />
            {copy.log.types[t]}
          </label>
        ))}
      </div>
      {note && <div class="hint">{note}</div>}
      <div class="log" ref={box} role="log" aria-live="polite">
        {tail.length === 0 && <div class="muted">{copy.log.empty}</div>}
        {tail.map((e) => (
          <div key={e.seq} class={`line ${level(e)}`}>
            <span class="time">{clockTime(e.at)}</span>
            <span class="kind">{copy.log.types[e.type]}</span>
            <span>{eventText(e)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

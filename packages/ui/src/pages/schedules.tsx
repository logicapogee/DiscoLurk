import type { ScheduleSpec, ScheduleView } from '@disco-lurk/core';
import { useEffect, useState } from 'preact/hooks';
import { ApiError } from '../api';
import { Field, Notice, NumberInput, Segmented, Select, Toggle } from '../components/fields';
import { apiMessage, copy } from '../copy';
import { dateTime, runModeText } from '../format';
import { useStore } from '../store';

const errorText = (err: unknown) => (err instanceof ApiError ? apiMessage(err.code, err.message) : copy.common.error(err instanceof Error ? err.message : String(err)));

function blankSpec(profileId: string, presetId: string): ScheduleSpec {
  return {
    id: `s-${Date.now().toString(36)}`,
    name: '',
    profileId,
    presetId,
    enabled: true,
    browserMode: 'headless',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    trigger: { kind: 'daily-window', runs: 2, start: '07:00', end: '23:00', jitterMinutes: 15, minGapMinutes: 60 },
    misfire: { policy: 'skip', graceMinutes: 30 },
    overlap: 'skip',
    unavailableDisplay: 'skip',
    runOnStart: false,
  };
}

function triggerText(spec: ScheduleSpec): string {
  const t = spec.trigger;
  return t.kind === 'cron' ? `cron ${t.expression}` : `${copy.schedules.triggers['daily-window']} ${t.runs} 次 · ${t.start}–${t.end}`;
}

function ScheduleForm(props: { initial: ScheduleSpec; onSaved(views: ScheduleView[]): void; onCancel(): void }) {
  const [state, store] = useStore();
  const [spec, setSpec] = useState(props.initial);
  const [error, setError] = useState('');
  const presets = state.presets.filter((p) => p.profileId);
  const preset = presets.find((p) => p.id === spec.presetId);
  const profiles = state.profiles.filter((p) => !preset || p.siteId === preset.siteId);
  const t = spec.trigger;
  const set = (patch: Partial<ScheduleSpec>) => setSpec({ ...spec, ...patch });

  const save = async (e: Event) => {
    e.preventDefault();
    setError('');
    try {
      props.onSaved((await store.api.saveSchedule({ ...spec, name: spec.name.trim() || (preset?.name ?? spec.id) })).schedules);
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <form class="panel" onSubmit={save}>
      <Field label={copy.schedules.name}>
        <input type="text" aria-label={copy.schedules.name} value={spec.name} maxLength={60} onInput={(e) => set({ name: (e.currentTarget as HTMLInputElement).value })} />
      </Field>
      <Field label={copy.schedules.preset}>
        <Select
          label={copy.schedules.preset}
          value={spec.presetId}
          options={presets.map((p) => ({ value: p.id, label: p.name }))}
          onChange={(presetId) => {
            const p = presets.find((x) => x.id === presetId);
            set({ presetId, profileId: p?.profileId ?? spec.profileId });
          }}
        />
      </Field>
      <Field label={copy.schedules.profile}>
        <Select label={copy.schedules.profile} value={spec.profileId} options={profiles.map((p) => ({ value: p.id, label: p.id }))} onChange={(profileId) => set({ profileId })} />
      </Field>
      <Field label={copy.schedules.browser}>
        <Segmented
          label={copy.schedules.browser}
          value={spec.browserMode}
          options={(['headed', 'headless'] as const).map((m) => ({ value: m, label: copy.run.browsers[m], disabled: state.info.headlessOnly && m === 'headed' }))}
          onChange={(browserMode) => set({ browserMode })}
        />
      </Field>
      <Field label={copy.schedules.timezone}>
        <input type="text" aria-label={copy.schedules.timezone} value={spec.timezone} onInput={(e) => set({ timezone: (e.currentTarget as HTMLInputElement).value })} />
      </Field>
      <Field label={copy.schedules.trigger} hint={t.kind === 'cron' ? copy.schedules.cronNote : undefined}>
        <Segmented
          label={copy.schedules.trigger}
          value={t.kind}
          options={(['daily-window', 'cron'] as const).map((k) => ({ value: k, label: copy.schedules.triggers[k] }))}
          onChange={(kind) =>
            set({ trigger: kind === 'cron' ? { kind: 'cron', expression: '0 8 * * *' } : blankSpec(spec.profileId, spec.presetId).trigger })
          }
        />
        {t.kind === 'cron' ? (
          <input type="text" aria-label={copy.schedules.cronExpression} value={t.expression} onInput={(e) => set({ trigger: { kind: 'cron', expression: (e.currentTarget as HTMLInputElement).value } })} />
        ) : (
          <div class="sub">
            <label>
              {copy.schedules.runs} <NumberInput label={copy.schedules.runs} value={t.runs} min={1} max={24} onChange={(runs) => set({ trigger: { ...t, runs } })} />
            </label>
            <label>
              {copy.schedules.window}
              <input type="time" aria-label={`${copy.schedules.window} start`} value={t.start} onInput={(e) => set({ trigger: { ...t, start: (e.currentTarget as HTMLInputElement).value } })} />
              {copy.common.to}
              <input type="time" aria-label={`${copy.schedules.window} end`} value={t.end} onInput={(e) => set({ trigger: { ...t, end: (e.currentTarget as HTMLInputElement).value } })} />
            </label>
            <label>
              {copy.schedules.jitter} <NumberInput label={copy.schedules.jitter} value={t.jitterMinutes} min={0} max={120} onChange={(jitterMinutes) => set({ trigger: { ...t, jitterMinutes } })} />
            </label>
            <label>
              {copy.schedules.minGap} <NumberInput label={copy.schedules.minGap} value={t.minGapMinutes} min={0} max={720} onChange={(minGapMinutes) => set({ trigger: { ...t, minGapMinutes } })} />
            </label>
          </div>
        )}
      </Field>
      <Field label={copy.schedules.misfire}>
        <div class="row">
          <Segmented
            label={copy.schedules.misfire}
            value={spec.misfire.policy}
            options={(['skip', 'run-once'] as const).map((m) => ({ value: m, label: copy.schedules.misfires[m] }))}
            onChange={(policy) => set({ misfire: { ...spec.misfire, policy } })}
          />
          <label>
            {copy.schedules.grace} <NumberInput label={copy.schedules.grace} value={spec.misfire.graceMinutes} min={0} max={1440} onChange={(graceMinutes) => set({ misfire: { ...spec.misfire, graceMinutes } })} />
          </label>
        </div>
      </Field>
      <Field label={copy.schedules.overlap}>
        <span>{copy.schedules.overlapSkip}</span>
      </Field>
      <Field label={copy.schedules.unavailable}>
        <Segmented
          label={copy.schedules.unavailable}
          value={spec.unavailableDisplay}
          options={(['skip', 'fallback-headless'] as const).map((m) => ({ value: m, label: copy.schedules.unavailables[m] }))}
          onChange={(unavailableDisplay) => set({ unavailableDisplay })}
        />
      </Field>
      <Field label="">
        <Toggle label={copy.schedules.enabled} checked={spec.enabled} onChange={(enabled) => set({ enabled })} />
        <Toggle label={copy.schedules.runOnStart} checked={spec.runOnStart} onChange={(runOnStart) => set({ runOnStart })} />
      </Field>
      {error && <Notice kind="error">{error}</Notice>}
      <div class="actions">
        <button type="button" onClick={props.onCancel}>
          {copy.common.cancel}
        </button>
        <button type="submit" class="primary">
          {copy.common.save}
        </button>
      </div>
    </form>
  );
}

export function SchedulesPage() {
  const [state, store] = useStore();
  const [views, setViews] = useState<ScheduleView[]>([]);
  const [editing, setEditing] = useState<ScheduleSpec | null>(null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  useEffect(() => {
    store.api.schedules().then(
      (l) => setViews(l.schedules),
      (err: unknown) => setMessage({ kind: 'error', text: errorText(err) }),
    );
  }, []);

  const act = async (fn: () => Promise<ScheduleView[] | void>) => {
    setMessage(null);
    try {
      const v = await fn();
      if (v) setViews(v);
    } catch (err) {
      setMessage({ kind: 'error', text: errorText(err) });
    }
  };
  const firstPreset = state.presets.find((p) => p.profileId);

  return (
    <div class="page">
      <h1>{copy.schedules.title}</h1>
      <Notice kind="warn">{copy.schedules.memoryNote}</Notice>
      {message && <Notice kind={message.kind}>{message.text}</Notice>}
      {views.length === 0 && !editing && <p class="muted">{copy.schedules.empty}</p>}
      <ul class="schedules">
        {views.map((v) => (
          <li class="panel" key={v.spec.id}>
            <div class="panel-head">
              <h3>
                {v.spec.name} {v.paused && <span class="chip">{copy.schedules.paused}</span>}
                {!v.spec.enabled && <span class="chip">{copy.run.off}</span>}
              </h3>
              <span class="muted">
                {v.spec.profileId} · {copy.run.browsers[v.spec.browserMode]} · {triggerText(v.spec)} · {v.spec.timezone}
              </span>
            </div>
            <div class="kv">
              <span>{copy.schedules.next}</span>
              <span>{v.next ? dateTime(v.next.plannedAt) : copy.schedules.noNext}</span>
              {v.next && (
                <>
                  <span>{copy.schedules.nextTarget}</span>
                  <span>
                    {copy.run.browseModes[v.next.preset.browseMode]} · {runModeText(v.next.preset.runMode)} · {v.next.preset.categories.length} 个板块
                  </span>
                </>
              )}
            </div>
            <div class="actions">
              <button type="button" class="primary" onClick={() => act(async () => void (await store.api.triggerSchedule(v.spec.id)))}>
                {copy.schedules.runNow}
              </button>
              <button type="button" disabled={v.paused} onClick={() => act(async () => (await store.api.pauseSchedule(v.spec.id)).schedules)}>
                {copy.schedules.pause}
              </button>
              <button type="button" onClick={() => setEditing(structuredClone(v.spec))}>
                {copy.common.edit}
              </button>
              <button type="button" class="danger" onClick={() => act(async () => (await store.api.deleteSchedule(v.spec.id)).schedules)}>
                {copy.common.delete}
              </button>
            </div>
          </li>
        ))}
      </ul>
      {editing ? (
        <ScheduleForm
          initial={editing}
          onCancel={() => setEditing(null)}
          onSaved={(v) => {
            setViews(v);
            setEditing(null);
          }}
        />
      ) : firstPreset ? (
        <button type="button" class="primary" onClick={() => setEditing(blankSpec(firstPreset.profileId!, firstPreset.id))}>
          {copy.schedules.create}
        </button>
      ) : (
        <p class="muted">{copy.schedules.needPreset}</p>
      )}
    </div>
  );
}

import type { Settings } from '@disco-lurk/server/contract';
import { useEffect, useState } from 'preact/hooks';
import type { DoctorReport } from '../api';
import { LIMITS } from '@disco-lurk/core';
import { Field, Notice, NumberInput, Select, Toggle } from '../components/fields';
import { ExtraWaitField, SampleField } from '../components/preset-fields';
import { copy, errorText } from '../copy';
import { platform } from '../platform';
import { useStore } from '../store';

const MARK = { ok: '✓', warn: '!', fail: '✗', skipped: '–' } as const;

export function DoctorTable(props: { report: DoctorReport }) {
  return (
    <table class="doctor">
      <tbody>
        {props.report.checks.map((c) => (
          <tr key={c.id}>
            <td class={`mark s-${c.status}`}>{MARK[c.status]}</td>
            <td>{c.title}</td>
            <td>
              {c.detail}
              {c.fix && c.status !== 'ok' && <div class="muted">→ {c.fix}</div>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function SettingsPage(props: { onTokenRotated(token: string): void }) {
  const [state, store] = useStore();
  const s = state.settings;
  const [autostart, setAutostart] = useState<boolean | null>(null);
  const [doctor, setDoctor] = useState<DoctorReport | null>(null);
  const [rotated, setRotated] = useState<string | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    platform.autostart?.get().then(setAutostart, () => setAutostart(null));
    store.api.doctor().then(setDoctor, () => setDoctor(null));
  }, []);

  const save = async (patch: Partial<Settings>) => {
    setError('');
    try {
      store.set({ settings: await store.api.saveSettings(patch) });
    } catch (err) {
      setError(errorText(err));
    }
  };

  const rotate = async () => {
    try {
      const { token } = await store.api.rotateToken();
      props.onTokenRotated(token);
      // The desktop shell learns the new token itself; only a remote user needs to see it.
      if (!platform.desktop) setRotated(token);
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <div class="page">
      <h1>{copy.settings.title}</h1>
      {error && <Notice kind="error">{error}</Notice>}
      <section class="panel">
        <Toggle label={copy.settings.notifications} checked={s.notifications} disabled={!platform.desktop} onChange={(notifications) => save({ notifications })} />
        <Toggle label={copy.settings.notifyOnStart} checked={s.notifyOnStart} disabled={!platform.desktop || !s.notifications} onChange={(notifyOnStart) => save({ notifyOnStart })} />
        <Toggle
          label={copy.settings.autostart}
          checked={autostart === true}
          disabled={!platform.autostart || autostart === null}
          onChange={(on) => platform.autostart?.set(on).then(() => setAutostart(on), (err: unknown) => setError(String(err)))}
        />
        <Toggle label={copy.settings.updateCheck} checked={s.updateCheck} onChange={(updateCheck) => save({ updateCheck })} />
        {!platform.desktop && <p class="hint">{copy.settings.desktopOnly}</p>}
        <Field label={copy.settings.language}>
          <Select label={copy.settings.language} value="zh-CN" disabled options={[{ value: 'zh-CN', label: copy.settings.languageZh }]} onChange={() => {}} />
        </Field>
      </section>
      <section class="panel">
        <div class="panel-head">
          <h3>{copy.settings.reading}</h3>
        </div>
        <p class="hint">{copy.settings.readingHint}</p>
        <SampleField value={s.reading.samplePerCategory} onChange={(samplePerCategory) => save({ reading: { ...s.reading, samplePerCategory } })} />
        <Field label={copy.run.extraWait}>
          <ExtraWaitField value={s.reading.extraWait} onChange={(extraWait) => save({ reading: { ...s.reading, extraWait } })} />
        </Field>
      </section>
      <section class="panel">
        <div class="panel-head">
          <h3>{copy.settings.retention}</h3>
        </div>
        <Field label={copy.settings.historyLimit}>
          <NumberInput label={copy.settings.historyLimit} value={s.historyLimit} min={10} max={LIMITS.historyRuns} onChange={(historyLimit) => save({ historyLimit })} />
        </Field>
        <Field label={copy.settings.ledgerDays} hint={copy.settings.ledgerHint}>
          <NumberInput label={copy.settings.ledgerDays} value={s.ledgerDays} min={1} max={LIMITS.ledgerDays} suffix={copy.settings.days} onChange={(ledgerDays) => save({ ledgerDays })} />
        </Field>
      </section>
      <section class="panel">
        <div class="panel-head">
          <h3>{copy.settings.token}</h3>
          <button type="button" onClick={rotate}>
            {copy.settings.rotate}
          </button>
        </div>
        <p class="hint">{copy.settings.rotateHint}</p>
        {rotated && (
          <Notice kind="warn">
            {copy.settings.rotated}
            <code class="token">{rotated}</code>
          </Notice>
        )}
      </section>
      <section class="panel">
        <div class="panel-head">
          <h3>{copy.settings.doctor}</h3>
          <button type="button" onClick={() => store.api.doctor().then(setDoctor, () => setDoctor(null))}>
            {copy.settings.doctorRun}
          </button>
        </div>
        {doctor ? <DoctorTable report={doctor} /> : <p class="muted">{copy.common.loading}</p>}
      </section>
    </div>
  );
}

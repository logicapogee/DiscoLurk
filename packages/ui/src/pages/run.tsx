import { MAX_REPLY_LIKES, type BrowseMode, type BrowserMode, type RunModeSpec } from '@disco-lurk/core';
import type { ActiveRun, StoredPreset } from '@disco-lurk/server/contract';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { ApiError } from '../api';
import { Field, Notice, NumberInput, Segmented, Select, Toggle } from '../components/fields';
import { ReplyRiskDialog } from '../components/dialog';
import { LogPanel } from '../components/log';
import { LevelTable, StatsPanel } from '../components/stats';
import { apiMessage, copy } from '../copy';
import { duration, lastStats, levelsOf, remainingText, runModeSpecText, runModeText } from '../format';
import { useStore } from '../store';

function errorText(err: unknown): string {
  if (err instanceof ApiError) return apiMessage(err.code, err.message);
  return copy.common.error(err instanceof Error ? err.message : String(err));
}

/** The run to show for a preset: the one running now, else the newest that finished. */
function runFor(runs: Record<string, ActiveRun>, presetId: string): ActiveRun | undefined {
  const mine = Object.values(runs).filter((r) => r.presetId === presetId);
  return mine.find((r) => !r.result) ?? mine.sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
}

export function RunPage() {
  const [state, store] = useStore();
  const { api } = store;
  const current = state.presets.find((p) => p.id === state.settings.currentPresetId);
  const [siteId, setSiteId] = useState(current?.siteId ?? state.sites[0]?.site.id ?? '');
  const [draft, setDraft] = useState<StoredPreset | null>(null);
  const [askReply, setAskReply] = useState(false);
  const [message, setMessage] = useState<{ kind: 'error' | 'ok' | 'info'; text: string } | null>(null);
  const [pending, setPending] = useState<'start' | 'refresh' | null>(null);
  const [proxy, setProxy] = useState('');
  const [naming, setNaming] = useState<string | null>(null);
  const [, tick] = useState(0);

  const site = state.sites.find((s) => s.site.id === siteId);
  const sitePresets = state.presets.filter((p) => p.siteId === siteId);
  const profiles = state.profiles.filter((p) => p.siteId === siteId);
  const profile = profiles.find((p) => p.id === draft?.profileId);
  const run = draft ? runFor(state.runs, draft.id) : undefined;
  const running = run !== undefined && !run.result;
  const events = run ? (state.events[run.runId] ?? []) : [];
  const stats = run?.result?.stats ?? lastStats(events);

  // Picks the preset to edit when the site changes: the current one, any saved one, or the default.
  useEffect(() => {
    if (!siteId) return;
    const saved = (current?.siteId === siteId ? current : undefined) ?? sitePresets[0];
    if (saved) {
      setDraft(structuredClone(saved));
      return;
    }
    api.defaultPreset(siteId).then(
      (d) => setDraft({ ...d, profileId: profiles[0]?.id ?? null }),
      (err: unknown) => setMessage({ kind: 'error', text: errorText(err) }),
    );
  }, [siteId]);

  useEffect(() => setProxy(profile?.proxy ?? ''), [profile?.id, profile?.proxy]);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [running]);

  const categories = site?.categories ?? [];
  const selected = useMemo(() => new Set(draft?.categoryPaths ?? []), [draft]);
  const headlessOnly = state.info.headlessOnly;

  if (!site) return <Notice>{copy.dashboard.noSites}</Notice>;
  if (!draft) return <div class="muted">{copy.common.loading}</div>;

  const update = (patch: Partial<StoredPreset>) => setDraft({ ...draft, ...patch });
  const interaction = draft.interaction;
  const setLike = (patch: Partial<StoredPreset['interaction']['like']>) => update({ interaction: { ...interaction, like: { ...interaction.like, ...patch } } });
  const setReply = (patch: Partial<StoredPreset['interaction']['reply']>) => update({ interaction: { ...interaction, reply: { ...interaction.reply, ...patch } } });
  const setRunMode = (runMode: RunModeSpec) => update({ runMode });

  const toggleReply = (on: boolean) => {
    // Turning replies on waits for the risk dialog; cancelling leaves them off.
    if (on) setAskReply(true);
    else setReply({ enabled: false, riskAcknowledged: false });
  };

  const save = async (d: StoredPreset) => {
    const saved = await api.savePreset(d);
    await store.refreshPresets();
    return saved;
  };

  const start = async () => {
    setMessage(null);
    if (!draft.profileId) return setMessage({ kind: 'error', text: apiMessage('no-profile') });
    setPending('start');
    try {
      const saved = await save(draft);
      const started = await api.startRun(saved.id);
      store.set({ runs: { ...store.state.runs, [started.runId]: started } });
    } catch (err) {
      setMessage({ kind: 'error', text: errorText(err) });
    } finally {
      setPending(null);
    }
  };

  const stop = async () => {
    if (!run) return;
    try {
      const v = await api.stopRun(run.runId);
      store.set({ runs: { ...store.state.runs, [v.runId]: v } });
    } catch (err) {
      setMessage({ kind: 'error', text: errorText(err) });
    }
  };

  const refreshCategories = async () => {
    if (!draft.profileId) return setMessage({ kind: 'error', text: apiMessage('no-profile') });
    setPending('refresh');
    setMessage(null);
    try {
      const r = await api.refreshCategories(siteId, draft.profileId);
      await store.refreshSites();
      setMessage({ kind: r.health.status === 'ready' ? 'ok' : 'error', text: r.health.status === 'ready' ? copy.login.categoriesHint : copy.login.healthBad(copy.profiles.statuses[r.health.status] ?? r.health.status) });
    } catch (err) {
      setMessage({ kind: 'error', text: errorText(err) });
    } finally {
      setPending(null);
    }
  };

  const saveProxy = async () => {
    if (!profile || proxy === (profile.proxy ?? '')) return;
    try {
      await api.patchProfile(profile.id, { proxy: proxy.trim() || null });
      await store.refreshProfiles();
    } catch (err) {
      setMessage({ kind: 'error', text: errorText(err) });
    }
  };

  // An inline name field: WKWebView has no window.prompt.
  const saveAsNew = async (name: string) => {
    setNaming(null);
    if (!name.trim()) return;
    const id = `${siteId}-${Date.now().toString(36)}`;
    try {
      const saved = await save({ ...draft, id, name: name.trim() });
      setDraft(saved);
    } catch (err) {
      setMessage({ kind: 'error', text: errorText(err) });
    }
  };

  const elapsedMs = run ? (run.result?.stats.elapsedMs ?? Date.now() - Date.parse(run.startedAt)) : 0;
  const remaining = run ? remainingText(run.plan.preset.runMode, run.plan.preset.browseMode, stats, elapsedMs) : null;
  const onOff = (b: boolean) => (b ? copy.run.on : copy.run.off);
  const summary = copy.run.summaryLine({
    account: profile ? `${profile.health?.username ?? profile.name}（${profile.id}）` : copy.common.none,
    browser: copy.run.browsers[headlessOnly ? 'headless' : draft.browserMode],
    target: runModeSpecText(draft.runMode),
    categories: draft.categoryPaths.length,
    like: onOff(interaction.like.enabled),
    reply: onOff(interaction.reply.enabled),
  });
  const locked = running || pending === 'start';

  return (
    <div class="page run-page">
      <h1>{copy.run.title}</h1>
      {askReply && (
        <ReplyRiskDialog
          onConfirm={() => {
            setAskReply(false);
            setReply({ enabled: true, riskAcknowledged: true });
          }}
          onCancel={() => setAskReply(false)}
        />
      )}
      <div class="columns">
        <form class="panel settings-form" onSubmit={(e) => e.preventDefault()} aria-label={copy.run.title}>
          <fieldset disabled={locked}>
            <Field label={copy.run.site}>
              <Select label={copy.run.site} value={siteId} options={state.sites.map((s) => ({ value: s.site.id, label: s.site.displayName }))} onChange={setSiteId} />
            </Field>
            <Field label={copy.run.preset}>
              <div class="row">
                <Select
                  label={copy.run.preset}
                  value={draft.id}
                  options={[...sitePresets.filter((p) => p.id !== draft.id), draft].map((p) => ({ value: p.id, label: p.name }))}
                  onChange={(id) => {
                    const p = sitePresets.find((x) => x.id === id);
                    if (p) setDraft(structuredClone(p));
                  }}
                />
                {naming === null ? (
                  <button type="button" onClick={() => setNaming(`${draft.name} 2`)}>
                    {copy.run.newPreset}
                  </button>
                ) : (
                  <>
                    <input type="text" aria-label={copy.run.newPresetName} value={naming} maxLength={60} onInput={(e) => setNaming((e.currentTarget as HTMLInputElement).value)} />
                    <button type="button" class="primary" onClick={() => void saveAsNew(naming)}>
                      {copy.common.save}
                    </button>
                    <button type="button" onClick={() => setNaming(null)}>
                      {copy.common.cancel}
                    </button>
                  </>
                )}
              </div>
            </Field>
            <Field label={copy.run.profile} hint={profiles.length === 0 ? copy.run.noProfile : undefined}>
              <div class="row">
                <Select
                  label={copy.run.profile}
                  value={draft.profileId ?? ''}
                  options={[{ value: '', label: '—' }, ...profiles.map((p) => ({ value: p.id, label: `${p.name}${p.health?.username ? ` · ${p.health.username}` : ''}` }))]}
                  onChange={(v) => update({ profileId: v || null })}
                />
                {profile && <span class={`chip status-${profile.status}`}>{copy.profiles.statuses[profile.status]}</span>}
              </div>
            </Field>
            <Field label={copy.run.proxy} hint={copy.run.proxyHint}>
              <input type="text" aria-label={copy.run.proxy} value={proxy} disabled={!profile} placeholder="http://127.0.0.1:7890" onInput={(e) => setProxy((e.currentTarget as HTMLInputElement).value)} onBlur={saveProxy} />
            </Field>
            <Field label={copy.run.categories} hint={site.site.categorySource === 'builtin' ? copy.run.categoriesBuiltin : copy.run.categoriesDiscovered}>
              <div class="row">
                <button type="button" onClick={() => update({ categoryPaths: categories.map((c) => c.path) })}>
                  {copy.run.selectAll}
                </button>
                <button type="button" onClick={() => update({ categoryPaths: [] })}>
                  {copy.run.selectNone}
                </button>
                {site.site.categorySource === 'discovered' && (
                  <button type="button" onClick={refreshCategories} disabled={pending === 'refresh'}>
                    {pending === 'refresh' ? copy.run.refreshing : copy.run.refreshCategories}
                  </button>
                )}
              </div>
              {categories.length === 0 && <div class="hint">{copy.run.noCategories}</div>}
              <div class="category-grid">
                {categories.map((c) => (
                  <label key={c.path} class={`chip${selected.has(c.path) ? ' on' : ''}`}>
                    <input
                      type="checkbox"
                      checked={selected.has(c.path)}
                      onChange={(e) => {
                        const on = (e.currentTarget as HTMLInputElement).checked;
                        update({ categoryPaths: on ? [...draft.categoryPaths, c.path] : draft.categoryPaths.filter((p) => p !== c.path) });
                      }}
                    />
                    {c.name}
                  </label>
                ))}
              </div>
            </Field>
            <Field label={copy.run.runMode} hint={draft.runMode.kind === 'topics' ? copy.run.topicsHint[draft.browseMode] : undefined}>
              <Segmented
                label={copy.run.runMode}
                value={draft.runMode.kind}
                options={(['endless', 'topics', 'time'] as const).map((k) => ({ value: k, label: copy.run.runModes[k] }))}
                onChange={(k) => setRunMode(k === 'endless' ? { kind: 'endless' } : k === 'topics' ? { kind: 'topics', min: 50, max: 50 } : { kind: 'time', minutes: 30 })}
              />
              {draft.runMode.kind === 'topics' && (
                <div class="row">
                  <NumberInput label={`${copy.run.topicsRange} min`} value={draft.runMode.min} min={1} max={10000} onChange={(min) => setRunMode({ kind: 'topics', min, max: Math.max(min, (draft.runMode as { max: number }).max) })} />
                  <span>{copy.common.to}</span>
                  <NumberInput label={`${copy.run.topicsRange} max`} value={draft.runMode.max} min={draft.runMode.min} max={10000} onChange={(max) => setRunMode({ kind: 'topics', min: (draft.runMode as { min: number }).min, max })} />
                </div>
              )}
              {draft.runMode.kind === 'time' && (
                <NumberInput label={copy.run.timeMinutes} value={draft.runMode.minutes} min={1} max={1440} suffix={copy.common.minutes} onChange={(minutes) => setRunMode({ kind: 'time', minutes })} />
              )}
            </Field>
            <Field label={copy.run.browseMode}>
              <Segmented label={copy.run.browseMode} value={draft.browseMode} options={(['deep', 'quick'] as BrowseMode[]).map((m) => ({ value: m, label: copy.run.browseModes[m] }))} onChange={(browseMode) => update({ browseMode })} />
            </Field>
            <Field label={copy.run.interaction}>
              <Toggle label={copy.run.like} checked={interaction.like.enabled} onChange={(enabled) => setLike({ enabled })} />
              {interaction.like.enabled && (
                <div class="sub">
                  <label>
                    {copy.run.likeRate} <NumberInput label={copy.run.likeRate} value={interaction.like.topicRate} min={0} max={100} suffix="%" onChange={(topicRate) => setLike({ topicRate })} />
                  </label>
                  <label>
                    {copy.run.replyLikeRate} <NumberInput label={copy.run.replyLikeRate} value={interaction.like.replyRate} min={0} max={100} suffix="%" onChange={(replyRate) => setLike({ replyRate })} />
                  </label>
                  <label>
                    {copy.run.replyLikeMax} <NumberInput label={copy.run.replyLikeMax} value={interaction.like.maxReplies} min={0} max={MAX_REPLY_LIKES} onChange={(maxReplies) => setLike({ maxReplies })} />
                  </label>
                </div>
              )}
              <Toggle label={copy.run.reply} checked={interaction.reply.enabled} onChange={toggleReply} />
              {interaction.reply.enabled && (
                <div class="sub">
                  <label>
                    {copy.run.replyRate} <NumberInput label={copy.run.replyRate} value={interaction.reply.rate} min={0} max={100} suffix="%" onChange={(rate) => setReply({ rate })} />
                  </label>
                </div>
              )}
              <Toggle label={copy.run.extraWait} checked={draft.extraWait.enabled} onChange={(enabled) => update({ extraWait: { ...draft.extraWait, enabled } })} />
              {draft.extraWait.enabled && (
                <div class="sub">
                  <NumberInput label={`${copy.run.extraWaitRange} min`} value={draft.extraWait.minSec} min={0} max={60} suffix={copy.common.seconds} onChange={(minSec) => update({ extraWait: { ...draft.extraWait, minSec, maxSec: Math.max(minSec, draft.extraWait.maxSec) } })} />
                  <span>{copy.common.to}</span>
                  <NumberInput label={`${copy.run.extraWaitRange} max`} value={draft.extraWait.maxSec} min={draft.extraWait.minSec} max={60} suffix={copy.common.seconds} onChange={(maxSec) => update({ extraWait: { ...draft.extraWait, maxSec } })} />
                </div>
              )}
            </Field>
            <Field label={copy.run.browser} hint={headlessOnly ? copy.run.headlessOnlyHint : undefined}>
              <Segmented
                label={copy.run.browser}
                value={headlessOnly ? 'headless' : draft.browserMode}
                options={(['headed', 'headless'] as BrowserMode[]).map((m) => ({ value: m, label: copy.run.browsers[m], disabled: headlessOnly && m === 'headed' }))}
                onChange={(browserMode) => update({ browserMode })}
              />
            </Field>
            <details class="advanced">
              <summary>{copy.run.advanced}</summary>
              <Field label={copy.run.sample}>
                <div class="row">
                  <NumberInput label={`${copy.run.sample} min`} value={draft.samplePerCategory.min} min={1} max={50} onChange={(min) => update({ samplePerCategory: { min, max: Math.max(min, draft.samplePerCategory.max) } })} />
                  <span>{copy.common.to}</span>
                  <NumberInput label={`${copy.run.sample} max`} value={draft.samplePerCategory.max} min={draft.samplePerCategory.min} max={50} onChange={(max) => update({ samplePerCategory: { ...draft.samplePerCategory, max } })} />
                </div>
              </Field>
            </details>
          </fieldset>
        </form>

        <div class="run-side">
          <div class="panel">
            <div class="panel-head">
              <h3>{copy.run.summary}</h3>
            </div>
            <p class="summary">{summary}</p>
            {message && <Notice kind={message.kind}>{message.text}</Notice>}
            <div class="actions">
              {running ? (
                <button type="button" class="danger big" onClick={stop} disabled={run.stopping}>
                  {run.stopping ? copy.run.stopping : copy.run.stop}
                </button>
              ) : (
                <button type="button" class="primary big" onClick={start} disabled={pending === 'start'}>
                  {pending === 'start' ? copy.run.starting : copy.run.start}
                </button>
              )}
            </div>
          </div>
          {run && (
            <div class="panel">
              <div class="panel-head">
                <h3>{running ? copy.states[run.state] : copy.run.lastRun}</h3>
                <span class={`chip state-${run.state}`}>{copy.states[run.state]}</span>
              </div>
              <div class="kv">
                <span>{copy.run.target}</span>
                <span>
                  {runModeText(run.plan.preset.runMode)}
                  {run.plan.preset.runMode.kind === 'topics' ? ` · ${copy.run.topicsHint[run.plan.preset.browseMode]}` : ''}
                </span>
                <span>{copy.run.elapsed}</span>
                <span>{duration(elapsedMs)}</span>
                {remaining !== null && (
                  <>
                    <span>{copy.run.remaining}</span>
                    <span>{remaining}</span>
                  </>
                )}
                {run.result && (
                  <>
                    <span>{copy.history.cause}</span>
                    <span>
                      {copy.stopCauses[run.result.stopCause] ?? run.result.stopCause}
                      {run.result.failure ? ` · ${copy.errors[run.result.failure.code]}：${run.result.failure.message}` : ''}
                    </span>
                  </>
                )}
              </div>
            </div>
          )}
          {stats && <StatsPanel stats={stats} />}
          {run && <LevelTable levels={run.result?.levels ?? levelsOf(events)} baseline={run.result?.baseline ?? null} stats={stats} events={events} />}
        </div>
      </div>
      {run && <LogPanel api={api} runId={run.runId} events={events} />}
      {!run && <p class="muted">{copy.run.noRun}</p>}
    </div>
  );
}

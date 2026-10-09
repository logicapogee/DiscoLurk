import type { BrowseMode, BrowserMode } from '@disco-lurk/core';
import type { ActiveRun, StoredPreset } from '@disco-lurk/server/contract';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { Field, Notice, Segmented, Select } from '../components/fields';
import { LogPanel } from '../components/log';
import { ExtraWaitField, InteractionField, RunModeField, SampleField } from '../components/preset-fields';
import { LevelTable, StatsPanel } from '../components/stats';
import { apiMessage, attempt, copy, errorText, type Message } from '../copy';
import { duration, remainingText, runModeSpecText, runModeText } from '../format';
import { useStore } from '../store';

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
  const [message, setMessage] = useState<Message | null>(null);
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
  const live = run ? state.live[run.runId] : undefined;
  const stats = run?.result?.stats ?? live?.stats;

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

  const save = async (d: StoredPreset) => {
    const saved = await api.savePreset(d);
    await store.refreshPresets();
    return saved;
  };

  const start = async () => {
    if (!draft.profileId) return setMessage({ kind: 'error', text: apiMessage('no-profile') });
    setPending('start');
    await attempt(async () => {
      const started = await api.startRun((await save(draft)).id);
      store.set({ runs: { ...store.state.runs, [started.runId]: started } });
    }, setMessage);
    setPending(null);
  };

  const stop = () =>
    run &&
    attempt(async () => {
      const v = await api.stopRun(run.runId);
      store.set({ runs: { ...store.state.runs, [v.runId]: v } });
    }, setMessage);

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
    await attempt(async () => {
      await api.patchProfile(profile.id, { proxy: proxy.trim() || null });
      await store.refreshProfiles();
    }, setMessage);
  };

  // An inline name field: WKWebView has no window.prompt.
  const saveAsNew = async (name: string) => {
    setNaming(null);
    if (!name.trim()) return;
    const id = `${siteId}-${Date.now().toString(36)}`;
    const saved = await attempt(() => save({ ...draft, id, name: name.trim() }), setMessage);
    if (saved) setDraft(saved);
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
            <RunModeField value={draft.runMode} browseMode={draft.browseMode} onChange={(runMode) => update({ runMode })} />
            <Field label={copy.run.browseMode}>
              <Segmented label={copy.run.browseMode} value={draft.browseMode} options={(['deep', 'quick'] as BrowseMode[]).map((m) => ({ value: m, label: copy.run.browseModes[m] }))} onChange={(browseMode) => update({ browseMode })} />
            </Field>
            <Field label={copy.run.interaction}>
              <InteractionField value={interaction} onChange={(i) => update({ interaction: i })} />
              <ExtraWaitField value={draft.extraWait} onChange={(extraWait) => update({ extraWait })} />
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
              <SampleField value={draft.samplePerCategory} onChange={(samplePerCategory) => update({ samplePerCategory })} />
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
          {run && <LevelTable levels={run.result?.levels ?? live?.levels ?? { initial: null, final: null }} baseline={run.result?.baseline ?? null} stats={stats} events={events} />}
        </div>
      </div>
      {run && <LogPanel api={api} runId={run.runId} events={events} />}
      {!run && <p class="muted">{copy.run.noRun}</p>}
    </div>
  );
}

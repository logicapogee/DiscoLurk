import type { BrowserChannel } from '@disco-lurk/core';
import type { LoginView, ProfileView } from '@disco-lurk/server/contract';
import { useEffect, useState } from 'preact/hooks';
import { ApiError } from '../api';
import { ConfirmDialog } from '../components/dialog';
import { Field, Notice, Select } from '../components/fields';
import { apiMessage, copy } from '../copy';
import { dateTime } from '../format';
import { useStore } from '../store';

const errorText = (err: unknown) => (err instanceof ApiError ? apiMessage(err.code, err.message) : copy.common.error(err instanceof Error ? err.message : String(err)));
const OPEN_PHASES = new Set(['opening', 'waiting', 'needs-auth', 'challenge-detected', 'checking-health']);

function LoginPanel(props: { login: LoginView; onAction(a: 'recheck' | 'continue' | 'close'): void }) {
  const { login } = props;
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (login.phase !== 'waiting') return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [login.phase]);
  const left = login.deadline ? Math.max(0, Math.round((login.deadline - now) / 1000)) : null;
  const health = login.health;
  return (
    <div class="login-panel" aria-live="polite">
      <div>
        <strong>{copy.login.phases[login.phase]}</strong>
        {login.phase === 'waiting' && left !== null && <span class="muted"> · {copy.login.countdown(left)}</span>}
      </div>
      {login.message && <div class="hint">{login.message}</div>}
      {health && (
        <Notice kind={health.status === 'ready' ? 'ok' : 'warn'}>
          {health.status === 'ready' ? copy.login.healthOk(health.username) : copy.login.healthBad(copy.profiles.statuses[health.status] ?? health.status)}
        </Notice>
      )}
      {['waiting', 'needs-auth', 'challenge-detected'].includes(login.phase) && (
        <div class="actions">
          <button type="button" onClick={() => props.onAction('recheck')}>
            {copy.login.recheck}
          </button>
          <button type="button" disabled={login.phase === 'waiting'} onClick={() => props.onAction('continue')}>
            {copy.login.continue}
          </button>
          <button type="button" onClick={() => props.onAction('close')}>
            {copy.login.close}
          </button>
        </div>
      )}
    </div>
  );
}

function ProfileRow(props: { profile: ProfileView; login: LoginView | undefined; headlessOnly: boolean; onMessage(m: { kind: 'ok' | 'error'; text: string }): void }) {
  const [, store] = useStore();
  const { api } = store;
  const { profile: p, login } = props;
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const act = async (name: string, fn: () => Promise<string | void>) => {
    setBusy(name);
    try {
      const text = await fn();
      if (text) props.onMessage({ kind: 'ok', text });
      await store.refreshProfiles();
    } catch (err) {
      props.onMessage({ kind: 'error', text: errorText(err) });
    } finally {
      setBusy(null);
    }
  };
  const loginOpen = login !== undefined && OPEN_PHASES.has(login.phase);
  return (
    <li class="profile">
      <div class="profile-head">
        <div>
          <strong>{p.name}</strong> <span class="muted">{copy.profiles.channels[p.channel]}</span>
          <span class={`chip status-${p.status}`}>{copy.profiles.statuses[p.status]}</span>
        </div>
        <div class="muted">
          {copy.profiles.username}：{p.health?.username ?? copy.common.unknown}
          {p.health && ` · ${copy.profiles.checkedAt} ${dateTime(p.health.checkedAt)}`}
          {p.proxy && ` · ${copy.run.proxy} ${p.proxy}`}
        </div>
      </div>
      <div class="actions">
        <button type="button" class="primary" disabled={p.busy || loginOpen || props.headlessOnly || busy !== null} onClick={() => act('login', async () => void (await api.login(p.id)))}>
          {p.health?.status === 'ready' ? copy.profiles.relogin : copy.profiles.login}
        </button>
        <button type="button" disabled={p.busy || busy !== null} onClick={() => act('inspect', async () => void (await api.inspectProfile(p.id)))}>
          {busy === 'inspect' ? copy.profiles.inspecting : copy.profiles.inspect}
        </button>
        <button type="button" disabled={p.busy || busy !== null} onClick={() => act('backup', async () => copy.profiles.backedUp((await api.backupProfile(p.id)).path))}>
          {copy.profiles.backup}
        </button>
        <button type="button" class="danger" disabled={p.busy || busy !== null} onClick={() => setConfirmDelete(true)}>
          {copy.profiles.remove}
        </button>
      </div>
      {login && <LoginPanel login={login} onAction={(a) => act(a, async () => void (await api.loginAction(p.id, a)))} />}
      {confirmDelete && (
        <ConfirmDialog
          title={copy.profiles.removeTitle}
          danger
          confirmLabel={copy.common.delete}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => {
            setConfirmDelete(false);
            void act('delete', () => api.deleteProfile(p.id));
          }}
        >
          <p>{copy.profiles.removeBody(p.id)}</p>
        </ConfirmDialog>
      )}
    </li>
  );
}

export function ProfilesPage() {
  const [state, store] = useStore();
  const [siteId, setSiteId] = useState(state.sites[0]?.site.id ?? '');
  const [name, setName] = useState('default');
  const [channel, setChannel] = useState<BrowserChannel>('chrome');
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const create = async (e: Event) => {
    e.preventDefault();
    setMessage(null);
    try {
      await store.api.createProfile({ siteId, name, channel });
      await store.refreshProfiles();
    } catch (err) {
      setMessage({ kind: 'error', text: errorText(err) });
    }
  };

  return (
    <div class="page">
      <h1>{copy.profiles.title}</h1>
      <p class="muted">{copy.profiles.hint}</p>
      {message && <Notice kind={message.kind}>{message.text}</Notice>}
      {state.sites.map(({ site }) => {
        const list = state.profiles.filter((p) => p.siteId === site.id);
        return (
          <section class="panel" key={site.id}>
            <div class="panel-head">
              <h3>{site.displayName}</h3>
              <span class="muted">{site.baseUrl}</span>
            </div>
            {list.length === 0 && <p class="muted">{copy.profiles.empty}</p>}
            <ul class="profiles">
              {list.map((p) => (
                <ProfileRow key={p.id} profile={p} login={state.logins[p.id]} headlessOnly={state.info.headlessOnly} onMessage={setMessage} />
              ))}
            </ul>
          </section>
        );
      })}
      <form class="panel" onSubmit={create}>
        <div class="panel-head">
          <h3>{copy.profiles.create}</h3>
        </div>
        <Field label={copy.run.site}>
          <Select label={copy.run.site} value={siteId} options={state.sites.map((s) => ({ value: s.site.id, label: s.site.displayName }))} onChange={setSiteId} />
        </Field>
        <Field label={copy.profiles.name} hint={copy.profiles.nameHint}>
          <input type="text" aria-label={copy.profiles.name} value={name} pattern="[A-Za-z0-9][A-Za-z0-9_\-]*" required onInput={(e) => setName((e.currentTarget as HTMLInputElement).value)} />
        </Field>
        <Field label={copy.profiles.channel} hint={copy.profiles.channelHint}>
          <Select<BrowserChannel>
            label={copy.profiles.channel}
            value={channel}
            options={(['chrome', 'msedge'] as const).map((c) => ({ value: c, label: copy.profiles.channels[c] }))}
            onChange={setChannel}
          />
        </Field>
        <div class="actions">
          <button type="submit" class="primary">
            {copy.profiles.create}
          </button>
        </div>
      </form>
    </div>
  );
}

import { useEffect, useState } from 'preact/hooks';
import { Api, ApiError } from './api';
import { Notice } from './components/fields';
import { copy } from './copy';
import { AboutPage } from './pages/about';
import { DashboardPage } from './pages/dashboard';
import { HistoryPage } from './pages/history';
import { ProfilesPage } from './pages/profiles';
import { RunPage } from './pages/run';
import { SchedulesPage } from './pages/schedules';
import { SettingsPage } from './pages/settings';
import { platform as defaultPlatform, SidecarStartError, type Platform, type SidecarConnection } from './platform';
import { Store, StoreContext, useStore } from './store';

type Page = 'dashboard' | 'run' | 'profiles' | 'schedules' | 'history' | 'settings' | 'about';
const PAGES: Page[] = ['dashboard', 'run', 'profiles', 'schedules', 'history', 'settings', 'about'];

type Boot =
  | { phase: 'starting' }
  | { phase: 'failed'; message: string; output: string; logDir: string }
  | { phase: 'token'; error?: string }
  | { phase: 'ready'; store: Store; conn: SidecarConnection | null; notice?: string };

async function open(api: Api): Promise<Store> {
  const store = await Store.load(api);
  if (store.state.settings.updateCheck) {
    // Runs in the background; a failed check only means no update is shown.
    api.updateCheck().then(
      (update) => store.set({ update }),
      () => {},
    );
  }
  return store;
}

function TokenForm(props: { error?: string | undefined; onSubmit(token: string): void }) {
  const [token, setToken] = useState('');
  const [missing, setMissing] = useState(false);
  return (
    <main class="boot">
      <form
        class="panel token-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!token.trim()) return setMissing(true);
          props.onSubmit(token.trim());
        }}
      >
        <h1>{copy.token.title}</h1>
        <p class="muted">{copy.token.hint}</p>
        <label class="field">
          <span class="field-label">{copy.token.label}</span>
          <input type="password" autoComplete="off" value={token} onInput={(e) => setToken((e.currentTarget as HTMLInputElement).value)} />
        </label>
        {(missing || props.error) && <Notice kind="error">{props.error ?? copy.token.missing}</Notice>}
        <div class="actions">
          <button type="submit" class="primary">
            {copy.token.submit}
          </button>
        </div>
      </form>
    </main>
  );
}

function Shell(props: { conn: SidecarConnection | null; notice?: string | undefined; onLogout?: (() => void) | undefined; onTokenRotated(token: string): void }) {
  // The shell redraws for its badges and the connection notice only, never for each run event.
  const [state] = useStore((s) => ({ running: Object.values(s.runs).filter((r) => !r.result).length, newer: s.update?.newer === true, stream: s.stream }));
  const [page, setPage] = useState<Page>('run');
  const running = state.running;
  return (
    <div class="shell">
      <nav class="sidebar" aria-label="主导航">
        <div class="brand">{copy.app.name}</div>
        {PAGES.map((p) => (
          <button key={p} type="button" class={`nav${p === page ? ' on' : ''}`} aria-current={p === page ? 'page' : undefined} onClick={() => setPage(p)}>
            {copy.nav[p]}
            {p === 'run' && running > 0 && <span class="count">{running}</span>}
            {p === 'about' && state.newer && <span class="count">新</span>}
          </button>
        ))}
        {props.onLogout && (
          <button type="button" class="nav logout" onClick={props.onLogout}>
            {copy.token.logout}
          </button>
        )}
      </nav>
      <main class="content">
        {state.stream === 'server-closed' ? (
          <Notice kind="warn">{copy.boot.serverClosed}</Notice>
        ) : (
          state.stream !== 'open' && state.stream !== 'connecting' && <Notice kind="warn">{copy.boot.reconnecting}</Notice>
        )}
        {props.notice && <Notice kind="info">{props.notice}</Notice>}
        {page === 'dashboard' && <DashboardPage go={setPage} />}
        {page === 'run' && <RunPage />}
        {page === 'profiles' && <ProfilesPage />}
        {page === 'schedules' && <SchedulesPage />}
        {page === 'history' && <HistoryPage />}
        {page === 'settings' && <SettingsPage onTokenRotated={props.onTokenRotated} />}
        {page === 'about' && <AboutPage conn={props.conn} />}
      </main>
    </div>
  );
}

export function App(props: { platform?: Platform; origin?: string }) {
  const platform = props.platform ?? defaultPlatform;
  const [boot, setBoot] = useState<Boot>({ phase: 'starting' });

  const ready = (store: Store, conn: SidecarConnection | null, notice?: string) => {
    store.connect(() => {
      if (platform.desktop) return;
      platform.storeToken(null);
      store.disconnect();
      setBoot({ phase: 'token', error: copy.token.invalid });
    });
    setBoot({ phase: 'ready', store, conn, ...(notice ? { notice } : {}) });
  };

  const startDesktop = async (notice?: string) => {
    try {
      const conn = await platform.connect();
      ready(await open(new Api(conn.baseUrl, conn.token)), conn, notice);
    } catch (err) {
      if (err instanceof SidecarStartError) setBoot({ phase: 'failed', message: err.message, output: err.output, logDir: err.logDir });
      else setBoot({ phase: 'failed', message: err instanceof Error ? err.message : String(err), output: '', logDir: '' });
    }
  };

  const startRemote = async (token: string) => {
    setBoot({ phase: 'starting' });
    try {
      const store = await open(new Api(props.origin ?? window.location.origin, token));
      platform.storeToken(token);
      ready(store, null);
    } catch (err) {
      platform.storeToken(null);
      const error = err instanceof ApiError && err.status === 429 ? copy.token.locked : err instanceof ApiError && err.status === 401 ? copy.token.invalid : copy.common.error(String(err));
      setBoot({ phase: 'token', error });
    }
  };

  useEffect(() => {
    if (platform.desktop) {
      // A restarted sidecar listens on a new port with a new token; the whole store is rebuilt.
      platform.onRestarted(() => {
        setBoot((b) => {
          if (b.phase === 'ready') b.store.disconnect();
          return { phase: 'starting' };
        });
        void startDesktop(copy.boot.restarted);
      });
      void startDesktop();
      return;
    }
    const stored = platform.storedToken();
    if (stored) void startRemote(stored);
    else setBoot({ phase: 'token' });
  }, []);

  switch (boot.phase) {
    case 'starting':
      return (
        <main class="boot">
          <div class="panel status">
            <span class="dot pending" /> {copy.boot.starting}
          </div>
        </main>
      );
    case 'failed':
      return (
        <main class="boot">
          <div class="panel">
            <div class="status">
              <span class="dot fail" /> {copy.boot.failed}：{boot.message}
            </div>
            {boot.logDir && (
              <p>
                {copy.boot.logDir}：<code>{boot.logDir}</code>
              </p>
            )}
            {boot.output && (
              <>
                <h3>{copy.boot.output}</h3>
                <pre class="output">{boot.output}</pre>
              </>
            )}
          </div>
        </main>
      );
    case 'token':
      return <TokenForm error={boot.error} onSubmit={(t) => void startRemote(t)} />;
    case 'ready': {
      const { store } = boot;
      const onTokenRotated = (token: string) => {
        store.api.setToken(token);
        platform.storeToken(platform.desktop ? null : token);
        store.reconnectStream();
      };
      const onLogout = platform.desktop
        ? undefined
        : () => {
            store.disconnect();
            platform.storeToken(null);
            setBoot({ phase: 'token' });
          };
      return (
        <StoreContext.Provider value={store}>
          <Shell conn={boot.conn} notice={boot.notice} onLogout={onLogout} onTokenRotated={onTokenRotated} />
        </StoreContext.Provider>
      );
    }
  }
}

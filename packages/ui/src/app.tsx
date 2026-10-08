import { useEffect, useState } from 'preact/hooks';
import { platform } from './platform';
import { fetchDoctor, launchSidecar, showWindow, SidecarStartError, type DoctorReport, type SidecarConnection } from './sidecar';

type State =
  | { phase: 'starting' }
  | { phase: 'ready'; conn: SidecarConnection; doctor: DoctorReport | null; doctorError?: string }
  | { phase: 'failed'; message: string; output: string };

const MARK = { ok: '✓', warn: '!', fail: '✗', skipped: '–' } as const;

export function App() {
  const [state, setState] = useState<State>({ phase: 'starting' });

  useEffect(() => {
    if (!platform.desktop) return;
    (async () => {
      try {
        const conn = await launchSidecar();
        setState({ phase: 'ready', conn, doctor: null });
        try {
          setState({ phase: 'ready', conn, doctor: await fetchDoctor(conn) });
        } catch (err) {
          setState({ phase: 'ready', conn, doctor: null, doctorError: String(err) });
        }
      } catch (err) {
        const output = err instanceof SidecarStartError ? err.output : '';
        setState({ phase: 'failed', message: String(err instanceof Error ? err.message : err), output });
        // A spawn failure never reaches the shell's health wait, which is what normally shows the window.
        await showWindow();
      }
    })();
  }, []);

  if (!platform.desktop) {
    return (
      <main>
        <h1>DiscoLurk</h1>
        <div class="panel muted">此页面需要在 DiscoLurk 桌面应用中打开。</div>
      </main>
    );
  }

  return (
    <main>
      <h1>DiscoLurk</h1>
      <div class="panel">
        {state.phase === 'starting' && (
          <div class="status">
            <span class="dot pending" /> 正在启动 sidecar…
          </div>
        )}
        {state.phase === 'ready' && (
          <div class="status">
            <span class="dot ok" /> sidecar 健康 · v{state.conn.version} · {state.conn.baseUrl}
          </div>
        )}
        {state.phase === 'failed' && (
          <>
            <div class="status">
              <span class="dot fail" /> sidecar 启动失败：{state.message}
            </div>
            {state.output && <pre class="muted">{state.output}</pre>}
          </>
        )}
      </div>
      {state.phase === 'ready' && (
        <div class="panel">
          <div class="status">环境诊断（doctor）</div>
          {state.doctorError && <p class="s-fail">{state.doctorError}</p>}
          {!state.doctor && !state.doctorError && <p class="muted">检测中…</p>}
          {state.doctor && (
            <table>
              <tbody>
                {state.doctor.checks.map((c) => (
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
          )}
        </div>
      )}
    </main>
  );
}

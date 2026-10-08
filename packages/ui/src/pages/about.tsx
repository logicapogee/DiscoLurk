import { useState } from 'preact/hooks';
import { Notice } from '../components/fields';
import { copy } from '../copy';
import { platform, type SidecarConnection } from '../platform';
import { useStore } from '../store';

export function AboutPage(props: { conn: SidecarConnection | null }) {
  const [state] = useStore();
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState('');
  const u = state.update;
  const a = copy.about;
  const canInstall = platform.desktop && props.conn?.updater === true;
  const install = async () => {
    setInstalling(true);
    setError('');
    try {
      await platform.installUpdate();
    } catch (err) {
      setError(copy.common.error(err instanceof Error ? err.message : String(err)));
      setInstalling(false);
    }
  };
  return (
    <div class="page">
      <h1>{a.title}</h1>
      <section class="panel">
        <div class="kv">
          <span>{a.version}</span>
          <span>
            {copy.app.name} {state.info.version} · {state.info.platform}
          </span>
          <span>{a.latest}</span>
          <span>{!state.settings.updateCheck ? a.checkOff : !u ? copy.common.loading : u.latest === null ? a.checkFailed : u.newer ? a.newer(u.latest) : a.upToDate}</span>
          {props.conn && (
            <>
              <span>{a.logFile}</span>
              <code>{props.conn.logPath}</code>
            </>
          )}
        </div>
        {u?.newer && (
          <div class="actions">
            {canInstall ? (
              <button type="button" class="primary" disabled={installing} onClick={install}>
                {installing ? a.installing : a.install}
              </button>
            ) : (
              <span>
                {a.releasePage}：
                {platform.desktop ? (
                  <code>{u.releaseUrl}</code>
                ) : (
                  <a href={u.releaseUrl} target="_blank" rel="noreferrer">
                    {u.releaseUrl}
                  </a>
                )}
              </span>
            )}
          </div>
        )}
        {platform.desktop && !props.conn?.updater && <p class="hint">{a.macNote}</p>}
        {error && <Notice kind="error">{error}</Notice>}
      </section>
      <p class="muted">{a.license}</p>
    </div>
  );
}

import type { ComponentChildren } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { copy } from '../copy';

/**
 * A modal confirmation. It is rendered inline rather than with <dialog>.showModal(), which older
 * WebKitGTK builds lack, and nothing happens until the user picks a button.
 */
export function ConfirmDialog(props: {
  title: string;
  children: ComponentChildren;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm(): void;
  onCancel(): void;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancel.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') props.onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return (
    <div class="overlay">
      <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title">
        <h2 id="dialog-title">{props.title}</h2>
        <div class="dialog-body">{props.children}</div>
        <div class="actions">
          <button type="button" ref={cancel} onClick={props.onCancel}>
            {copy.common.cancel}
          </button>
          <button type="button" class={props.danger ? 'danger' : 'primary'} onClick={props.onConfirm}>
            {props.confirmLabel ?? copy.common.confirm}
          </button>
        </div>
      </div>
    </div>
  );
}

export function ReplyRiskDialog(props: { onConfirm(): void; onCancel(): void }) {
  return (
    <ConfirmDialog title={copy.replyRisk.title} confirmLabel={copy.replyRisk.confirm} danger onConfirm={props.onConfirm} onCancel={props.onCancel}>
      {copy.replyRisk.body.map((p) => (
        <p key={p}>{p}</p>
      ))}
    </ConfirmDialog>
  );
}

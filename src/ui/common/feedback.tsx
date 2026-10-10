// Toasts and modal dialogs (confirm / prompt / info) usable from anywhere via
// plain async functions. Mount <ToastHost/> and <DialogHost/> once per page.

import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { createStore, useStore } from './store';

// ------------------------------------------------------------------ toasts

export type ToastKind = 'ok' | 'warn' | 'error' | 'info';
export interface ToastAction {
  label: string;
  onClick: () => void;
}
export interface Toast {
  id: number;
  message: string;
  kind: ToastKind;
  actions: ToastAction[];
  timeout: number;
}

const toasts = createStore<Toast[]>([]);
let toastSeq = 0;

export function toast(message: string, opts: { kind?: ToastKind; actions?: ToastAction[]; timeout?: number } = {}): number {
  const id = ++toastSeq;
  const actions = opts.actions ?? [];
  const t: Toast = {
    id,
    message,
    kind: opts.kind ?? 'ok',
    actions,
    timeout: opts.timeout ?? (actions.length ? 12000 : opts.kind === 'error' ? 10000 : 5000),
  };
  toasts.update((list) => [...list.slice(-4), t]);
  return id;
}

export function dismissToast(id: number): void {
  toasts.update((list) => list.filter((t) => t.id !== id));
}

function ToastItem({ t }: { t: Toast }) {
  const [hover, setHover] = useState(false);
  useEffect(() => {
    if (hover || t.timeout <= 0) return;
    const h = setTimeout(() => dismissToast(t.id), t.timeout);
    return () => clearTimeout(h);
  }, [hover, t]);
  return (
    <div
      class={`toast toast-${t.kind}`}
      role={t.kind === 'error' ? 'alert' : 'status'}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocusIn={() => setHover(true)}
      onFocusOut={() => setHover(false)}
    >
      <span class="toast-msg">{t.message}</span>
      {t.actions.map((a) => (
        <button
          type="button"
          class="link"
          onClick={() => {
            dismissToast(t.id);
            a.onClick();
          }}
        >
          {a.label}
        </button>
      ))}
      <button type="button" class="icon-btn toast-close" aria-label="Cerrar aviso" onClick={() => dismissToast(t.id)}>
        ×
      </button>
    </div>
  );
}

export function ToastHost() {
  const list = useStore(toasts);
  return (
    <div class="toasts" aria-live="polite">
      {list.map((t) => (
        <ToastItem key={t.id} t={t} />
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ dialogs

interface DialogOptions {
  title: string;
  body?: ComponentChildren;
  confirmLabel?: string;
  /** null hides the cancel button (info dialog). */
  cancelLabel?: string | null;
  danger?: boolean;
  /** User must type exactly this text to enable the confirm button. */
  requireText?: string;
  input?: { label: string; initial?: string; placeholder?: string; suggestions?: string[] };
  wide?: boolean;
}
interface DialogEntry extends DialogOptions {
  id: number;
  resolve: (v: { ok: boolean; value: string }) => void;
}

const dialogs = createStore<DialogEntry[]>([]);
let dialogSeq = 0;

function openDialog(opts: DialogOptions): Promise<{ ok: boolean; value: string }> {
  return new Promise((resolve) => {
    const id = ++dialogSeq;
    const entry: DialogEntry = {
      ...opts,
      id,
      resolve: (v) => {
        dialogs.update((l) => l.filter((d) => d.id !== id));
        resolve(v);
      },
    };
    dialogs.update((l) => [...l, entry]);
  });
}

/** Asks for confirmation. Resolves true only on explicit confirm. */
export async function confirmDialog(opts: Omit<DialogOptions, 'input'>): Promise<boolean> {
  return (await openDialog(opts)).ok;
}

/** Asks for a text value. Resolves null on cancel. */
export async function promptDialog(opts: DialogOptions & { input: NonNullable<DialogOptions['input']> }): Promise<string | null> {
  const r = await openDialog(opts);
  return r.ok ? r.value : null;
}

/** Informational dialog with a single close button. */
export async function infoDialog(title: string, body: ComponentChildren, wide = true): Promise<void> {
  await openDialog({ title, body, confirmLabel: 'Cerrar', cancelLabel: null, wide });
}

let listSeq = 0;

function DialogView({ d }: { d: DialogEntry }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [text, setText] = useState(d.input?.initial ?? '');
  const [typed, setTyped] = useState('');
  const [listId] = useState(() => `dlg-list-${++listSeq}`);
  useEffect(() => {
    const el = ref.current;
    if (el && !el.open) {
      try {
        el.showModal();
      } catch {
        el.setAttribute('open', '');
      }
    }
  }, []);
  const blocked = !!d.requireText && typed.trim() !== d.requireText;
  const close = (ok: boolean) => {
    if (ok && blocked) return;
    d.resolve({ ok, value: text });
  };
  return (
    <dialog
      ref={ref}
      class={`dialog${d.wide ? ' dialog-wide' : ''}`}
      aria-labelledby={`dlg-title-${d.id}`}
      onCancel={(e) => {
        e.preventDefault();
        close(false);
      }}
    >
      <form
        method="dialog"
        onSubmit={(e) => {
          e.preventDefault();
          close(true);
        }}
      >
        <h2 id={`dlg-title-${d.id}`} class="dialog-title">
          {d.title}
        </h2>
        {d.body != null && <div class="dialog-body">{d.body}</div>}
        {d.input && (
          <label class="field">
            <span>{d.input.label}</span>
            <input
              type="text"
              value={text}
              placeholder={d.input.placeholder}
              list={d.input.suggestions?.length ? listId : undefined}
              onInput={(e) => setText(e.currentTarget.value)}
              autoFocus
            />
            {d.input.suggestions?.length ? (
              <datalist id={listId}>
                {d.input.suggestions.map((s) => (
                  <option value={s} />
                ))}
              </datalist>
            ) : null}
          </label>
        )}
        {d.requireText && (
          <label class="field">
            <span>
              Para confirmar, escribí <strong>{d.requireText}</strong>
            </span>
            <input type="text" value={typed} onInput={(e) => setTyped(e.currentTarget.value)} autoComplete="off" autoFocus />
          </label>
        )}
        <div class="dialog-actions">
          {d.cancelLabel !== null && (
            <button type="button" class="btn" onClick={() => close(false)}>
              {d.cancelLabel ?? 'Cancelar'}
            </button>
          )}
          <button type="submit" class={`btn ${d.danger ? 'btn-danger' : 'btn-primary'}`} disabled={blocked} autoFocus={!d.input && !d.requireText}>
            {d.confirmLabel ?? 'Aceptar'}
          </button>
        </div>
      </form>
    </dialog>
  );
}

export function DialogHost() {
  const list = useStore(dialogs);
  return (
    <>
      {list.map((d) => (
        <DialogView key={d.id} d={d} />
      ))}
    </>
  );
}

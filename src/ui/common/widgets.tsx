// Small reusable components shared by popup and dashboard.

import type { ComponentChildren } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { RecordState } from '../../shared/types';
import { faviconUrl, parseTags, STATE_LABELS } from './format';
import { debounce } from './store';

export function Favicon({ url, domain }: { url: string; domain?: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);
  if (failed) {
    const letter = (domain || '?').replace(/^www\./, '').charAt(0).toUpperCase() || '?';
    return (
      <span class="fav fav-fallback" aria-hidden="true">
        {letter}
      </span>
    );
  }
  return (
    <img
      class="fav"
      src={faviconUrl(url)}
      width={16}
      height={16}
      alt=""
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
    />
  );
}

export function StateBadge({ state }: { state: RecordState }) {
  return <span class={`badge badge-${state}`}>{STATE_LABELS[state]}</span>;
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span class="spinner-wrap" role="status">
      <span class="spinner" aria-hidden="true" />
      {label && <span>{label}</span>}
    </span>
  );
}

export function Switch(props: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: ComponentChildren;
  disabled?: boolean;
  hint?: ComponentChildren;
}) {
  return (
    <label class={`switch${props.disabled ? ' is-disabled' : ''}`}>
      <input
        type="checkbox"
        role="switch"
        checked={props.checked}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.currentTarget.checked)}
      />
      <span class="switch-track" aria-hidden="true">
        <span class="switch-thumb" />
      </span>
      <span class="switch-label">
        {props.label}
        {props.hint && <small class="hint">{props.hint}</small>}
      </span>
    </label>
  );
}

let tagListSeq = 0;

/** Tag chips with remove buttons plus an input that adds on Enter or comma. */
export function TagEditor(props: {
  tags: string[];
  onAdd: (tags: string[]) => void;
  onRemove: (tag: string) => void;
  suggestions?: string[];
  disabled?: boolean;
}) {
  const [text, setText] = useState('');
  const [listId] = useState(() => `tag-sugg-${++tagListSeq}`);
  const commit = () => {
    const tags = parseTags(text).filter((t) => !props.tags.includes(t));
    setText('');
    if (tags.length) props.onAdd(tags);
  };
  const sugg = useMemo(
    () => (props.suggestions ?? []).filter((s) => !props.tags.includes(s)).slice(0, 200),
    [props.suggestions, props.tags],
  );
  return (
    <div class="tag-editor">
      {props.tags.map((t) => (
        <span class="chip chip-tag" key={t}>
          {t}
          <button
            type="button"
            class="chip-x"
            aria-label={`Quitar etiqueta ${t}`}
            disabled={props.disabled}
            onClick={() => props.onRemove(t)}
          >
            ×
          </button>
        </span>
      ))}
      <input
        type="text"
        class="tag-input"
        value={text}
        placeholder={props.tags.length ? 'Agregar…' : 'Agregar etiquetas (Enter)'}
        aria-label="Agregar etiqueta"
        list={sugg.length ? listId : undefined}
        disabled={props.disabled}
        onInput={(e) => {
          const v = e.currentTarget.value;
          if (v.includes(',')) {
            setText(v);
            queueMicrotask(() => {
              const tags = parseTags(v).filter((t) => !props.tags.includes(t));
              setText('');
              if (tags.length) props.onAdd(tags);
            });
          } else setText(v);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          } else if (e.key === 'Backspace' && !text && props.tags.length) {
            const last = props.tags[props.tags.length - 1];
            if (last) props.onRemove(last);
          }
        }}
        onBlur={commit}
      />
      {sugg.length > 0 && (
        <datalist id={listId}>
          {sugg.map((s) => (
            <option value={s} />
          ))}
        </datalist>
      )}
    </div>
  );
}

/**
 * Note textarea with debounced autosave (on input) and immediate save on blur.
 * Remount with key=recordId when the record changes.
 */
export function NoteEditor(props: { value: string; onSave: (note: string) => Promise<void>; rows?: number; disabled?: boolean; id?: string }) {
  const [text, setText] = useState(props.value);
  const [status, setStatus] = useState<'idle' | 'dirty' | 'saving' | 'saved' | 'error'>('idle');
  const focused = useRef(false);
  const latest = useRef(props.value);
  const saveRef = useRef(props.onSave);
  saveRef.current = props.onSave;

  const saver = useMemo(
    () =>
      debounce((note: string) => {
        if (note === latest.current) {
          setStatus('idle');
          return;
        }
        setStatus('saving');
        saveRef
          .current(note)
          .then(() => {
            latest.current = note;
            setStatus('saved');
          })
          .catch(() => setStatus('error'));
      }, 700),
    [],
  );
  useEffect(() => {
    // Best effort when the page goes away (e.g. the popup closes) with an unsaved edit.
    const flush = () => saver.flush();
    window.addEventListener('pagehide', flush);
    window.addEventListener('blur', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      window.removeEventListener('blur', flush);
      saver.flush();
    };
  }, [saver]);
  // Accept external updates when the user is not editing.
  useEffect(() => {
    if (!focused.current && !saver.pending()) {
      latest.current = props.value;
      setText(props.value);
    }
  }, [props.value, saver]);

  return (
    <div class="note-editor">
      <textarea
        value={text}
        id={props.id}
        rows={props.rows ?? 4}
        placeholder="¿Por qué guardaste esto? (se guarda solo)"
        aria-label="Nota"
        disabled={props.disabled}
        onFocus={() => (focused.current = true)}
        onBlur={() => {
          focused.current = false;
          saver.flush();
        }}
        onInput={(e) => {
          const v = e.currentTarget.value;
          setText(v);
          setStatus('dirty');
          saver(v);
        }}
      />
      <small class="note-status" aria-live="polite">
        {status === 'saving' ? 'Guardando…' : status === 'saved' ? 'Guardada' : status === 'error' ? 'No se pudo guardar' : status === 'dirty' ? 'Sin guardar…' : ''}
      </small>
    </div>
  );
}

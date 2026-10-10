// Searchable facet pickers (domain: single select, tags: multi select) with counts.

import type { ComponentChildren } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { fmtNum, fold } from '../common/format';

function usePopover() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);
  return { open, setOpen, ref };
}

const MAX_SHOWN = 300;

export interface FacetOption {
  value: string;
  count: number;
}

export function FacetPicker(props: {
  label: string;
  /** Text on the button when nothing is selected. */
  placeholder: string;
  options: FacetOption[];
  selected: string[];
  multi?: boolean;
  onChange: (values: string[]) => void;
  render?: (value: string) => ComponentChildren;
  emptyText?: string;
}) {
  const { open, setOpen, ref } = usePopover();
  const [q, setQ] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) {
      setQ('');
      queueMicrotask(() => inputRef.current?.focus());
    }
  }, [open]);
  const shown = useMemo(() => {
    const t = fold(q.trim());
    const list = t ? props.options.filter((o) => fold(o.value).includes(t)) : props.options;
    return list.slice(0, MAX_SHOWN);
  }, [q, props.options]);
  const sel = new Set(props.selected);
  const toggle = (v: string) => {
    if (props.multi) props.onChange(sel.has(v) ? props.selected.filter((x) => x !== v) : [...props.selected, v]);
    else {
      props.onChange(sel.has(v) ? [] : [v]);
      setOpen(false);
    }
  };
  const btnText =
    props.selected.length === 0
      ? props.placeholder
      : props.multi
        ? `${props.label}: ${props.selected.join(', ')}`
        : `${props.label}: ${props.selected[0]}`;
  return (
    <div class="facet" ref={ref}>
      <button
        type="button"
        class={`btn facet-btn${props.selected.length ? ' is-on' : ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        title={btnText}
      >
        <span class="ellipsis">{btnText}</span>
        <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <div
          class="facet-pop"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              setOpen(false);
            }
          }}
        >
          <input
            ref={inputRef}
            type="search"
            placeholder={`Buscar ${props.label.toLowerCase()}…`}
            value={q}
            aria-label={`Buscar ${props.label.toLowerCase()}`}
            onInput={(e) => setQ(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && shown[0]) {
                e.preventDefault();
                toggle(shown[0].value);
              }
            }}
          />
          <div class="facet-list" role="listbox" aria-multiselectable={props.multi} aria-label={props.label}>
            {props.selected.length > 0 && (
              <button type="button" class="facet-opt facet-clear" onClick={() => props.onChange([])}>
                Quitar filtro
              </button>
            )}
            {shown.length === 0 && <div class="facet-empty muted">{props.emptyText ?? 'Sin resultados'}</div>}
            {shown.map((o) => (
              <button
                type="button"
                role="option"
                aria-selected={sel.has(o.value)}
                class={`facet-opt${sel.has(o.value) ? ' is-sel' : ''}`}
                onClick={() => toggle(o.value)}
              >
                {props.multi && <input type="checkbox" checked={sel.has(o.value)} tabIndex={-1} aria-hidden="true" />}
                <span class="ellipsis grow">{props.render ? props.render(o.value) : o.value}</span>
                <span class="faint">{fmtNum(o.count)}</span>
              </button>
            ))}
            {props.options.length > shown.length && !q && (
              <div class="facet-empty faint">Mostrando {MAX_SHOWN} de {fmtNum(props.options.length)}. Escribí para buscar.</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

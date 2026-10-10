// Renders a RulePreview (what automation would do right now). Used by Reglas and the import wizard.

import { useMemo, useState } from 'preact/hooks';
import type { DecisionAction, RuleDecision, RulePreview } from '../../../shared/types';
import { blockLabel, DECISION_LABELS, fmtMinutes, fmtNum } from '../../common/format';
import { VirtualList } from '../VirtualList';

export function previewCounts(p: RulePreview): Record<DecisionAction, number> {
  const c = { archive: 0, trash: 0, keep: 0 };
  for (const d of p.decisions) c[d.action]++;
  return c;
}

export function PreviewSummary({ preview }: { preview: RulePreview }) {
  const c = previewCounts(preview);
  return (
    <div class="preview-summary">
      <span>
        Abiertas ahora: <strong>{fmtNum(preview.openCount)}</strong>
      </span>
      <span>
        Se archivarían: <strong>{fmtNum(c.archive)}</strong>
      </span>
      <span>
        A papelera: <strong>{fmtNum(c.trash)}</strong>
      </span>
      <span>
        Quedarían abiertas: <strong>{fmtNum(preview.projectedOpenCount)}</strong> (objetivo: {fmtNum(preview.target)})
      </span>
      {preview.capped && <span class="chip chip-warn">Limitado por el tope por ejecución</span>}
    </div>
  );
}

type Tab = 'changes' | DecisionAction | 'all';

export function PreviewTable({ preview, height = 360 }: { preview: RulePreview; height?: number }) {
  const [tab, setTab] = useState<Tab>('changes');
  const c = previewCounts(preview);
  const items = useMemo(() => {
    const ds = preview.decisions;
    const list =
      tab === 'all' ? ds : tab === 'changes' ? ds.filter((d) => d.action !== 'keep') : ds.filter((d) => d.action === tab);
    return list.slice().sort((a, b) => order(a) - order(b) || b.idleMinutes - a.idleMinutes);
  }, [preview, tab]);
  const tabs: { id: Tab; label: string; n: number }[] = [
    { id: 'changes', label: 'Cambios', n: c.archive + c.trash },
    { id: 'archive', label: 'Archivar', n: c.archive },
    { id: 'trash', label: 'Papelera', n: c.trash },
    { id: 'keep', label: 'Mantener', n: c.keep },
    { id: 'all', label: 'Todas', n: preview.decisions.length },
  ];
  return (
    <div class="preview">
      <PreviewSummary preview={preview} />
      <div class="seg" role="group" aria-label="Filtrar decisiones">
        {tabs.map((t) => (
          <button type="button" class={`seg-btn${tab === t.id ? ' is-on' : ''}`} aria-pressed={tab === t.id} onClick={() => setTab(t.id)}>
            {t.label} <span class="faint">{fmtNum(t.n)}</span>
          </button>
        ))}
      </div>
      <div class="phead" aria-hidden="true">
        <span>Acción</span>
        <span>Pestaña</span>
        <span>Motivo</span>
        <span>Sin ver</span>
      </div>
      <VirtualList
        items={items}
        rowHeight={32}
        height={Math.min(height, Math.max(64, items.length * 32 + 2))}
        getKey={(d) => `${d.recordId}-${d.tabId}`}
        resetKey={tab}
        class="preview-list"
        containerProps={{ role: 'list', 'aria-label': 'Decisiones' }}
        empty={<div class="empty">Nada para mostrar.</div>}
        renderRow={(d) => <DecisionRow d={d} />}
      />
    </div>
  );
}

function order(d: RuleDecision): number {
  return d.action === 'trash' ? 0 : d.action === 'archive' ? 1 : 2;
}

function DecisionRow({ d }: { d: RuleDecision }) {
  return (
    <div class="prow" role="listitem">
      <span>
        <span class={`badge dec-${d.action}`}>{DECISION_LABELS[d.action]}</span>
      </span>
      <span class="ellipsis" title={`${d.title}\n${d.url}`}>
        {d.title || d.url}
      </span>
      <span class="ellipsis prow-reason" title={d.reason}>
        {d.blockedBy?.map((b) => (
          <span class="chip chip-block">{blockLabel(b)}</span>
        ))}{' '}
        <span class="muted">{d.reason}</span>
      </span>
      <span class="faint">{fmtMinutes(d.idleMinutes)}</span>
    </div>
  );
}

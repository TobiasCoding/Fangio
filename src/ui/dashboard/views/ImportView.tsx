// Initial import wizard: decide what to do with every open tab, then apply in one go.

import { useEffect, useMemo, useState } from 'preact/hooks';
import type { BulkResult } from '../../../shared/messages';
import type { DecisionAction, ImportCandidate, RulePreview } from '../../../shared/types';
import { errMsg, send } from '../../common/api';
import { confirmDialog, toast } from '../../common/feedback';
import { blockLabel, DECISION_LABELS, fmtNum, fmtRelative, fold, plural } from '../../common/format';
import { showBulkDetail, undoAction } from '../../common/results';
import { useStore } from '../../common/store';
import { Favicon, Spinner } from '../../common/widgets';
import { refreshSettings, settingsStore, titleOf } from '../data';
import { confirmEnableAutomation } from '../ops';
import { buildImportLists, initialImportChoice, invertImportChoices, isImportBlocked, setImportChoices } from '../safety';
import { VirtualList } from '../VirtualList';
import { ExportJsonButton } from './BackupView';
import { PreviewTable } from './PreviewTable';

type Row = { kind: 'win'; ordinal: number; ids: string[] } | { kind: 'tab'; c: ImportCandidate };
type Phase = 'loading' | 'review' | 'applying' | 'done' | 'error';

const ROW_H = 34;

function go(hash: string) {
  location.hash = hash;
}

export function ImportView() {
  const settings = useStore(settingsStore);

  const [phase, setPhase] = useState<Phase>('loading');
  const [error, setError] = useState<string | null>(null);
  const [cands, setCands] = useState<ImportCandidate[]>([]);
  const [choice, setChoice] = useState<Record<string, DecisionAction>>({});
  const [protect, setProtect] = useState<Set<string>>(() => new Set());
  const [q, setQ] = useState('');
  const [domain, setDomain] = useState('');
  const [result, setResult] = useState<BulkResult | null>(null);
  const [preview, setPreview] = useState<RulePreview | null>(null);
  const [enabling, setEnabling] = useState(false);

  const reset = (list: ImportCandidate[]) => {
    const ch: Record<string, DecisionAction> = {};
    const pr = new Set<string>();
    for (const c of list) {
      ch[c.recordId] = initialImportChoice(c);
      if (c.protected) pr.add(c.recordId);
    }
    setChoice(ch);
    setProtect(pr);
  };

  const load = async () => {
    setPhase('loading');
    try {
      const list = await send({ type: 'getImportPreview' });
      list.sort((a, b) => a.windowOrdinal - b.windowOrdinal || a.index - b.index);
      setCands(list);
      reset(list);
      setPhase('review');
    } catch (e) {
      setError(errMsg(e));
      setPhase('error');
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const domains = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of cands) m.set(c.domain, (m.get(c.domain) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'es', { numeric: true }));
  }, [cands]);

  const rows = useMemo(() => {
    const t = fold(q.trim());
    const visible = t ? cands.filter((c) => fold(`${c.title} ${c.url}`).includes(t)) : cands;
    const out: Row[] = [];
    let cur: { kind: 'win'; ordinal: number; ids: string[] } | null = null;
    for (const c of visible) {
      if (!cur || cur.ordinal !== c.windowOrdinal) {
        cur = { kind: 'win', ordinal: c.windowOrdinal, ids: [] };
        out.push(cur);
      }
      cur.ids.push(c.recordId);
      out.push({ kind: 'tab', c });
    }
    return out;
  }, [cands, q]);

  // Rows blocked by protections (active, pinned, audio, excluded site, ...) are locked to "keep".
  const blockedIds = useMemo(() => new Set(cands.filter(isImportBlocked).map((c) => c.recordId)), [cands]);
  const locked = (id: string) => protect.has(id) || blockedIds.has(id);

  const counts = useMemo(() => {
    const n = { archive: 0, trash: 0, keep: 0 };
    for (const c of cands) n[protect.has(c.recordId) || blockedIds.has(c.recordId) ? 'keep' : (choice[c.recordId] ?? 'keep')]++;
    return n;
  }, [cands, choice, protect, blockedIds]);

  const setMany = (ids: string[], action: DecisionAction) => {
    setChoice((prev) => setImportChoices(prev, ids, action, locked));
  };

  const toggleProtect = (id: string, on: boolean) => {
    setProtect((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
    if (on) setChoice((prev) => ({ ...prev, [id]: 'keep' }));
  };

  const invert = () => {
    setChoice((prev) =>
      invertImportChoices(
        prev,
        cands.map((c) => c.recordId),
        locked,
      ),
    );
  };

  const idsOfDomain = (d: string) => cands.filter((c) => c.domain === d).map((c) => c.recordId);

  const apply = async () => {
    // Blocked rows are never sent to archive/trash (the background re-checks anyway).
    const { archiveIds, trashIds, protectIds, blocked } = buildImportLists(cands, choice, protect);
    const ok = await confirmDialog({
      title: 'Aplicar la importación',
      body: (
        <>
          <p>
            Se archivarán <strong>{fmtNum(archiveIds.length)}</strong>, irán a la papelera <strong>{fmtNum(trashIds.length)}</strong>{' '}
            y quedarán abiertas <strong>{fmtNum(counts.keep)}</strong>
            {protectIds.length ? ` (${fmtNum(protectIds.length)} protegidas)` : ''}.
          </p>
          {blocked > 0 && (
            <p class="muted">
              {plural(blocked, 'pestaña queda abierta', 'pestañas quedan abiertas')} por estar activas, fijadas, con audio, protegidas o
              en sitios excluidos.
            </p>
          )}
          <p class="muted">Cada referencia se guarda y se verifica antes de cerrar su pestaña. Podés deshacerlo desde Registro.</p>
        </>
      ),
      confirmLabel: 'Aplicar',
    });
    if (!ok) return;
    setPhase('applying');
    try {
      const res = await send({ type: 'applyImport', archiveIds, trashIds, protectIds });
      setResult(res);
      setPhase('done');
      void refreshSettings();
      send({ type: 'previewRules' })
        .then(setPreview)
        .catch(() => {});
    } catch (e) {
      setError(errMsg(e));
      setPhase('error');
    }
  };

  const skip = async () => {
    try {
      await send({ type: 'skipOnboarding' });
      void refreshSettings();
      go('#/lista');
    } catch (e) {
      toast(`No se pudo omitir: ${errMsg(e)}`, { kind: 'error' });
    }
  };

  const enableAutomation = async () => {
    setEnabling(true);
    try {
      // Fresh preview + explicit confirmation with the counts of what would close right now.
      const fresh = await confirmEnableAutomation();
      if (!fresh) return;
      setPreview(fresh);
      const s = await send({ type: 'getSettings' });
      const saved = await send({ type: 'saveSettings', settings: { ...s, automationEnabled: true } });
      settingsStore.set(saved);
      toast('Automatización activada');
      go('#/lista');
    } catch (e) {
      toast(`No se pudo activar: ${errMsg(e)}`, { kind: 'error' });
    } finally {
      setEnabling(false);
    }
  };

  // ---------------------------------------------------------------- phases

  if (phase === 'loading') return <div class="page narrow"><Spinner label="Leyendo las pestañas abiertas…" /></div>;
  if (phase === 'error')
    return (
      <div class="page narrow">
        <div class="notice notice-danger">Algo falló: {error}</div>
        <p style={{ marginTop: '10px' }}>
          <button type="button" class="btn" onClick={() => void load()}>
            Reintentar
          </button>
        </p>
      </div>
    );
  if (phase === 'applying')
    return (
      <div class="page narrow">
        <h1>Importando…</h1>
        <p class="muted">Guardando cada referencia, verificándola y recién entonces cerrando su pestaña. Puede tardar unos segundos.</p>
        <div class="progress" aria-label="En progreso" />
      </div>
    );
  if (phase === 'done' && result) {
    const reasons = new Map<string, number>();
    for (const s of result.skipped) reasons.set(s.reason, (reasons.get(s.reason) ?? 0) + 1);
    return (
      <div class="page narrow">
        <h1>Importación lista</h1>
        <div class={`notice ${result.failed.length ? 'notice-warn' : 'notice-ok'}`}>
          <p>
            Procesadas: <strong>{fmtNum(result.done.length)}</strong> · omitidas: <strong>{fmtNum(result.skipped.length)}</strong> ·
            con error: <strong>{fmtNum(result.failed.length)}</strong>
          </p>
          {reasons.size > 0 && (
            <ul>
              {[...reasons.entries()].map(([r, n]) => (
                <li>
                  {r}: {fmtNum(n)}
                </li>
              ))}
            </ul>
          )}
          <div class="row">
            {(result.skipped.length > 0 || result.failed.length > 0) && (
              <button type="button" class="link" onClick={() => void showBulkDetail(result, titleOf)}>
                Ver detalle
              </button>
            )}
            {result.actionId && (
              <button type="button" class="link" onClick={() => void undoAction(result.actionId as string)}>
                Deshacer
              </button>
            )}
          </div>
        </div>

        <section class="card">
          <h2>¿Activar la automatización?</h2>
          <p class="muted">
            Con la automatización activa, Fangio archiva solo las pestañas que no mirás hace rato, respetando protecciones y sitios
            excluidos. Esto es lo que haría ahora:
          </p>
          {preview ? <PreviewTable preview={preview} height={280} /> : <Spinner label="Calculando…" />}
          <div class="row" style={{ marginTop: '12px' }}>
            <button type="button" class="btn btn-primary" disabled={enabling} onClick={() => void enableAutomation()}>
              Activar automatización
            </button>
            <button type="button" class="btn" onClick={() => go('#/reglas')}>
              Ajustar reglas primero
            </button>
            <button type="button" class="btn btn-ghost" onClick={() => go('#/lista')}>
              Ahora no
            </button>
          </div>
        </section>
      </div>
    );
  }

  // ---------------------------------------------------------------- review

  const target = settings?.targetOpenTabs;
  const renderRow = (row: Row) => {
    if (row.kind === 'win') {
      return (
        <div class="irow iwin">
          <strong>Ventana {row.ordinal}</strong>
          <span class="faint">{plural(row.ids.length, 'pestaña', 'pestañas')}</span>
          <span class="spacer" />
          <span class="muted">Todo:</span>
          <button type="button" class="btn btn-sm" onClick={() => setMany(row.ids, 'archive')}>
            Archivar
          </button>
          <button type="button" class="btn btn-sm" onClick={() => setMany(row.ids, 'trash')}>
            Papelera
          </button>
          <button type="button" class="btn btn-sm" onClick={() => setMany(row.ids, 'keep')}>
            Mantener
          </button>
        </div>
      );
    }
    const c = row.c;
    const prot = protect.has(c.recordId);
    const blocked = blockedIds.has(c.recordId);
    const action = prot || blocked ? 'keep' : (choice[c.recordId] ?? 'keep');
    const blockedTip = blocked
      ? `Bloqueada: ${c.blockedBy.map((b) => blockLabel(b)).join(', ')}. Podés archivarla después desde la lista.`
      : undefined;
    return (
      <div class={`irow itab act-${action}`}>
        <select
          class="iaction"
          value={action}
          disabled={prot || blocked}
          title={blockedTip}
          aria-label={`Acción para ${c.title || c.url}`}
          onChange={(e) => setMany([c.recordId], e.currentTarget.value as DecisionAction)}
        >
          <option value="archive">Archivar</option>
          <option value="trash">Papelera</option>
          <option value="keep">Mantener abierta</option>
        </select>
        <label class="check iprot" title="Proteger: nunca se cierra automáticamente">
          <input type="checkbox" checked={prot} onChange={(e) => toggleProtect(c.recordId, e.currentTarget.checked)} />
          <span class="sr-only">Proteger</span>
        </label>
        <Favicon url={c.url} domain={c.domain} />
        <span class="ititle ellipsis" title={`${c.title}\n${c.url}`}>
          {c.title || c.url}
        </span>
        <span class="idomain ellipsis">{c.domain}</span>
        <span class="iflags">
          {c.pinned && <span class="chip chip-block">Fijada</span>}
          {c.active && <span class="chip chip-block">Activa</span>}
          {c.audible && <span class="chip chip-block">Audio</span>}
          {c.groupTitle && <span class="chip">Grupo: {c.groupTitle}</span>}
          {c.duplicateCount > 1 && <span class="chip chip-warn">Duplicado ×{c.duplicateCount}</span>}
          {c.blockedBy
            .filter((b) => !(b === 'pinned' && c.pinned) && !(b === 'active' && c.active) && !(b === 'audible' && c.audible))
            .map((b) => (
              <span class="chip chip-block">{blockLabel(b)}</span>
            ))}
        </span>
        <span class="faint idate" title={c.reason}>
          {c.lastAccessedAt ? fmtRelative(c.lastAccessedAt) : ''}
        </span>
        <button
          type="button"
          class="btn btn-ghost btn-sm ikeepdom"
          title={`Mantener todo lo de ${c.domain}`}
          onClick={() => setMany(idsOfDomain(c.domain), 'keep')}
        >
          Mantener dominio
        </button>
      </div>
    );
  };

  return (
    <div class="page import">
      <h1>Importación inicial</h1>
      <div class="import-intro">
        <div>
          <p>
            Tenés <strong>{plural(cands.length, 'pestaña abierta', 'pestañas abiertas')}</strong>
            . Elegí qué hacer con cada una: <strong>Archivar</strong> (se cierra y queda guardada),{' '}
            <strong>Papelera</strong> (recuperable) o <strong>Mantener abierta</strong>.
          </p>
          <ul class="muted">
            <li>Fangio lee título y URL sin cargar ni recargar las páginas.</li>
            <li>Cada referencia se guarda y se verifica antes de cerrar su pestaña.</li>
            <li>
              Las pestañas activas, fijadas, con audio, protegidas o de sitios excluidos quedan abiertas; podés archivarlas después
              desde la lista.
            </li>
            <li>Todo se puede reabrir o deshacer desde Registro.</li>
          </ul>
        </div>
        <div class="notice notice-info import-backup">
          <p>
            <strong>Recomendado:</strong> exportá una copia JSON antes de empezar.
          </p>
          <ExportJsonButton primary={false} />
        </div>
      </div>

      <div class="toolbar import-tools">
        <input type="search" placeholder="Filtrar por título o URL…" aria-label="Filtrar pestañas" value={q} onInput={(e) => setQ(e.currentTarget.value)} />
        <select value={domain} aria-label="Dominio" onChange={(e) => setDomain(e.currentTarget.value)}>
          <option value="">Por dominio…</option>
          {domains.map(([d, n]) => (
            <option value={d}>
              {d} ({n})
            </option>
          ))}
        </select>
        {(['archive', 'trash', 'keep'] as DecisionAction[]).map((a) => (
          <button type="button" class="btn btn-sm" disabled={!domain} onClick={() => setMany(idsOfDomain(domain), a)}>
            {DECISION_LABELS[a]}
          </button>
        ))}
        <span class="bulk-sep" />
        <button type="button" class="btn btn-sm" onClick={invert} title="Archivar ↔ Mantener (no toca Papelera ni protegidas)">
          Invertir
        </button>
        <button type="button" class="btn btn-sm btn-ghost" onClick={() => reset(cands)}>
          Restablecer sugerencias
        </button>
      </div>

      <VirtualList
        items={rows}
        rowHeight={ROW_H}
        renderRow={renderRow}
        getKey={(r) => (r.kind === 'win' ? `w${r.ordinal}` : r.c.recordId)}
        class="import-list"
        containerProps={{ role: 'list', 'aria-label': 'Pestañas abiertas' }}
        empty={<div class="empty">{cands.length ? 'Nada coincide con el filtro.' : 'No hay pestañas abiertas para importar.'}</div>}
      />

      <div class="savebar is-dirty import-summary">
        <span>
          Se archivarán <strong>{fmtNum(counts.archive)}</strong> · a papelera <strong>{fmtNum(counts.trash)}</strong> · quedan
          abiertas <strong>{fmtNum(counts.keep)}</strong>
          {target ? <span class="muted"> (objetivo: {fmtNum(target)})</span> : null}
        </span>
        <span class="spacer" />
        <button type="button" class="btn btn-ghost" onClick={() => void skip()}>
          Omitir
        </button>
        <button type="button" class="btn btn-primary" disabled={!cands.length || counts.archive + counts.trash + protect.size === 0} onClick={() => void apply()}>
          Confirmar
        </button>
      </div>
    </div>
  );
}

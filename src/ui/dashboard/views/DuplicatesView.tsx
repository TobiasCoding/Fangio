// Duplicados: references with the IDENTICAL URL, with manual "merge into this one".

import { useMemo, useState } from 'preact/hooks';
import type { TabRecord } from '../../../shared/types';
import { groupDuplicates } from '../../../core/duplicates';
import { errMsg, send } from '../../common/api';
import { confirmDialog, toast } from '../../common/feedback';
import { fmtNum, fmtRelative, fold, plural } from '../../common/format';
import { reportBulk } from '../../common/results';
import { useStore } from '../../common/store';
import { Favicon, Spinner, StateBadge } from '../../common/widgets';
import { recordsStore, titleOf } from '../data';
import { closeRecords } from '../ops';

const PAGE = 40;

async function mergeInto(keep: TabRecord, group: TabRecord[]) {
  const mergeable = group.filter((r) => r.id !== keep.id && r.state !== 'open');
  const openOthers = group.filter((r) => r.id !== keep.id && r.state === 'open').length;
  if (!mergeable.length) return;
  const ok = await confirmDialog({
    title: `Fusionar ${plural(mergeable.length, 'referencia', 'referencias')} en esta`,
    body: (
      <>
        <p>
          Se conserva «{keep.title || keep.url}» y se le agregan las etiquetas y notas de las otras; pendiente/protegida se suman,
          y se guardan la fecha de creación más antigua y el último acceso más reciente.
        </p>
        <p>
          Las otras {fmtNum(mergeable.length)} pasan a la <strong>papelera</strong> (recuperables). Podés deshacerlo desde Registro.
        </p>
        {openOthers > 0 && (
          <p class="muted">{plural(openOthers, 'referencia abierta queda', 'referencias abiertas quedan')} afuera: archivalas antes si querés fusionarlas.</p>
        )}
      </>
    ),
    confirmLabel: 'Fusionar',
  });
  if (!ok) return;
  try {
    reportBulk(await send({ type: 'merge', keepId: keep.id, mergeIds: mergeable.map((r) => r.id) }), { verb: 'Fusionadas', titleOf });
  } catch (e) {
    toast(`No se pudo fusionar: ${errMsg(e)}`, { kind: 'error' });
  }
}

function GroupCard({ url, records }: { url: string; records: TabRecord[] }) {
  return (
    <section class="card dup-group">
      <div class="dup-head">
        <Favicon url={url} />
        <span class="mono dup-url" title={url}>
          {url}
        </span>
        <span class="chip">×{records.length}</span>
      </div>
      <div class="dup-rows">
        {records.map((r) => {
          const others = records.filter((x) => x.id !== r.id);
          const mergeable = others.filter((x) => x.state !== 'open');
          const disabledReason = !mergeable.length ? 'Las demás están abiertas: un registro abierto no se puede fusionar (archivalo antes).' : undefined;
          return (
            <div class="dup-row">
              <StateBadge state={r.state} />
              <div class="grow">
                <div class="ellipsis dup-title">{r.title || r.url}</div>
                <div class="dup-meta">
                  <span>Creada {fmtRelative(r.createdAt)}</span>
                  {r.lastAccessedAt && <span>· vista {fmtRelative(r.lastAccessedAt)}</span>}
                  {r.archivedAt && <span>· archivada {fmtRelative(r.archivedAt)}</span>}
                  {r.protected && <span class="chip chip-protected">Protegida</span>}
                  {r.pending && <span class="chip chip-pending">Pendiente</span>}
                  {r.tags.map((t) => (
                    <span class="chip chip-tag">{t}</span>
                  ))}
                </div>
                {r.note && <div class="dup-note muted ellipsis">“{r.note.slice(0, 160)}”</div>}
              </div>
              {r.state === 'open' && (
                <button type="button" class="btn btn-sm" onClick={() => void closeRecords([r.id], 'archive')}>
                  Archivar
                </button>
              )}
              <span title={disabledReason}>
                <button type="button" class="btn btn-sm" disabled={!!disabledReason} onClick={() => void mergeInto(r, records)}>
                  Fusionar en este
                </button>
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

export function DuplicatesView() {
  const { list, loaded } = useStore(recordsStore);
  const [shown, setShown] = useState(PAGE);
  const [q, setQ] = useState('');
  const groups = useMemo(() => {
    const g = groupDuplicates(list.filter((r) => r.state !== 'trash'));
    return g.slice().sort((a, b) => b.records.length - a.records.length || a.url.localeCompare(b.url));
  }, [list]);
  const visible = useMemo(() => {
    const t = fold(q.trim());
    return t ? groups.filter((g) => fold(g.url).includes(t) || g.records.some((r) => fold(r.title).includes(t))) : groups;
  }, [groups, q]);
  const extra = groups.reduce((n, g) => n + g.records.length - 1, 0);

  return (
    <div class="page narrow">
      <h1>Duplicados</h1>
      <p class="muted">
        Se agrupan sólo las referencias con la URL <strong>idéntica</strong> (no se cuentan las de la papelera). Una URL con otros
        parámetros o fragmento es distinta: <code>https://x.com/a</code>, <code>https://x.com/a?b=1</code> y{' '}
        <code>https://x.com/a#c</code> son tres URLs diferentes. Nada se fusiona solo.
      </p>
      <p class="muted">
        «Fusionar en este» une etiquetas, notas y fechas en la referencia elegida y manda las demás a la papelera. Las referencias
        abiertas no se pueden fusionar en otra: archivalas antes.
      </p>
      {!loaded ? (
        <Spinner label="Cargando…" />
      ) : groups.length === 0 ? (
        <div class="notice notice-ok">No hay duplicados.</div>
      ) : (
        <>
          <div class="toolbar">
            <span>
              <strong>{plural(groups.length, 'URL repetida', 'URLs repetidas')}</strong> · {plural(extra, 'copia de más', 'copias de más')}
            </span>
            <span class="spacer" />
            <input type="search" placeholder="Filtrar…" aria-label="Filtrar duplicados" value={q} onInput={(e) => setQ(e.currentTarget.value)} />
          </div>
          {visible.slice(0, shown).map((g) => (
            <GroupCard key={g.url} url={g.url} records={g.records} />
          ))}
          {visible.length > shown && (
            <button type="button" class="btn" onClick={() => setShown(shown + PAGE)}>
              Mostrar más ({fmtNum(visible.length - shown)} restantes)
            </button>
          )}
        </>
      )}
    </div>
  );
}

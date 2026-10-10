// Copias: JSON export/import and bookmarks HTML export.

import { useRef, useState } from 'preact/hooks';
import type { ImportJsonResult } from '../../../shared/types';
import { errMsg, send } from '../../common/api';
import { toast } from '../../common/feedback';
import { fmtDateTime, fmtNum, fmtRelative, plural } from '../../common/format';
import { useStore } from '../../common/store';
import { Spinner } from '../../common/widgets';
import { exportBookmarks, exportJson } from '../backup';
import { statusStore } from '../data';

export function ExportJsonButton({ primary = true }: { primary?: boolean }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      class={`btn${primary ? ' btn-primary' : ''}`}
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          const n = await exportJson();
          toast(`Copia JSON descargada (${plural(n, 'referencia', 'referencias')})`);
        } catch (e) {
          toast(`No se pudo exportar: ${errMsg(e)}`, { kind: 'error' });
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? 'Exportando…' : 'Exportar copia JSON'}
    </button>
  );
}

export function BackupView() {
  const status = useStore(statusStore);
  const fileRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<ImportJsonResult | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [busyHtml, setBusyHtml] = useState(false);

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setImporting(true);
    setResult(null);
    setImportError(null);
    try {
      const text = await file.text();
      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error('El archivo no es un JSON válido.');
      }
      const r = await send({ type: 'importJson', data });
      setResult(r);
      toast(`Importación: ${fmtNum(r.added)} nuevas · ${fmtNum(r.updated)} actualizadas`);
    } catch (e) {
      setImportError(errMsg(e));
    } finally {
      setImporting(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  return (
    <div class="page narrow">
      <h1>Copias de seguridad</h1>
      <div class="notice notice-warn">
        <strong>Importante:</strong> si quitás la extensión («Quitar» en chrome://extensions), el navegador borra toda su
        base de datos. Recargarla o actualizarla <strong>no</strong> borra nada. Exportá una copia con regularidad y guardala
        fuera del navegador.
      </div>
      <p class="muted">
        Última copia:{' '}
        {status?.lastBackupAt ? (
          <>
            {fmtDateTime(status.lastBackupAt)} ({fmtRelative(status.lastBackupAt)})
          </>
        ) : (
          'nunca'
        )}
      </p>

      <section class="card">
        <h2>Exportar</h2>
        <p>
          <strong>JSON</strong>: copia completa (referencias, notas, etiquetas, configuración y las últimas 1000 entradas del
          registro). Es lo que se usa para restaurar Fangio.
        </p>
        <ExportJsonButton />
        <p style={{ marginTop: '14px' }}>
          <strong>HTML de marcadores</strong>: todas las URLs en el formato estándar de marcadores. Se puede importar en
          cualquier navegador aunque no tengas Fangio.
        </p>
        <button
          type="button"
          class="btn"
          disabled={busyHtml}
          onClick={async () => {
            setBusyHtml(true);
            try {
              const n = await exportBookmarks();
              toast(`Marcadores descargados (${plural(n, 'referencia', 'referencias')})`);
            } catch (e) {
              toast(`No se pudo exportar: ${errMsg(e)}`, { kind: 'error' });
            } finally {
              setBusyHtml(false);
            }
          }}
        >
          {busyHtml ? 'Exportando…' : 'Exportar HTML de marcadores'}
        </button>
      </section>

      <section class="card">
        <h2>Importar copia JSON</h2>
        <p class="muted">
          Se fusiona por identificador: si una referencia ya existe gana la versión modificada más recientemente. Nunca se borra
          nada al importar. Las referencias que estaban abiertas se importan como archivadas (no se abren pestañas).
        </p>
        <label class="btn">
          {importing ? 'Importando…' : 'Elegir archivo .json'}
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            class="sr-only"
            disabled={importing}
            onChange={(e) => void onFile(e.currentTarget.files?.[0])}
          />
        </label>
        {importing && <Spinner />}
        {importError && <div class="notice notice-danger" style={{ marginTop: '10px' }}>{importError}</div>}
        {result && (
          <div class="notice notice-ok" style={{ marginTop: '10px' }}>
            <p>
              Nuevas: <strong>{fmtNum(result.added)}</strong> · actualizadas: <strong>{fmtNum(result.updated)}</strong> · sin
              cambios: <strong>{fmtNum(result.unchanged)}</strong> · rechazadas: <strong>{fmtNum(result.rejected.length)}</strong>
            </p>
            {result.rejected.length > 0 && (
              <details>
                <summary>Ver rechazadas</summary>
                <ul>
                  {result.rejected.slice(0, 200).map((r) => (
                    <li>
                      Elemento #{r.index + 1}: {r.error}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

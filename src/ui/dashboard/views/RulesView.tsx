// Reglas: settings form, exact-URL rules, site exclusions, preview and manual run.

import type { ComponentChildren } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';
import type { RulePreview, Settings, UrlRule } from '../../../shared/types';
import { sanitizeSettings } from '../../../shared/settings';
import { canonicalUrl } from '../../../core/url';
import { errMsg, send } from '../../common/api';
import { confirmDialog, toast } from '../../common/feedback';
import { fmtNum } from '../../common/format';
import { reportBulk } from '../../common/results';
import { useStore } from '../../common/store';
import { Spinner, Switch } from '../../common/widgets';
import { settingsStore, titleOf } from '../data';
import { previewCounts, PreviewTable } from './PreviewTable';

const HOST_RE = /^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)*(:\d+)?$/i;

function NumberField(props: {
  label: string;
  hint?: ComponentChildren;
  value: number;
  min: number;
  max: number;
  unit?: string;
  onChange: (v: number) => void;
}) {
  return (
    <label class="nfield">
      <span class="nfield-label">
        {props.label}
        {props.hint && <small class="hint">{props.hint}</small>}
      </span>
      <span class="row">
        <input
          type="number"
          min={props.min}
          max={props.max}
          step={1}
          value={props.value}
          onInput={(e) => {
            const v = e.currentTarget.valueAsNumber;
            if (Number.isFinite(v)) props.onChange(Math.round(v));
          }}
        />
        {props.unit && <span class="muted">{props.unit}</span>}
      </span>
    </label>
  );
}

function splitLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim().toLowerCase())
    .filter(Boolean);
}

export function RulesView() {
  const stored = useStore(settingsStore);
  const [saved, setSaved] = useState<Settings | null>(null);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [exclText, setExclText] = useState('');
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState<RulePreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [running, setRunning] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const adopt = (s: Settings) => {
    setSaved(s);
    setDraft(s);
    setExclText(s.siteExclusions.join('\n'));
  };

  useEffect(() => {
    send({ type: 'getSettings' })
      .then(adopt)
      .catch((e) => {
        if (stored) adopt(stored);
        else setLoadError(errMsg(e));
      });
  }, []);

  const exclLines = useMemo(() => splitLines(exclText), [exclText]);
  const badExcl = exclLines.filter((l) => !HOST_RE.test(l) && !/^[a-z]+:\/\/[^/]+/i.test(l));
  const ruleErrors = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of draft?.urlRules ?? []) {
      if (!r.url.trim()) m.set(r.id, 'Escribí una URL');
      else if (!canonicalUrl(r.url.trim())) m.set(r.id, 'URL inválida (incluí https://)');
    }
    return m;
  }, [draft?.urlRules]);

  if (loadError) return <div class="page narrow"><div class="notice notice-danger">No se pudo cargar la configuración: {loadError}</div></div>;
  if (!draft || !saved) return <div class="page narrow"><Spinner label="Cargando configuración…" /></div>;

  const dirty = JSON.stringify({ ...draft, siteExclusions: exclLines }) !== JSON.stringify(saved);
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setDraft({ ...draft, [k]: v });
  const setRule = (id: string, patch: Partial<UrlRule>) =>
    set('urlRules', draft.urlRules.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  const save = async (): Promise<Settings | null> => {
    if (ruleErrors.size || badExcl.length) {
      toast('Corregí las reglas de URL o los sitios excluidos marcados antes de guardar.', { kind: 'warn' });
      return null;
    }
    setSaving(true);
    try {
      const latest = settingsStore.get();
      const next = sanitizeSettings({
        ...draft,
        siteExclusions: exclLines,
        urlRules: draft.urlRules.map((r) => ({ ...r, url: r.url.trim() })),
        // never clobber fields managed elsewhere
        onboardingDone: !!(latest?.onboardingDone || draft.onboardingDone),
        ...(latest?.lastBackupAt !== undefined || draft.lastBackupAt !== undefined
          ? { lastBackupAt: Math.max(latest?.lastBackupAt ?? 0, draft.lastBackupAt ?? 0) }
          : {}),
      });
      const res = await send({ type: 'saveSettings', settings: next });
      adopt(res);
      settingsStore.set(res);
      toast('Configuración guardada');
      return res;
    } catch (e) {
      toast(`No se pudo guardar: ${errMsg(e)}`, { kind: 'error' });
      return null;
    } finally {
      setSaving(false);
    }
  };

  const ensureSaved = async (): Promise<boolean> => {
    if (!dirty) return true;
    const ok = await confirmDialog({
      title: 'Hay cambios sin guardar',
      body: <p>La previsualización usa la configuración guardada. ¿Guardar los cambios primero?</p>,
      confirmLabel: 'Guardar y seguir',
    });
    return ok ? (await save()) !== null : false;
  };

  const doPreview = async (): Promise<RulePreview | null> => {
    if (!(await ensureSaved())) return null;
    setPreviewing(true);
    try {
      const p = await send({ type: 'previewRules' });
      setPreview(p);
      return p;
    } catch (e) {
      toast(`No se pudo previsualizar: ${errMsg(e)}`, { kind: 'error' });
      return null;
    } finally {
      setPreviewing(false);
    }
  };

  const runNow = async () => {
    const p = await doPreview();
    if (!p) return;
    const c = previewCounts(p);
    if (c.archive + c.trash === 0) {
      toast('Las reglas no cerrarían ninguna pestaña ahora.', { kind: 'info' });
      return;
    }
    const ok = await confirmDialog({
      title: 'Ejecutar las reglas ahora',
      body: (
        <p>
          Se archivarán <strong>{fmtNum(c.archive)}</strong> y irán a la papelera <strong>{fmtNum(c.trash)}</strong>. Quedarán{' '}
          <strong>{fmtNum(p.projectedOpenCount)}</strong> abiertas. Cada referencia se guarda y verifica antes de cerrar la
          pestaña; podés deshacerlo desde Registro.
        </p>
      ),
      confirmLabel: 'Ejecutar',
    });
    if (!ok) return;
    setRunning(true);
    try {
      reportBulk(await send({ type: 'runRulesNow' }), { verb: 'Procesadas', titleOf });
      void doPreview();
    } catch (e) {
      toast(`No se pudieron ejecutar las reglas: ${errMsg(e)}`, { kind: 'error' });
    } finally {
      setRunning(false);
    }
  };

  return (
    <div class="page narrow rules">
      <h1>Reglas y configuración</h1>

      <section class="card">
        <Switch
          checked={draft.automationEnabled}
          onChange={(v) => set('automationEnabled', v)}
          label={<strong>Automatización {draft.automationEnabled ? 'activada' : 'desactivada'}</strong>}
          hint="Cuando está activa, Fangio revisa las pestañas periódicamente y archiva según estas reglas. Mirá la previsualización antes de activarla."
        />
        <div class="notice notice-info precedence">
          <strong>Orden de prioridad:</strong> protecciones (protegida, fijada, activa, con audio, sitio excluido…) &gt; reglas de
          URL &gt; inactividad &gt; objetivo de pestañas abiertas. Una pestaña protegida nunca se cierra sola.
        </div>
      </section>

      <section class="card">
        <h2>Objetivo e inactividad</h2>
        <div class="grid2">
          <NumberField label="Objetivo de pestañas abiertas" hint="Orientativo: las protecciones y la actividad reciente tienen prioridad." value={draft.targetOpenTabs} min={1} max={10000} onChange={(v) => set('targetOpenTabs', v)} />
          <NumberField label="Archivar si no se ve hace" hint="0 = desactivado." unit="horas" value={draft.idleArchiveHours} min={0} max={8760} onChange={(v) => set('idleArchiveHours', v)} />
          <NumberField label="Para el objetivo, no archivar si se vio hace menos de" unit="minutos" value={draft.targetMinIdleMinutes} min={0} max={43200} onChange={(v) => set('targetMinIdleMinutes', v)} />
          <NumberField label="Margen tras reproducir audio" hint="Una pestaña con audio reciente no se cierra." unit="minutos" value={draft.audioGraceMinutes} min={0} max={1440} onChange={(v) => set('audioGraceMinutes', v)} />
          <NumberField label="Revisar cada" unit="minutos" value={draft.checkIntervalMinutes} min={1} max={1440} onChange={(v) => set('checkIntervalMinutes', v)} />
          <NumberField label="Máximo de cierres por revisión" hint="Tope de seguridad." value={draft.maxAutoClosePerRun} min={1} max={1000} onChange={(v) => set('maxAutoClosePerRun', v)} />
        </div>
      </section>

      <section class="card">
        <h2>Reglas por URL exacta</h2>
        <p class="muted">
          Coinciden con la URL <strong>exacta</strong>. Rutas, parámetros y fragmentos cuentan: <code>https://chatgpt.com/</code>{' '}
          no coincide con <code>https://chatgpt.com/c/123</code>, ni con <code>https://chatgpt.com/?model=x</code>, ni con{' '}
          <code>https://chatgpt.com/#x</code>.
        </p>
        <div class="url-rules">
          {draft.urlRules.length === 0 && <p class="faint">No hay reglas.</p>}
          {draft.urlRules.map((r) => {
            const err = ruleErrors.get(r.id);
            const canon = !err ? canonicalUrl(r.url.trim()) : null;
            return (
              <div class={`url-rule${r.enabled ? '' : ' is-off'}`} key={r.id}>
                <input type="checkbox" checked={r.enabled} aria-label="Regla habilitada" title="Habilitada" onChange={(e) => setRule(r.id, { enabled: e.currentTarget.checked })} />
                <div class="grow">
                  <div class="row wrap">
                    <input type="url" class="grow rule-url" value={r.url} placeholder="https://ejemplo.com/" aria-label="URL" aria-invalid={!!err} onInput={(e) => setRule(r.id, { url: e.currentTarget.value })} />
                    <select value={r.action} aria-label="Acción" onChange={(e) => setRule(r.id, { action: e.currentTarget.value as UrlRule['action'] })}>
                      <option value="trash">Papelera</option>
                      <option value="archive">Archivar</option>
                    </select>
                    <span class="row">
                      <span class="muted">sin ver</span>
                      <input type="number" class="num-sm" min={0} value={r.afterMinutes} aria-label="Minutos sin ver" onInput={(e) => {
                        const v = e.currentTarget.valueAsNumber;
                        if (Number.isFinite(v)) setRule(r.id, { afterMinutes: Math.max(0, Math.round(v)) });
                      }} />
                      <span class="muted">min</span>
                    </span>
                    <input type="text" class="rule-label" value={r.label ?? ''} placeholder="Etiqueta (opcional)" aria-label="Etiqueta de la regla" onInput={(e) => setRule(r.id, { label: e.currentTarget.value })} />
                    <button type="button" class="icon-btn" aria-label="Eliminar regla" title="Eliminar regla" onClick={() => set('urlRules', draft.urlRules.filter((x) => x.id !== r.id))}>×</button>
                  </div>
                  {err ? <small class="error-text">{err}</small> : <small class="faint">Coincide exactamente con: <code>{canon}</code></small>}
                </div>
              </div>
            );
          })}
        </div>
        <button type="button" class="btn btn-sm" onClick={() => set('urlRules', [...draft.urlRules, { id: crypto.randomUUID(), enabled: true, url: '', action: 'trash', afterMinutes: 60 }])}>
          + Agregar regla
        </button>
      </section>

      <section class="card">
        <h2>Sitios excluidos</h2>
        <p class="muted">
          La automatización nunca cierra estos sitios. Uno por línea. <code>docs.google.com</code> incluye sus subdominios;{' '}
          <code>*.zoom.us</code> incluye zoom.us y todos sus subdominios.
        </p>
        <textarea rows={8} class="mono" value={exclText} aria-label="Sitios excluidos" onInput={(e) => setExclText(e.currentTarget.value)} />
        {badExcl.length > 0 && <small class="error-text">No parecen nombres de sitio válidos: {badExcl.join(', ')}</small>}
      </section>

      <section class="card">
        <h2>Papelera y eliminación definitiva</h2>
        <NumberField
          label="Eliminar definitivamente lo que lleva en la papelera más de"
          hint="Es la única política de borrado definitivo: archivar nunca borra. 0 = nunca se elimina sola."
          unit="días"
          value={draft.trashRetentionDays}
          min={0}
          max={3650}
          onChange={(v) => set('trashRetentionDays', v)}
        />
        <NumberField label="Conservar el registro de acciones" unit="días" value={draft.logRetentionDays} min={1} max={3650} onChange={(v) => set('logRetentionDays', v)} />
      </section>

      <section class="card">
        <h2>Reapertura</h2>
        <NumberField label="Pestañas que se abren a la vez" hint="Al reabrir muchas, se cargan de a estas por vez." value={draft.reopenConcurrency} min={1} max={10} onChange={(v) => set('reopenConcurrency', v)} />
        <div class="stack">
          <Switch checked={draft.discardAfterBulkReopen} onChange={(v) => set('discardAfterBulkReopen', v)} label="Descargar de memoria las pestañas reabiertas en masa" hint="Quedan visibles pero no consumen memoria hasta que las mirás." />
          <Switch checked={draft.restoreGroups} onChange={(v) => set('restoreGroups', v)} label="Restaurar grupos de pestañas" hint="Vuelve a agrupar con el título y color originales." />
        </div>
      </section>

      <section class="card">
        <h2>Actualizaciones</h2>
        <div class="row wrap">
          <Switch checked={draft.updateCheck} onChange={(v) => set('updateCheck', v)} label="Buscar versiones nuevas una vez por día" hint="Consulta la página de releases en GitHub. No envía ningún dato tuyo." />
          <span class="spacer" />
          <button
            type="button"
            class="btn btn-sm"
            onClick={async () => {
              try {
                const u = await send({ type: 'checkUpdate' });
                toast(u ? `Hay una versión nueva: ${u.latest}` : 'Estás usando la última versión.', { kind: 'info' });
              } catch (e) {
                toast(`No se pudo consultar: ${errMsg(e)}`, { kind: 'error' });
              }
            }}
          >
            Buscar ahora
          </button>
        </div>
      </section>

      <div class={`savebar${dirty ? ' is-dirty' : ''}`}>
        <span class="muted">{dirty ? 'Tenés cambios sin guardar.' : 'Sin cambios.'}</span>
        <span class="spacer" />
        <button type="button" class="btn" disabled={!dirty || saving} onClick={() => adopt(saved)}>
          Descartar
        </button>
        <button type="button" class="btn btn-primary" disabled={!dirty || saving || ruleErrors.size > 0 || badExcl.length > 0} onClick={() => void save()}>
          {saving ? 'Guardando…' : 'Guardar'}
        </button>
      </div>

      <section class="card">
        <h2>Previsualización</h2>
        <p class="muted">Muestra qué haría la automatización ahora mismo con las pestañas abiertas, sin tocar nada.</p>
        <div class="row">
          <button type="button" class="btn" disabled={previewing} onClick={() => void doPreview()}>
            {previewing ? 'Calculando…' : 'Previsualizar'}
          </button>
          <button type="button" class="btn btn-primary" disabled={running || previewing} onClick={() => void runNow()}>
            {running ? 'Ejecutando…' : 'Ejecutar ahora'}
          </button>
        </div>
        {preview && (
          <div style={{ marginTop: '12px' }}>
            <PreviewTable preview={preview} />
          </div>
        )}
      </section>
    </div>
  );
}

// Dashboard entry: header (counts, automation, banners) + hash-routed views.

import '../common/base.css';
import './dashboard.css';
import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { send } from '../common/api';
import { confirmDialog, DialogHost, ToastHost } from '../common/feedback';
import { fmtNum, fmtRelative } from '../common/format';
import { useStore } from '../common/store';
import { Spinner } from '../common/widgets';
import { initData, statusStore } from './data';
import { BackupView, ExportJsonButton } from './views/BackupView';
import { DuplicatesView } from './views/DuplicatesView';
import { ImportView } from './views/ImportView';
import { ListView } from './views/ListView';
import { LogView } from './views/LogView';
import { RulesView } from './views/RulesView';

const ROUTES = {
  lista: 'Lista',
  importar: 'Importar',
  duplicados: 'Duplicados',
  reglas: 'Reglas',
  registro: 'Registro',
  copias: 'Copias',
} as const;
type Route = keyof typeof ROUTES;

const BACKUP_REMINDER_MS = 7 * 24 * 60 * 60 * 1000;
const DISMISS_KEY = 'fangio.backupReminderDismissed';

function parseRoute(): Route {
  const r = location.hash.replace(/^#\/?/, '').split(/[?/]/)[0] ?? '';
  return (r in ROUTES ? r : 'lista') as Route;
}

function useRoute(): Route {
  const [route, setRoute] = useState<Route>(parseRoute);
  useEffect(() => {
    const on = () => setRoute(parseRoute());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

function UpdateBanner() {
  const status = useStore(statusStore);
  const u = status?.update;
  if (!u) return null;
  return (
    <div class="banner notice notice-info" role="status">
      <div class="grow">
        <strong>Hay una versión nueva de Fangio: {u.latest}</strong> <span class="muted">(tenés {status.version})</span>.{' '}
        <a href={u.url} target="_blank" rel="noopener noreferrer">
          Ver novedades
        </a>
        <br />
        Para actualizar, ejecutá <code>update.ps1</code> (está en la carpeta de la extensión) y después tocá «Recargar
        extensión». Tus datos no se borran al recargar.
      </div>
      <button
        type="button"
        class="btn"
        onClick={async () => {
          const ok = await confirmDialog({
            title: 'Recargar la extensión',
            body: <p>Esta pestaña del panel se va a cerrar y Fangio se reinicia con la versión nueva. Tus datos se conservan.</p>,
            confirmLabel: 'Recargar extensión',
          });
          if (ok) send({ type: 'reloadExtension' }).catch(() => {});
        }}
      >
        Recargar extensión
      </button>
    </div>
  );
}

function BackupReminder() {
  const status = useStore(statusStore);
  const [dismissed, setDismissed] = useState(() => {
    try {
      return sessionStorage.getItem(DISMISS_KEY) === '1';
    } catch {
      return false;
    }
  });
  if (!status || dismissed) return null;
  const last = status.lastBackupAt;
  if (last && Date.now() - last < BACKUP_REMINDER_MS) return null;
  if (!status.counts.total) return null;
  return (
    <div class="banner notice notice-warn" role="status">
      <div class="grow">
        {last ? `Tu última copia de seguridad es de ${fmtRelative(last)}.` : 'Todavía no exportaste ninguna copia de seguridad.'}{' '}
        Si quitás la extensión se pierden los datos: exportá una copia y guardala fuera del navegador.
      </div>
      <ExportJsonButton primary={false} />
      <button
        type="button"
        class="icon-btn"
        aria-label="Ocultar recordatorio por ahora"
        onClick={() => {
          setDismissed(true);
          try {
            sessionStorage.setItem(DISMISS_KEY, '1');
          } catch {
            // ignore
          }
        }}
      >
        ×
      </button>
    </div>
  );
}

function Header({ route }: { route: Route }) {
  const status = useStore(statusStore);
  const c = status?.counts;
  return (
    <header class="topbar">
      <a class="brand" href="#/lista">
        Fangio
      </a>
      <nav class="nav" aria-label="Secciones">
        {(Object.keys(ROUTES) as Route[]).map((r) => (
          <a href={`#/${r}`} class={`nav-link${route === r ? ' is-on' : ''}`} aria-current={route === r ? 'page' : undefined}>
            {ROUTES[r]}
          </a>
        ))}
      </nav>
      <span class="spacer" />
      {status && status.runningOps > 0 && <Spinner label="Operación en curso…" />}
      {c && (
        <span class="counts" aria-label="Contadores">
          <span>
            <strong>{fmtNum(c.open)}</strong> abiertas
          </span>
          <span>
            <strong>{fmtNum(c.archived)}</strong> archivadas
          </span>
          <span>
            <strong>{fmtNum(c.trash)}</strong> papelera
          </span>
          <span>
            <strong>{fmtNum(c.pending)}</strong> pendientes
          </span>
        </span>
      )}
      {status && (
        <a
          href="#/reglas"
          class={`auto-ind${status.automationEnabled ? ' is-on' : ''}`}
          title={status.lastAutoRunSummary ? `Última revisión: ${status.lastAutoRunSummary}` : undefined}
        >
          <span class="dot" aria-hidden="true" />
          Automatización {status.automationEnabled ? 'activada' : 'desactivada'}
          {status.automationEnabled && status.lastAutoRunAt ? <span class="faint"> · {fmtRelative(status.lastAutoRunAt)}</span> : null}
        </a>
      )}
    </header>
  );
}

function App() {
  const route = useRoute();
  const status = useStore(statusStore);
  const initialHashEmpty = useRef(!location.hash || location.hash === '#' || location.hash === '#/');
  const redirected = useRef(false);

  useEffect(() => {
    if (status && !redirected.current) {
      redirected.current = true;
      if (!status.onboardingDone && initialHashEmpty.current) location.hash = '#/importar';
    }
  }, [status]);

  useEffect(() => {
    document.title = `${ROUTES[route]} · Fangio`;
  }, [route]);

  return (
    <div class={`app route-${route}`}>
      <Header route={route} />
      <UpdateBanner />
      {route !== 'copias' && <BackupReminder />}
      <main class="main">
        {route === 'lista' && <ListView />}
        {route === 'importar' && <ImportView />}
        {route === 'duplicados' && <DuplicatesView />}
        {route === 'reglas' && <RulesView />}
        {route === 'registro' && <LogView />}
        {route === 'copias' && <BackupView />}
      </main>
      <ToastHost />
      <DialogHost />
    </div>
  );
}

initData();
const root = document.getElementById('app');
if (root) render(<App />, root);

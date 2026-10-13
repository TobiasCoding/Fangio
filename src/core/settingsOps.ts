// Settings mutations performed by the background (logged, broadcast).

import { sanitizeSettings } from '../shared/settings';
import type { Settings } from '../shared/types';
import { getSettings, putAction, putSettings } from './db';
import { dbLock } from './mutex';
import { newAction } from './records';
import { broadcast } from './runtime';

const LABELS: Partial<Record<keyof Settings, string>> = {
  automationEnabled: 'automatización',
  targetOpenTabs: 'objetivo de pestañas',
  idleArchiveHours: 'inactividad',
  targetMinIdleMinutes: 'tiempo mínimo para el objetivo',
  audioGraceMinutes: 'gracia de audio',
  checkIntervalMinutes: 'intervalo de revisión',
  maxAutoClosePerRun: 'tope por ejecución',
  siteExclusions: 'sitios excluidos',
  urlRules: 'reglas de URL',
  trashRetentionDays: 'retención de la papelera',
  reopenConcurrency: 'reaperturas simultáneas',
  discardAfterBulkReopen: 'descartar tras reabrir',
  restoreGroups: 'restaurar grupos',
  dedupeArchived: 'duplicados archivados',
  updateCheck: 'buscar actualizaciones',
  logRetentionDays: 'retención del registro',
};

export async function saveSettings(input: unknown): Promise<Settings> {
  const next = sanitizeSettings(input);
  const saved = await dbLock.run(async () => {
    const prev = await getSettings();
    // Fields owned by the background are not overwritten by a stale UI copy.
    if (prev.lastBackupAt !== undefined && (next.lastBackupAt ?? 0) < prev.lastBackupAt) next.lastBackupAt = prev.lastBackupAt;
    const out = await putSettings(next);
    const changed = (Object.keys(LABELS) as (keyof Settings)[]).filter(
      (k) => JSON.stringify(prev[k]) !== JSON.stringify(out[k]),
    );
    if (changed.length > 0) {
      await putAction(
        newAction('settings', {
          reason: `Configuración: ${changed.map((k) => LABELS[k]).join(', ')}`,
          undoable: false,
        }),
      );
    }
    return out;
  });
  broadcast({ type: 'settings' });
  broadcast({ type: 'actions' });
  broadcast({ type: 'status' });
  return saved;
}

async function patchSettings(patch: Partial<Settings>): Promise<Settings> {
  const out = await dbLock.run(async () => putSettings({ ...(await getSettings()), ...patch }));
  broadcast({ type: 'settings' });
  broadcast({ type: 'status' });
  return out;
}

export function markOnboardingDone(): Promise<Settings> {
  return patchSettings({ onboardingDone: true });
}

export function markBackup(at = Date.now()): Promise<Settings> {
  return patchSettings({ lastBackupAt: at });
}

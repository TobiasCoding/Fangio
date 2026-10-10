// Automation: evaluate rules (pure) and run the decisions through the close
// pipeline in 'auto' mode (every protection re-checked right before closing).

import { STARTUP_GRACE_MS } from '../shared/constants';
import type { BulkResult } from '../shared/messages';
import type { RuleDecision, RulePreview } from '../shared/types';
import { runCloseOp } from './closeOp';
import { getRecordsByState, getSettings, setKv } from './db';
import { evaluateRules, requiredIdleFor, ruleLabel } from './rules';
import { broadcast, busySet } from './runtime';
import { getSession } from './session';
import { flushNow, queryAllTabs } from './tracker';

export interface LastAutoRun {
  at: number;
  trigger: 'alarm' | 'manual';
  summary: string;
  closed: number;
  skipped: number;
  failed: number;
}

let running = false;

export async function previewRules(): Promise<RulePreview> {
  await flushNow();
  const [session, settings, tabs, open] = await Promise.all([getSession(), getSettings(), queryAllTabs(), getRecordsByState('open')]);
  return evaluateRules({
    tabs,
    records: open,
    settings,
    now: Date.now(),
    sessionId: session.sessionId,
    busyRecordIds: busySet(),
    extensionId: chrome.runtime?.id,
  });
}

function groupReason(ds: RuleDecision[], settings: Awaited<ReturnType<typeof getSettings>>): string {
  if (ds.length === 1) return ds[0]!.reason;
  const d = ds[0]!;
  const verb = d.action === 'trash' ? 'Enviadas a la papelera automáticamente' : 'Archivadas automáticamente';
  if (d.ruleId === 'idle') return `${verb}: ${ds.length} pestañas sin consultar (inactividad > ${settings.idleArchiveHours} h)`;
  if (d.ruleId === 'target') return `${verb}: ${ds.length} pestañas (objetivo de ${settings.targetOpenTabs} pestañas abiertas)`;
  const rule = settings.urlRules.find((r) => r.id === d.ruleId);
  return `${verb}: ${ds.length} pestañas (regla «${rule ? ruleLabel(rule) : d.ruleId}»)`;
}

export async function runAutomation(trigger: 'alarm' | 'manual'): Promise<BulkResult> {
  const empty: BulkResult = { ok: true, done: [], skipped: [], failed: [] };
  if (running) return { ...empty, ok: false, skipped: [{ reason: 'Ya hay una ejecución automática en curso' }] };
  running = true;
  try {
    const settings = await getSettings();
    if (trigger === 'alarm' && !settings.automationEnabled) return empty;
    const session = await getSession();
    const now = Date.now();
    if (trigger === 'alarm' && now - session.startupAt < STARTUP_GRACE_MS) return empty;
    const preview = await previewRules();
    const groups = new Map<string, RuleDecision[]>();
    for (const d of preview.decisions) {
      if (d.action === 'keep') continue;
      const key = `${d.action}|${d.ruleId ?? ''}`;
      const list = groups.get(key);
      if (list) list.push(d);
      else groups.set(key, [d]);
    }
    const res: BulkResult = { ok: true, done: [], skipped: [], failed: [] };
    let archived = 0;
    let trashed = 0;
    let stopped = false;
    for (const ds of groups.values()) {
      const first = ds[0]!;
      // The user may switch automation off while a long alarm run is in progress.
      if (trigger === 'alarm' && !(await getSettings()).automationEnabled) {
        stopped = true;
        break;
      }
      const r = await runCloseOp({
        // expectedUrl ties each decision to the URL it was evaluated for.
        items: ds.map((d) => ({ recordId: d.recordId, reason: d.reason, minIdleMinutes: requiredIdleFor(d, settings), expectedUrl: d.url })),
        targetState: first.action === 'trash' ? 'trash' : 'archived',
        mode: 'auto',
        reason: groupReason(ds, settings),
        ...(first.ruleId ? { ruleId: first.ruleId } : {}),
      });
      res.done.push(...r.done);
      res.skipped.push(...r.skipped);
      res.failed.push(...r.failed);
      if (r.actionId) res.actionId = r.actionId;
      if (first.action === 'trash') trashed += r.done.length;
      else archived += r.done.length;
    }
    res.ok = res.failed.length === 0;
    const closed = archived + trashed;
    const summary =
      closed === 0 && res.skipped.length === 0
        ? `Sin cambios: ${preview.openCount} abiertas (objetivo ${preview.target})`
        : `${closed} cerradas (${archived} archivadas, ${trashed} a la papelera)` +
          (res.skipped.length ? `, ${res.skipped.length} omitidas` : '') +
          (res.failed.length ? `, ${res.failed.length} con error` : '') +
          (preview.capped ? `; tope de ${settings.maxAutoClosePerRun} por ejecución alcanzado` : '') +
          (stopped ? '; detenida: la automatización se desactivó durante la ejecución' : '');
    const last: LastAutoRun = { at: Date.now(), trigger, summary, closed, skipped: res.skipped.length, failed: res.failed.length };
    await setKv('lastAutoRun', last);
    broadcast({ type: 'status' });
    return res;
  } finally {
    running = false;
  }
}

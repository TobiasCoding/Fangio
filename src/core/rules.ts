// Pure rules engine. evaluateRules() is what the automation alarm executes and
// exactly what the UI previews. blockReasons() is shared with the import
// preview and with the revalidation step of the close pipeline.

import type { BlockReason, RuleDecision, RulePreview, Settings, TabRecord, UrlRule } from '../shared/types';
import { formatAgo, idleMinutesOf } from './records';
import { canonicalUrl, isExtensionPage, isTrackableUrl, matchesSiteExclusion, tabUrl } from './url';

export type RuleMode = 'auto' | 'manual' | 'import';

export const BLOCK_LABELS: Record<BlockReason, string> = {
  protected: 'protegida',
  pinned: 'fijada',
  active: 'activa',
  highlighted: 'seleccionada',
  audible: 'reproduciendo audio',
  'recent-audio': 'con audio reciente',
  'site-excluded': 'sitio excluido',
  incognito: 'incógnito',
  'extension-page': 'página de Fangio',
  'untrackable-url': 'URL no rastreable',
  'recently-viewed': 'vista recientemente',
  'pending-operation': 'operación en curso',
};

export function describeBlocks(blocks: readonly BlockReason[]): string {
  return blocks.map((b) => BLOCK_LABELS[b]).join(', ');
}

export interface BlockOptions {
  /** Own extension id (chrome.runtime.id) to recognize our pages. */
  extensionId?: string | undefined;
  /** Record is touched by a running operation. */
  busy?: boolean;
  /** pendingClose of this op does not count as "pending-operation" (revalidation of our own op). */
  ignoreOpId?: string;
}

/**
 * Why a tab must not be closed.
 *  - auto / import: every protection (protected, pinned, active, highlighted, audible,
 *    recent audio, site exclusion, incognito, own pages, untrackable URL, running op).
 *  - manual: only what makes closing unsafe or meaningless (protected, incognito,
 *    own pages, untrackable URL, running op). The caller decides about force.
 */
export function blockReasons(
  tab: chrome.tabs.Tab | undefined,
  record: TabRecord | undefined,
  settings: Settings,
  now: number,
  mode: RuleMode,
  opts: BlockOptions = {},
): BlockReason[] {
  const out: BlockReason[] = [];
  const url = tabUrl(tab) || record?.url || '';
  if (record?.protected) out.push('protected');
  if (tab?.incognito) out.push('incognito');
  if (isExtensionPage(url, opts.extensionId)) out.push('extension-page');
  else if (!isTrackableUrl(url)) out.push('untrackable-url');
  if (opts.busy || (record?.pendingClose && record.pendingClose.opId !== opts.ignoreOpId)) out.push('pending-operation');
  if (mode === 'manual') return out;
  if (tab?.pinned) out.push('pinned');
  if (tab?.active) out.push('active');
  else if (tab?.highlighted) out.push('highlighted');
  if (tab?.audible) out.push('audible');
  else if (
    record?.lastAudibleAt !== undefined &&
    settings.audioGraceMinutes > 0 &&
    now - record.lastAudibleAt < settings.audioGraceMinutes * 60000
  )
    out.push('recent-audio');
  if (url && matchesSiteExclusion(url, settings.siteExclusions)) out.push('site-excluded');
  return out;
}

/** First enabled exact-URL rule whose canonical URL equals the tab's canonical URL. */
export function matchUrlRule(url: string, rules: readonly UrlRule[]): UrlRule | undefined {
  const c = canonicalUrl(url);
  if (!c) return undefined;
  return rules.find((r) => r.enabled && canonicalUrl(r.url) === c);
}

export function ruleLabel(r: UrlRule): string {
  return r.label ? r.label : r.url;
}

export interface RuleInput {
  tabs: readonly chrome.tabs.Tab[];
  records: readonly TabRecord[];
  settings: Settings;
  now: number;
  sessionId: string;
  busyRecordIds?: ReadonlySet<string>;
  extensionId?: string | undefined;
}

/** Minimum idle minutes a decision relied on (re-checked right before closing). */
export function requiredIdleFor(d: Pick<RuleDecision, 'ruleId'>, settings: Settings): number {
  if (d.ruleId === 'idle') return settings.idleArchiveHours * 60;
  if (d.ruleId === 'target') return settings.targetMinIdleMinutes;
  const r = settings.urlRules.find((x) => x.id === d.ruleId);
  return r ? r.afterMinutes : 0;
}

export function evaluateRules(input: RuleInput): RulePreview {
  const { settings, now, sessionId } = input;
  const byTab = new Map<number, TabRecord>();
  for (const r of input.records) {
    if (r.state === 'open' && r.live && r.live.sessionId === sessionId && !byTab.has(r.live.tabId)) byTab.set(r.live.tabId, r);
  }
  const tabs = input.tabs.filter((t) => !t.incognito && typeof t.id === 'number');
  const openCount = tabs.filter((t) => isTrackableUrl(tabUrl(t))).length;

  const decisions: RuleDecision[] = [];
  const undecided: RuleDecision[] = [];
  for (const tab of tabs) {
    const rec = byTab.get(tab.id!);
    if (!rec) continue;
    const url = tabUrl(tab) || rec.url;
    const idle = idleMinutesOf(rec, tab, now);
    const base = { recordId: rec.id, tabId: tab.id!, url, title: tab.title || rec.title, idleMinutes: Math.floor(idle) };
    const blocks = blockReasons(tab, rec, settings, now, 'auto', {
      extensionId: input.extensionId,
      busy: input.busyRecordIds?.has(rec.id) ?? false,
    });
    if (blocks.length > 0) {
      decisions.push({ ...base, action: 'keep', reason: `Se mantiene: ${describeBlocks(blocks)}`, blockedBy: blocks });
      continue;
    }
    const rule = matchUrlRule(url, settings.urlRules);
    if (rule && idle >= rule.afterMinutes) {
      const verb = rule.action === 'trash' ? 'Enviada a la papelera automáticamente' : 'Archivada automáticamente';
      decisions.push({
        ...base,
        action: rule.action,
        ruleId: rule.id,
        reason: `${verb}: sin consultar hace ${formatAgo(idle)} (regla «${ruleLabel(rule)}»)`,
      });
      continue;
    }
    if (settings.idleArchiveHours > 0 && idle >= settings.idleArchiveHours * 60) {
      decisions.push({
        ...base,
        action: 'archive',
        ruleId: 'idle',
        reason: `Archivada automáticamente: sin consultar hace ${formatAgo(idle)} (inactividad > ${settings.idleArchiveHours} h)`,
      });
      continue;
    }
    const d: RuleDecision = { ...base, action: 'keep', reason: 'Se mantiene: ninguna regla aplica' };
    decisions.push(d);
    undecided.push(d);
  }

  // Target: archive the least recently viewed until the target is met.
  let remaining = openCount - decisions.filter((d) => d.action !== 'keep').length;
  if (remaining > settings.targetOpenTabs) {
    undecided.sort((a, b) => b.idleMinutes - a.idleMinutes);
    for (const d of undecided) {
      if (remaining <= settings.targetOpenTabs) break;
      if (d.idleMinutes >= settings.targetMinIdleMinutes) {
        d.action = 'archive';
        d.ruleId = 'target';
        d.reason = `Archivada automáticamente: sin consultar hace ${formatAgo(d.idleMinutes)} (objetivo de ${settings.targetOpenTabs} pestañas abiertas)`;
        remaining--;
      } else {
        d.blockedBy = ['recently-viewed'];
        d.reason = `Se mantiene: vista hace ${formatAgo(d.idleMinutes)} (se supera el objetivo, pero se vio hace menos de ${formatAgo(settings.targetMinIdleMinutes)})`;
      }
    }
  }

  // Safety cap: the most idle first.
  let capped = false;
  const acting = decisions.filter((d) => d.action !== 'keep').sort((a, b) => b.idleMinutes - a.idleMinutes);
  if (acting.length > settings.maxAutoClosePerRun) {
    capped = true;
    for (const d of acting.slice(settings.maxAutoClosePerRun)) {
      d.action = 'keep';
      d.reason = `Se mantiene por ahora: tope de ${settings.maxAutoClosePerRun} cierres por ejecución`;
      delete d.ruleId;
    }
  }
  const actions = decisions.filter((d) => d.action !== 'keep').sort((a, b) => b.idleMinutes - a.idleMinutes);
  const keeps = decisions.filter((d) => d.action === 'keep');
  return {
    at: now,
    openCount,
    target: settings.targetOpenTabs,
    projectedOpenCount: openCount - actions.length,
    decisions: [...actions, ...keeps],
    capped,
  };
}

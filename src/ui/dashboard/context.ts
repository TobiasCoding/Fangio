// UI side of the contextual grouping: builds engine input from records, runs the
// engine in a worker (inline fallback), and keeps per-browser preferences
// (dismissed suggestions, custom names) in localStorage.

import { useEffect, useRef, useState } from 'preact/hooks';
import type { TabRecord } from '../../shared/types';
import { analyzeContext, type ContextDoc, type ContextResult, type Suggestion } from '../../core/context/engine';

/** Analysis input is capped to the most recently used references. */
export const MAX_CONTEXT_DOCS = 8000;

/** Real activity instants only: bulk timestamps (install snapshot, bulk archive/reopen) would fake co-occurrence. */
export function docOf(r: TabRecord): ContextDoc {
  const times = [r.openedAt, r.lastAccessedAt, r.source === 'tracked' ? r.createdAt : undefined].filter(
    (t): t is number => typeof t === 'number' && Number.isFinite(t),
  );
  const d: ContextDoc = { id: r.id, url: r.url, title: r.title, domain: r.domain, times: [...new Set(times)] };
  if (r.openerId) d.openerId = r.openerId;
  if (r.origin.groupTitle) d.groupTitle = r.origin.groupTitle;
  if (r.project) d.project = r.project;
  return d;
}

function lastActivity(r: TabRecord): number {
  return r.lastAccessedAt ?? r.openedAt ?? r.createdAt;
}

/** Content signature: re-analysis only when what the engine reads changes (not on every last-access bump). */
function signature(list: readonly TabRecord[]): string {
  let h = 0x811c9dc5;
  const mix = (s: string) => {
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
  };
  for (const r of list) mix(`${r.id}\u0001${r.url}\u0001${r.title}\u0001${r.project}\u0001${r.openerId ?? ''}\u0002`);
  return `${list.length}:${h >>> 0}`;
}

let worker: Worker | null = null;
let workerBroken = false;
let jobSeq = 0;
const waiting = new Map<number, { resolve: (r: ContextResult) => void; reject: (e: Error) => void }>();

function getWorker(): Worker | null {
  if (workerBroken) return null;
  if (worker) return worker;
  try {
    worker = new Worker(chrome.runtime.getURL('context-worker.js'), { type: 'module' });
    worker.onmessage = (e: MessageEvent<{ id: number; ok: boolean; result?: ContextResult; error?: string }>) => {
      const w = waiting.get(e.data.id);
      if (!w) return;
      waiting.delete(e.data.id);
      if (e.data.ok && e.data.result) w.resolve(e.data.result);
      else w.reject(new Error(e.data.error ?? 'Error en el análisis'));
    };
    worker.onerror = () => {
      workerBroken = true;
      worker?.terminate();
      worker = null;
      for (const w of waiting.values()) w.reject(new Error('worker'));
      waiting.clear();
    };
    return worker;
  } catch {
    workerBroken = true;
    return null;
  }
}

export async function runAnalysis(records: readonly TabRecord[]): Promise<ContextResult> {
  const recent = records.length > MAX_CONTEXT_DOCS ? [...records].sort((a, b) => lastActivity(b) - lastActivity(a)).slice(0, MAX_CONTEXT_DOCS) : records;
  const docs = recent.map(docOf);
  const w = getWorker();
  if (w) {
    try {
      return await new Promise<ContextResult>((resolve, reject) => {
        const id = ++jobSeq;
        waiting.set(id, { resolve, reject });
        w.postMessage({ id, docs, opts: { now: Date.now() } });
      });
    } catch {
      // fall through to inline
    }
  }
  return analyzeContext(docs, { now: Date.now() });
}

/** Runs the analysis when the content of `records` changes (debounced); `refresh` forces it. */
export function useContextAnalysis(records: readonly TabRecord[]) {
  const [result, setResult] = useState<ContextResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [force, setForce] = useState(0);
  const sig = signature(records);
  const latest = useRef(records);
  latest.current = records;
  useEffect(() => {
    let cancelled = false;
    setRunning(true);
    const h = setTimeout(() => {
      runAnalysis(latest.current)
        .then((r) => {
          if (!cancelled) {
            setResult(r);
            setError(null);
          }
        })
        .catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)))
        .finally(() => !cancelled && setRunning(false));
    }, result ? 600 : 50);
    return () => {
      cancelled = true;
      clearTimeout(h);
    };
  }, [sig, force]);
  return { result, running, error, refresh: () => setForce((x) => x + 1) };
}

// ------------------------------------------------------------------ preferences (this browser only)

const DISMISSED_KEY = 'fangio.topics.dismissed';
const NAMES_KEY = 'fangio.topics.names';
const MAX_DISMISSED = 300;
const MAX_NAMES = 500;

function readJson<T>(key: string, fallback: T): T {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? 'null') as T | null;
    return v ?? fallback;
  } catch {
    return fallback;
  }
}
function writeJson(key: string, v: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    // storage full / blocked: preferences are a convenience
  }
}

export function jaccard(a: readonly string[], b: readonly string[]): number {
  const sa = new Set(a);
  let inter = 0;
  for (const x of b) if (sa.has(x)) inter++;
  const union = sa.size + b.length - inter;
  return union ? inter / union : 0;
}

export function loadDismissed(): string[][] {
  const v = readJson<unknown>(DISMISSED_KEY, []);
  return Array.isArray(v) ? v.filter((x): x is string[] => Array.isArray(x) && x.every((y) => typeof y === 'string')) : [];
}

/** A suggestion stays hidden while it is mostly the same set the user dismissed. */
export function isDismissed(s: Suggestion, dismissed: readonly string[][]): boolean {
  return dismissed.some((d) => jaccard(d, s.ids) >= 0.6);
}

export function dismiss(s: Suggestion): string[][] {
  const next = [[...s.ids].sort(), ...loadDismissed()].slice(0, MAX_DISMISSED);
  writeJson(DISMISSED_KEY, next);
  return next;
}

export function undismiss(ids: readonly string[]): string[][] {
  const sig = [...ids].sort().join('|');
  const next = loadDismissed().filter((d) => d.join('|') !== sig);
  writeJson(DISMISSED_KEY, next);
  return next;
}

export function clearDismissed(): void {
  writeJson(DISMISSED_KEY, []);
}

export function loadNames(): Record<string, string> {
  const v = readJson<unknown>(NAMES_KEY, {});
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, string>) : {};
}

export function saveName(key: string, name: string): Record<string, string> {
  const cur = loadNames();
  delete cur[key];
  const next: Record<string, string> = { [key]: name.trim().slice(0, 80) };
  for (const [k, v] of Object.entries(cur).slice(0, MAX_NAMES - 1)) next[k] = v;
  writeJson(NAMES_KEY, next);
  return next;
}

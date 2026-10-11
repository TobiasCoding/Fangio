// Dedicated worker: runs the contextual grouping engine off the UI thread.
import { analyzeContext, type ContextDoc, type ContextOptions } from '../../core/context/engine';

interface Job {
  id: number;
  docs: ContextDoc[];
  opts?: ContextOptions;
}

self.onmessage = (e: MessageEvent<Job>) => {
  const { id, docs, opts } = e.data;
  try {
    self.postMessage({ id, ok: true, result: analyzeContext(docs, opts) });
  } catch (err) {
    self.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};

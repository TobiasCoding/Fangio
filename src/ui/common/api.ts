// Typed bridge between UI pages and the background service worker.
// Reads go straight to IndexedDB (see core/db.ts); every mutation goes through send().

import { CHANGES_CHANNEL } from '../../shared/messages';
import type { ChangeEvent, Envelope, Request, RequestOf, ResponseMap } from '../../shared/messages';

/**
 * Sends a request to the background and unwraps the Envelope.
 * Throws Error(message) when the background answers ok:false, when there is no
 * answer, or when the runtime reports an error (e.g. worker not reachable).
 * (`& { type: K }` gives TypeScript an inference site for K.)
 */
export async function send<K extends Request['type']>(req: RequestOf<K> & { type: K }): Promise<ResponseMap[K]> {
  let env: Envelope<ResponseMap[K]> | undefined;
  try {
    env = (await chrome.runtime.sendMessage(req)) as Envelope<ResponseMap[K]> | undefined;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`No se pudo contactar al servicio de fondo: ${msg}`);
  }
  const lastError = chrome.runtime.lastError;
  if (lastError) throw new Error(lastError.message ?? 'Error de comunicación con el servicio de fondo');
  if (!env || typeof env !== 'object') throw new Error('El servicio de fondo no respondió');
  if (!env.ok) throw new Error(env.error || 'Error desconocido');
  return env.data;
}

/** Subscribes to change notifications broadcast by the background. Returns an unsubscribe function. */
export function onChanges(cb: (ev: ChangeEvent) => void): () => void {
  let channel: BroadcastChannel | null = null;
  try {
    channel = new BroadcastChannel(CHANGES_CHANNEL);
  } catch {
    return () => {};
  }
  const handler = (e: MessageEvent) => {
    const data = e.data as ChangeEvent | undefined;
    if (data && typeof data === 'object' && typeof data.type === 'string') cb(data);
  };
  channel.addEventListener('message', handler);
  return () => {
    channel?.removeEventListener('message', handler);
    channel?.close();
    channel = null;
  };
}

/** Error message helper for catch blocks. */
export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

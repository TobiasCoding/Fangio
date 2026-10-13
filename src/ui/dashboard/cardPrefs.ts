// How cards are presented (Tarjetas view). Per-browser UI preference kept in localStorage,
// like the list's sort and view. The default is minimal: no image, no colors.

import { createStore } from '../common/store';

const KEY = 'fangio.cards.prefs';

export interface CardPrefs {
  /** 'thumb': page thumbnail (when captured) inside the card; 'none': text only. */
  image: 'none' | 'thumb';
  size: 'compact' | 'comfortable';
  showDomain: boolean;
  showDate: boolean;
  showUrl: boolean;
  /** Protegida / Pendiente / proyecto / etiquetas. */
  showMarks: boolean;
  showState: boolean;
  /** Site color accent, colored chips and generated posters. */
  colors: boolean;
}

export const DEFAULT_CARD_PREFS: CardPrefs = {
  image: 'none',
  size: 'compact',
  showDomain: true,
  showDate: true,
  showUrl: false,
  showMarks: true,
  showState: false,
  colors: false,
};

/** Repairs a stored value (unknown keys dropped, wrong types -> default). */
export function sanitizeCardPrefs(v: unknown): CardPrefs {
  const d = DEFAULT_CARD_PREFS;
  if (!v || typeof v !== 'object') return { ...d };
  const p = v as Partial<Record<keyof CardPrefs, unknown>>;
  const bool = (x: unknown, def: boolean) => (typeof x === 'boolean' ? x : def);
  return {
    image: p.image === 'thumb' ? 'thumb' : 'none',
    size: p.size === 'comfortable' ? 'comfortable' : 'compact',
    showDomain: bool(p.showDomain, d.showDomain),
    showDate: bool(p.showDate, d.showDate),
    showUrl: bool(p.showUrl, d.showUrl),
    showMarks: bool(p.showMarks, d.showMarks),
    showState: bool(p.showState, d.showState),
    colors: bool(p.colors, d.colors),
  };
}

function load(): CardPrefs {
  try {
    return sanitizeCardPrefs(JSON.parse(localStorage.getItem(KEY) ?? 'null'));
  } catch {
    return { ...DEFAULT_CARD_PREFS };
  }
}

export const cardPrefsStore = createStore<CardPrefs>(load());

export function setCardPrefs(patch: Partial<CardPrefs>): void {
  const next = { ...cardPrefsStore.get(), ...patch };
  cardPrefsStore.set(next);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // ignore
  }
}

// Fixed pixel metrics: the grid is virtualized, so every card of a row has the same height.
const PAD_Y = 20;
const HEAD_H = 18;
const GAP = 6;
export const TITLE_LINE_H = 18;
const URL_H = 16;
const FOOT_H = 20;

export interface CardMetrics {
  minWidth: number;
  height: number;
  titleLines: number;
  thumbHeight: number;
}

export function cardMetrics(p: CardPrefs): CardMetrics {
  const roomy = p.size === 'comfortable';
  const titleLines = roomy ? 3 : 2;
  const thumbHeight = p.image === 'thumb' ? (roomy ? 128 : 92) : 0;
  let height = PAD_Y + HEAD_H + GAP + titleLines * TITLE_LINE_H;
  if (p.showUrl) height += GAP + URL_H;
  if (p.showMarks || p.showDate) height += GAP + FOOT_H;
  if (thumbHeight) height += thumbHeight + GAP + 2;
  return { minWidth: roomy ? 260 : 210, height, titleLines, thumbHeight };
}

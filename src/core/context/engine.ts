// Contextual grouping engine. Suggests groups of related references by combining:
//   1. lexical similarity (TF-IDF cosine over cleaned titles, the query typed in
//      search engines and readable URL words), with per-site boilerplate learned
//      from the data itself;
//   2. temporal proximity (two-scale exponential kernel: same work session / same days),
//      so a term searched on Google, then discussed in ChatGPT and read on a site within
//      minutes binds much harder than the same word weeks apart;
//   3. structure: opener tab (link followed from another tab), same Chrome tab group,
//      same user project.
// The weighted graph is partitioned with Louvain modularity; each community is
// labeled with class-based TF-IDF (terms distinctive of the group vs. the rest).
// Background: task extraction from query logs (Jones & Klinkner 2008; Lucchese et
// al. 2011) mixes lexical and temporal features; Tabs.do (Chang et al. 2021) groups
// tabs into tasks from behavioral + semantic signals; Firefox's smart tab groups
// (2025) use local embeddings + c-TF-IDF labels and list time as future work.
// Pure and deterministic: no chrome.*, no DOM, same input -> same output.

import { louvain, type Edge } from './louvain';
import { domainLabels, fold, pathWords, searchQueryOf, siteKindOf, stem, titleSegments, tokenize, type SiteKind } from './text';

export interface ContextDoc {
  id: string;
  url: string;
  title: string;
  domain: string;
  /** Activity instants (epoch ms) that are real user activity: opened, last viewed. Never bulk timestamps. */
  times: number[];
  /** Record of the tab this one was opened from (link followed). */
  openerId?: string;
  groupTitle?: string;
  project?: string;
}

export interface TrailStep {
  id: string;
  kind: SiteKind;
  at: number;
  /** Search query, chat title or page title. */
  text: string;
  domain: string;
}

export interface Suggestion {
  /** Stable signature of the member set. */
  key: string;
  /** Members in chronological order (unknown times last). */
  ids: string[];
  label: string;
  keywords: string[];
  /** Confidence 0..1 (cohesion vs. links to the outside). */
  score: number;
  start?: number;
  end?: number;
  /** Search -> AI chat -> pages path, chronological (at most TRAIL_MAX steps). */
  trail: TrailStep[];
  kinds: Record<SiteKind, number>;
  domains: { domain: string; count: number }[];
  /** Project already shared by most members: the suggestion extends it. */
  project?: string;
  /** Most connected members (for previews). */
  central: string[];
  /** Strongest shared terms and how many members contain each. */
  evidence: { term: string; count: number }[];
}

export interface ContextOptions {
  /** Smallest group suggested. Default 3. */
  minSize?: number;
  /** Larger communities are split again with a higher resolution. Default 50. */
  maxSize?: number;
  /** Minimum edge weight kept in the graph. Default 0.1. */
  edgeThreshold?: number;
  /** Strongest neighbors kept per node. Default 12. */
  neighbors?: number;
  /** Time scale of a work session (minutes). Default 45. */
  sessionMinutes?: number;
  /** Time scale of "the same days" (days). Default 3. */
  spanDays?: number;
  /** Reference time for recency ranking. Default: latest activity in the input. */
  now?: number;
  /** Include the kept graph edges (by id) in the result (diagnostics/tests). */
  debug?: boolean;
}

export interface ContextResult {
  suggestions: Suggestion[];
  stats: { docs: number; terms: number; edges: number; grouped: number; ms: number };
  graph?: { a: string; b: string; w: number }[];
}

const W_QUERY = 1.3;
const W_TITLE = 1;
const W_BIGRAM = 0.8;
const W_PATH = 0.4;
/** The site's own name in its titles ("React" on react.dev): kept, but weak and never a label. */
const BRAND_FACTOR = 0.3;
/** Terms seen in a single reference cannot link anything; they only dampen the cosine a little. */
const SINGLETON_FACTOR = 0.5;
const TRAIL_MAX = 6;
/** Minimum link weight for a leftover reference to join a neighboring group. */
const ADOPT_MIN = 0.25;
const MAX_POSTING = 400;

interface Feat {
  terms: Map<string, number>;
  /** Terms that are allowed to name a group (title/query, not URL-only words). */
  labelTerms: Set<string>;
  kind: SiteKind;
  query: string;
  text: string;
  times: number[];
  t0: number | undefined;
}

// ------------------------------------------------------------------ features

/** Title segments that repeat across one site's pages ("Stack Overflow", "Mercado Libre") are boilerplate. */
function learnBoilerplate(docs: readonly ContextDoc[]): Map<string, Set<string>> {
  const byDomain = new Map<string, Map<string, number>>();
  const sizes = new Map<string, number>();
  for (const d of docs) {
    sizes.set(d.domain, (sizes.get(d.domain) ?? 0) + 1);
    const seen = new Set(titleSegments(d.title).map(fold));
    let m = byDomain.get(d.domain);
    if (!m) byDomain.set(d.domain, (m = new Map()));
    for (const s of seen) m.set(s, (m.get(s) ?? 0) + 1);
  }
  const out = new Map<string, Set<string>>();
  for (const [domain, counts] of byDomain) {
    const n = sizes.get(domain) ?? 0;
    if (n < 3) continue;
    const bp = new Set<string>();
    for (const [seg, c] of counts) if (c >= 3 && c >= n * 0.5) bp.add(seg);
    if (bp.size) out.set(domain, bp);
  }
  return out;
}

function addTerm(m: Map<string, number>, key: string, w: number): void {
  if ((m.get(key) ?? 0) < w) m.set(key, w);
}

function featuresOf(d: ContextDoc, boiler: ReadonlySet<string> | undefined, surfaces: Map<string, Map<string, number>>): Feat {
  const terms = new Map<string, number>();
  const labelTerms = new Set<string>();
  const brand = new Set(domainLabels(d.domain).flatMap((l) => [l, stem(l)]));
  const isBrand = (k: string) => brand.has(k);
  const note = (key: string, surface: string) => {
    let m = surfaces.get(key);
    if (!m) surfaces.set(key, (m = new Map()));
    m.set(surface, (m.get(surface) ?? 0) + 1);
  };
  const addSeq = (text: string, w: number) => {
    const toks = tokenize(text);
    toks.forEach((t, i) => {
      if (isBrand(t.key)) {
        addTerm(terms, t.key, w * BRAND_FACTOR);
        return;
      }
      addTerm(terms, t.key, w);
      labelTerms.add(t.key);
      note(t.key, t.surface);
      const nx = toks[i + 1];
      if (nx && nx.pos === t.pos + 1 && nx.key !== t.key && !isBrand(nx.key)) {
        const bk = t.key + ' ' + nx.key;
        addTerm(terms, bk, W_BIGRAM * (w / W_TITLE));
        labelTerms.add(bk);
        note(bk, t.surface + ' ' + nx.surface);
      }
    });
  };

  const query = searchQueryOf(d.url);
  const kind = siteKindOf(d.url, d.domain);
  const segs = titleSegments(d.title);
  const kept = boiler ? segs.filter((s) => !boiler.has(fold(s))) : segs;
  const text = (kept.length ? kept : segs).join(' · ') || d.title;
  if (query) addSeq(query, W_QUERY);
  for (const s of kept) addSeq(s, W_TITLE);
  if (kind === 'page' || kind === 'video') {
    for (const t of tokenize(pathWords(d.url))) {
      if (t.key.length < 3 || terms.has(t.key)) continue;
      addTerm(terms, t.key, isBrand(t.key) ? W_PATH * BRAND_FACTOR : W_PATH);
    }
  }
  const times = d.times.filter((t) => Number.isFinite(t) && t > 0);
  return { terms, labelTerms, kind, query, text, times, t0: times.length ? Math.min(...times) : undefined };
}

function minGap(a: readonly number[], b: readonly number[]): number {
  let best = Infinity;
  for (const x of a) for (const y of b) best = Math.min(best, Math.abs(x - y));
  return best;
}

function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

function pairKey(i: number, j: number, n: number): number {
  return i < j ? i * n + j : j * n + i;
}

// ------------------------------------------------------------------ engine

export function analyzeContext(docsIn: readonly ContextDoc[], opts: ContextOptions = {}): ContextResult {
  const started = Date.now();
  const minSize = Math.max(2, opts.minSize ?? 3);
  const maxSize = Math.max(minSize, opts.maxSize ?? 50);
  const threshold = opts.edgeThreshold ?? 0.1;
  const K = opts.neighbors ?? 12;
  const tauS = (opts.sessionMinutes ?? 45) * 60_000;
  const tauD = (opts.spanDays ?? 3) * 86_400_000;

  // Deterministic order: by id.
  const docs = [...docsIn].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const n = docs.length;
  const empty: ContextResult = { suggestions: [], stats: { docs: n, terms: 0, edges: 0, grouped: 0, ms: 0 } };
  if (n < minSize) return empty;

  const boiler = learnBoilerplate(docs);
  const surfaces = new Map<string, Map<string, number>>();
  const feats = docs.map((d) => featuresOf(d, boiler.get(d.domain), surfaces));

  // ---- TF-IDF
  const df = new Map<string, number>();
  for (const f of feats) for (const t of f.terms.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  const maxDf = n >= 30 ? Math.max(3, Math.floor(n * 0.2)) : n;
  const idf = (t: string) => Math.log(1 + n / (df.get(t) ?? 1));
  const vecs: Map<string, number>[] = feats.map((f) => {
    const v = new Map<string, number>();
    let norm = 0;
    for (const [t, w] of f.terms) {
      const d = df.get(t) ?? 0;
      if (d > maxDf) continue;
      const x = w * idf(t) * (d < 2 ? SINGLETON_FACTOR : 1);
      v.set(t, x);
      norm += x * x;
    }
    norm = Math.sqrt(norm) || 1;
    for (const [t, x] of v) v.set(t, x / norm);
    return v;
  });

  // ---- candidate pairs: shared terms (inverted index), opener, group, project
  const postings = new Map<string, number[]>();
  vecs.forEach((v, i) => {
    for (const t of v.keys()) {
      if ((df.get(t) ?? 0) < 2) continue;
      let p = postings.get(t);
      if (!p) postings.set(t, (p = []));
      p.push(i);
    }
  });
  const dot = new Map<number, number>();
  for (const [t, list] of postings) {
    if (list.length > MAX_POSTING) continue;
    for (let a = 0; a < list.length; a++) {
      const i = list[a]!;
      const wi = vecs[i]!.get(t)!;
      for (let b = a + 1; b < list.length; b++) {
        const j = list[b]!;
        const k = pairKey(i, j, n);
        dot.set(k, (dot.get(k) ?? 0) + wi * vecs[j]!.get(t)!);
      }
    }
  }
  const index = new Map(docs.map((d, i) => [d.id, i]));
  const opener = new Set<number>();
  docs.forEach((d, i) => {
    const j = d.openerId !== undefined ? index.get(d.openerId) : undefined;
    if (j !== undefined && j !== i) {
      const k = pairKey(i, j, n);
      opener.add(k);
      if (!dot.has(k)) dot.set(k, 0);
    }
  });
  const sameAttr = (attr: (d: ContextDoc) => string | undefined): Set<number> => {
    const groups = new Map<string, number[]>();
    docs.forEach((d, i) => {
      const v = attr(d)?.trim();
      if (!v) return;
      const g = groups.get(v);
      if (g) g.push(i);
      else groups.set(v, [i]);
    });
    const out = new Set<number>();
    for (const g of groups.values()) {
      if (g.length < 2 || g.length > MAX_POSTING) continue;
      for (let a = 0; a < g.length; a++)
        for (let b = a + 1; b < g.length; b++) {
          const k = pairKey(g[a]!, g[b]!, n);
          out.add(k);
          if (!dot.has(k)) dot.set(k, 0);
        }
    }
    return out;
  };
  const sameGroup = sameAttr((d) => d.groupTitle);
  const sameProject = sameAttr((d) => d.project);

  // ---- weights
  const nbrs: { j: number; w: number }[][] = Array.from({ length: n }, () => []);
  for (const [k, lex] of dot) {
    const i = Math.floor(k / n);
    const j = k % n;
    const gap = minGap(feats[i]!.times, feats[j]!.times);
    const T = Number.isFinite(gap) ? 0.65 * Math.exp(-gap / tauS) + 0.35 * Math.exp(-gap / tauD) : 0;
    let w = lex * (0.45 + 0.55 * T);
    if (opener.has(k)) w += 0.35 * (0.5 + 0.5 * T);
    if (sameGroup.has(k)) w += 0.25;
    if (sameProject.has(k)) w += 0.2;
    if (w < threshold) continue;
    nbrs[i]!.push({ j, w });
    nbrs[j]!.push({ j: i, w });
  }
  // keep the K strongest per node (an edge survives if either end keeps it)
  const kept = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const list = nbrs[i]!.sort((a, b) => b.w - a.w || a.j - b.j).slice(0, K);
    for (const { j, w } of list) kept.set(pairKey(i, j, n), w);
  }
  const edges: Edge[] = [...kept].map(([k, w]) => [Math.floor(k / n), k % n, w] as const);
  const weightOf = (i: number, j: number) => kept.get(pairKey(i, j, n)) ?? 0;
  const adj: number[][] = Array.from({ length: n }, () => []);
  for (const [a, b] of edges) {
    adj[a]!.push(b);
    adj[b]!.push(a);
  }

  // ---- communities (+ split oversized ones with a higher resolution)
  const comm = louvain(n, edges);
  const groups = new Map<number, number[]>();
  comm.forEach((c, i) => {
    const g = groups.get(c);
    if (g) g.push(i);
    else groups.set(c, [i]);
  });
  const split = (members: number[], resolution: number, depth: number): number[][] => {
    if (members.length <= maxSize || depth > 3) return [members];
    const local = new Map(members.map((m, i) => [m, i]));
    const sub: Edge[] = [];
    for (const m of members)
      for (const o of adj[m]!) if (m < o && local.has(o)) sub.push([local.get(m)!, local.get(o)!, weightOf(m, o)]);
    const c = louvain(members.length, sub, { resolution });
    const parts = new Map<number, number[]>();
    c.forEach((x, i) => {
      const p = parts.get(x);
      if (p) p.push(members[i]!);
      else parts.set(x, [members[i]!]);
    });
    if (parts.size <= 1) return [members];
    return [...parts.values()].flatMap((p) => split(p, resolution * 2, depth + 1));
  };
  const parts = [...groups.values()].flatMap((g) => split(g, 2, 1));
  const clusters = parts.filter((g) => g.length >= minSize);
  // Adopt leftovers (too small to stand alone) whose links point mostly into one group.
  const owner = new Map<number, number>();
  clusters.forEach((g, ci) => g.forEach((m) => owner.set(m, ci)));
  for (const g of parts) {
    if (g.length >= minSize) continue;
    for (const m of g) {
      const to = new Map<number, number>();
      let deg = 0;
      for (const o of adj[m]!) {
        const w = weightOf(m, o);
        deg += w;
        const c = owner.get(o);
        if (c !== undefined) to.set(c, (to.get(c) ?? 0) + w);
      }
      const best = [...to].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
      if (best && best[1] >= ADOPT_MIN && best[1] >= deg * 0.6) clusters[best[0]]!.push(m);
    }
  }

  // ---- describe each cluster
  const nowRef = opts.now ?? Math.max(0, ...feats.flatMap((f) => f.times));
  const surfaceOf = (key: string) => {
    const m = surfaces.get(key);
    if (!m) return key;
    // Most frequent written form; capitalized forms count double ("React" over a typed "react").
    let best = key;
    let bc = -1;
    for (const [s, c] of m) {
      const w = /\p{Lu}/u.test(s) ? c * 2 : c;
      if (w > bc || (w === bc && s < best)) {
        best = s;
        bc = w;
      }
    }
    return best;
  };

  const describe = (members: number[]): Suggestion => {
    const set = new Set(members);
    // cohesion
    let inside = 0;
    let insideEdges = 0;
    let cut = 0;
    const degIn = new Map<number, number>();
    for (const m of members) {
      for (const o of adj[m]!) {
        const w = weightOf(m, o);
        if (set.has(o)) {
          degIn.set(m, (degIn.get(m) ?? 0) + w);
          if (m < o) {
            inside += w;
            insideEdges++;
          }
        } else cut += w;
      }
    }
    const size = members.length;
    const cond = inside / (inside + cut || 1);
    const avgW = inside / (insideEdges || 1);
    const density = insideEdges / ((size * (size - 1)) / 2);
    const score = Math.min(1, 0.5 * cond + 0.3 * Math.min(1, avgW / 0.45) + 0.2 * Math.min(1, density * 2));

    // class-based TF-IDF labels
    const tf = new Map<string, number>();
    for (const m of members) for (const t of feats[m]!.labelTerms) tf.set(t, (tf.get(t) ?? 0) + 1);
    const need = Math.max(2, Math.ceil(size * 0.25));
    const ranked = [...tf]
      .filter(([, c]) => c >= need)
      .map(([t, c]) => ({ t, c, s: (c / size) * Math.log(1 + n / (df.get(t) ?? 1)) * (t.includes(' ') ? 1.25 : 1) }))
      .sort((a, b) => b.s - a.s || (a.t < b.t ? -1 : 1));
    const chosen: { t: string; c: number }[] = [];
    for (const r of ranked) {
      if (chosen.length >= 3) break;
      const parts = r.t.split(' ');
      const overlaps = chosen.some((c) => c.t.split(' ').some((p) => parts.includes(p)));
      if (!overlaps) chosen.push(r);
    }
    const keywords = chosen.map((c) => surfaceOf(c.t));
    const evidence = ranked.slice(0, 6).map((r) => ({ term: surfaceOf(r.t), count: r.c }));

    // chronology and trail
    const ordered = [...members].sort((a, b) => {
      const ta = feats[a]!.t0;
      const tb = feats[b]!.t0;
      if (ta === undefined) return tb === undefined ? a - b : 1;
      if (tb === undefined) return -1;
      return ta - tb || a - b;
    });
    const times = members.flatMap((m) => feats[m]!.times);
    const kinds: Record<SiteKind, number> = { search: 0, ai: 0, video: 0, page: 0 };
    for (const m of members) kinds[feats[m]!.kind]++;
    const trail: TrailStep[] = [];
    for (const m of ordered) {
      const f = feats[m]!;
      if (f.t0 === undefined || trail.length >= TRAIL_MAX) continue;
      const prev = trail[trail.length - 1];
      if (f.kind === 'page' && prev?.kind === 'page' && prev.domain === docs[m]!.domain) continue;
      trail.push({ id: docs[m]!.id, kind: f.kind, at: f.t0, text: f.kind === 'search' ? f.query : f.text, domain: docs[m]!.domain });
    }
    const domCount = new Map<string, number>();
    for (const m of members) domCount.set(docs[m]!.domain, (domCount.get(docs[m]!.domain) ?? 0) + 1);
    const domains = [...domCount]
      .map(([domain, count]) => ({ domain, count }))
      .sort((a, b) => b.count - a.count || (a.domain < b.domain ? -1 : 1));
    const projCount = new Map<string, number>();
    for (const m of members) {
      const p = docs[m]!.project?.trim();
      if (p) projCount.set(p, (projCount.get(p) ?? 0) + 1);
    }
    const topProject = [...projCount].sort((a, b) => b[1] - a[1])[0];
    const central = [...members]
      .sort((a, b) => (degIn.get(b) ?? 0) - (degIn.get(a) ?? 0) || a - b)
      .slice(0, 4)
      .map((m) => docs[m]!.id);
    const ids = ordered.map((m) => docs[m]!.id);
    const label = keywords.length
      ? keywords.join(' · ').replace(/^\p{Ll}/u, (c) => c.toUpperCase())
      : (domains[0]?.domain ?? 'Grupo');
    const s: Suggestion = {
      key: fnv([...ids].sort().join('|')),
      ids,
      label,
      keywords,
      score: Math.round(score * 100) / 100,
      trail,
      kinds,
      domains,
      central,
      evidence,
    };
    if (times.length) {
      s.start = Math.min(...times);
      s.end = Math.max(...times);
    }
    if (topProject && topProject[1] >= size * 0.6) s.project = topProject[0];
    return s;
  };

  const suggestions = clusters.map(describe);
  const rank = (s: Suggestion) => {
    const recency = s.end !== undefined && nowRef ? Math.exp(-Math.max(0, nowRef - s.end) / (14 * 86_400_000)) : 0.3;
    return s.score * (0.6 + 0.4 * recency) * Math.log2(1 + s.ids.length);
  };
  suggestions.sort((a, b) => rank(b) - rank(a) || (a.key < b.key ? -1 : 1));

  const out: ContextResult = {
    suggestions,
    stats: {
      docs: n,
      terms: df.size,
      edges: edges.length,
      grouped: suggestions.reduce((a, s) => a + s.ids.length, 0),
      ms: Date.now() - started,
    },
  };
  if (opts.debug) out.graph = edges.map(([a, b, w]) => ({ a: docs[a]!.id, b: docs[b]!.id, w: Math.round(w * 1000) / 1000 }));
  return out;
}

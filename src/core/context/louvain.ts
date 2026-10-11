// Louvain community detection (Blondel et al., 2008) on a small weighted,
// undirected graph. Deterministic: nodes are visited in index order, so the same
// input always yields the same partition (stable suggestions, testable).

export type Edge = readonly [number, number, number];

export interface LouvainOptions {
  /** Modularity resolution: > 1 favors smaller communities. Default 1. */
  resolution?: number;
  /** Max aggregation levels. Default 10. */
  maxLevels?: number;
  /** Max local-moving sweeps per level. Default 30. */
  maxPasses?: number;
}

type Adj = Map<number, number>[];

function buildAdj(n: number, edges: readonly Edge[]): Adj {
  const adj: Adj = Array.from({ length: n }, () => new Map<number, number>());
  for (const [a, b, w] of edges) {
    if (!(w > 0) || a === b || a < 0 || b < 0 || a >= n || b >= n) continue;
    adj[a]!.set(b, (adj[a]!.get(b) ?? 0) + w);
    adj[b]!.set(a, (adj[b]!.get(a) ?? 0) + w);
  }
  return adj;
}

/** One level: local moving. Returns community per node (renumbered 0..k-1) and whether anything moved. */
function localMoving(adj: Adj, gamma: number, maxPasses: number): { comm: number[]; moved: boolean } {
  const n = adj.length;
  const k = new Float64Array(n);
  let m2 = 0;
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (const w of adj[i]!.values()) s += w;
    k[i] = s;
    m2 += s;
  }
  const comm = Array.from({ length: n }, (_, i) => i);
  if (m2 === 0) return { comm, moved: false };
  const tot = Float64Array.from(k);
  let movedAny = false;
  for (let pass = 0; pass < maxPasses; pass++) {
    let moved = 0;
    for (let i = 0; i < n; i++) {
      const ci = comm[i]!;
      const links = new Map<number, number>();
      for (const [j, w] of adj[i]!) {
        if (j === i) continue;
        const cj = comm[j]!;
        links.set(cj, (links.get(cj) ?? 0) + w);
      }
      tot[ci]! -= k[i]!;
      let best = ci;
      let bestGain = (links.get(ci) ?? 0) - (gamma * tot[ci]! * k[i]!) / m2;
      for (const [c, kin] of links) {
        const gain = kin - (gamma * tot[c]! * k[i]!) / m2;
        if (gain > bestGain + 1e-12) {
          bestGain = gain;
          best = c;
        }
      }
      tot[best]! += k[i]!;
      if (best !== ci) {
        comm[i] = best;
        moved++;
      }
    }
    if (moved === 0) break;
    movedAny = true;
  }
  // renumber
  const map = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const c = comm[i]!;
    if (!map.has(c)) map.set(c, map.size);
    comm[i] = map.get(c)!;
  }
  return { comm, moved: movedAny };
}

function aggregate(adj: Adj, comm: readonly number[], k: number): Adj {
  const out: Adj = Array.from({ length: k }, () => new Map<number, number>());
  for (let i = 0; i < adj.length; i++) {
    const ci = comm[i]!;
    for (const [j, w] of adj[i]!) {
      const cj = comm[j]!;
      out[ci]!.set(cj, (out[ci]!.get(cj) ?? 0) + w);
    }
  }
  return out;
}

/**
 * Partitions nodes 0..n-1. Returns the community index of each node (0-based,
 * numbered by first appearance). Isolated nodes get their own community.
 */
export function louvain(n: number, edges: readonly Edge[], opts: LouvainOptions = {}): number[] {
  const gamma = opts.resolution ?? 1;
  const maxLevels = opts.maxLevels ?? 10;
  const maxPasses = opts.maxPasses ?? 30;
  let adj = buildAdj(n, edges);
  let membership = Array.from({ length: n }, (_, i) => i);
  for (let level = 0; level < maxLevels; level++) {
    const { comm, moved } = localMoving(adj, gamma, maxPasses);
    if (!moved) break;
    const k = Math.max(...comm) + 1;
    membership = membership.map((c) => comm[c]!);
    if (k === adj.length) break;
    adj = aggregate(adj, comm, k);
  }
  // final renumber by first appearance
  const map = new Map<number, number>();
  return membership.map((c) => {
    if (!map.has(c)) map.set(c, map.size);
    return map.get(c)!;
  });
}

/** Newman-Girvan modularity of a partition (tests / diagnostics). */
export function modularity(n: number, edges: readonly Edge[], comm: readonly number[], resolution = 1): number {
  const adj = buildAdj(n, edges);
  let m2 = 0;
  const k = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    for (const w of adj[i]!.values()) k[i]! += w;
    m2 += k[i]!;
  }
  if (m2 === 0) return 0;
  const tot = new Map<number, number>();
  let inside = 0;
  for (let i = 0; i < n; i++) {
    tot.set(comm[i]!, (tot.get(comm[i]!) ?? 0) + k[i]!);
    for (const [j, w] of adj[i]!) if (comm[j] === comm[i]) inside += w;
  }
  let q = inside / m2;
  for (const t of tot.values()) q -= resolution * (t / m2) ** 2;
  return q;
}

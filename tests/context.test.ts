import { describe, expect, it } from 'vitest';
import { analyzeContext, type ContextDoc } from '../src/core/context/engine';
import { louvain, modularity } from '../src/core/context/louvain';
import { fold, pathWords, searchQueryOf, siteKindOf, stem, tokenize } from '../src/core/context/text';

const T0 = Date.UTC(2026, 9, 1, 14, 0);
const MIN = 60_000;
const DAY = 86_400_000;
let seq = 0;
function doc(title: string, url: string, at: number | undefined, extra: Partial<ContextDoc> = {}): ContextDoc {
  const id = 'r' + String(++seq).padStart(4, '0');
  return { id, title, url, domain: new URL(url).hostname.replace(/^www\./, ''), times: at === undefined ? [] : [at], ...extra };
}
const groupOf = (res: ReturnType<typeof analyzeContext>, id: string) => res.suggestions.find((s) => s.ids.includes(id));

describe('text features', () => {
  it('folds accents and stems plurals conservatively', () => {
    expect(fold('Canción ÁRBOL')).toBe('cancion arbol');
    expect(stem('hooks')).toBe('hook');
    expect(stem('aplicaciones')).toBe('aplicacion');
    expect(stem('libraries')).toBe('library');
    expect(stem('class')).toBe('class');
    expect(stem('gas')).toBe('gas');
  });

  it('tokenizes titles keeping surfaces and dropping stopwords, ids and numbers', () => {
    const t = tokenize('Cómo usar los Hooks de React en 2026 - a1b2c3d4e5f6');
    expect(t.map((x) => x.key)).toEqual(['usar', 'hook', 'react']);
    expect(t.map((x) => x.surface)).toEqual(['usar', 'Hooks', 'React']);
    expect(tokenize('node.js, ReactJS y C++').map((x) => x.key)).toEqual(['node', 'react', 'c++']);
    expect(stem('sorting')).toBe('sort');
    expect(stem('running')).toBe('run');
    expect(stem('string')).toBe('string');
  });

  it('extracts queries from search engines', () => {
    expect(searchQueryOf('https://www.google.com/search?q=hooks+de+react&oq=x')).toBe('hooks de react');
    expect(searchQueryOf('https://www.google.com.ar/search?q=bicicleta%20mtb')).toBe('bicicleta mtb');
    expect(searchQueryOf('https://www.bing.com/search?q=rust+traits')).toBe('rust traits');
    expect(searchQueryOf('https://duckduckgo.com/?q=sourdough')).toBe('sourdough');
    expect(searchQueryOf('https://www.youtube.com/results?search_query=lofi+beats')).toBe('lofi beats');
    expect(searchQueryOf('https://listado.mercadolibre.com.ar/bicicleta-rodado-29')).toBe('bicicleta rodado 29');
    expect(searchQueryOf('https://www.amazon.com/s?k=usb+hub')).toBe('usb hub');
    expect(searchQueryOf('https://www.google.com/maps/place/x')).toBe('');
    expect(searchQueryOf('https://example.com/?q=x')).toBe('');
  });

  it('classifies site kinds', () => {
    expect(siteKindOf('https://chatgpt.com/c/123', 'chatgpt.com')).toBe('ai');
    expect(siteKindOf('https://claude.ai/chat/x', 'claude.ai')).toBe('ai');
    expect(siteKindOf('https://www.youtube.com/watch?v=x', 'youtube.com')).toBe('video');
    expect(siteKindOf('https://www.google.com/search?q=x', 'google.com')).toBe('search');
    expect(siteKindOf('https://react.dev/reference', 'react.dev')).toBe('page');
  });

  it('reads words from URL paths and skips ids', () => {
    expect(pathWords('https://blog.x.com/2024/how-to-use-react-hooks')).toBe('how to use react hooks');
    expect(pathWords('https://x.com/item/550e8400-e29b-41d4-a716-446655440000')).toBe('item');
  });
});

describe('louvain', () => {
  it('separates two cliques joined by a weak bridge', () => {
    const edges: [number, number, number][] = [];
    for (let a = 0; a < 5; a++) for (let b = a + 1; b < 5; b++) edges.push([a, b, 1]);
    for (let a = 5; a < 10; a++) for (let b = a + 1; b < 10; b++) edges.push([a, b, 1]);
    edges.push([4, 5, 0.1]);
    const c = louvain(10, edges);
    expect(new Set(c.slice(0, 5)).size).toBe(1);
    expect(new Set(c.slice(5)).size).toBe(1);
    expect(c[0]).not.toBe(c[9]);
    expect(modularity(10, edges, c)).toBeGreaterThan(0.4);
  });

  it('is deterministic and handles isolated nodes', () => {
    const edges: [number, number, number][] = [[0, 1, 1], [1, 2, 1]];
    expect(louvain(5, edges)).toEqual(louvain(5, edges));
    const c = louvain(5, edges);
    expect(c[3]).not.toBe(c[4]);
  });
});

describe('analyzeContext', () => {
  it('groups a search -> AI chat -> sites trail opened within minutes, across domains', () => {
    seq = 0;
    const docs = [
      doc('hooks de react - Buscar con Google', 'https://www.google.com/search?q=hooks+de+react', T0),
      doc('Hooks de React explicados', 'https://chatgpt.com/c/68a1', T0 + 4 * MIN),
      doc('Using the Effect Hook – React', 'https://legacy.reactjs.org/docs/hooks-effect.html', T0 + 9 * MIN),
      doc('useEffect – React', 'https://react.dev/reference/react/useEffect', T0 + 12 * MIN),
      doc('reactjs - When to use useEffect hooks? - Stack Overflow', 'https://stackoverflow.com/questions/1/when-to-use-useeffect-hooks', T0 + 15 * MIN),
      // unrelated noise, same session
      doc('Pronóstico extendido Buenos Aires', 'https://www.smn.gob.ar/pronostico', T0 + 5 * MIN),
      doc('Bicicleta Mtb Rodado 29 | MercadoLibre', 'https://articulo.mercadolibre.com.ar/MLA-1-bicicleta-mtb-rodado-29', T0 + 2 * DAY),
      doc('bicicleta rodado 29 - Buscar con Google', 'https://www.google.com/search?q=bicicleta+rodado+29', T0 + 2 * DAY - 3 * MIN),
      doc('Cómo elegir una bicicleta MTB rodado 29', 'https://www.bikeblog.com/elegir-bicicleta-mtb', T0 + 2 * DAY + 6 * MIN),
      doc('Receta de pan de masa madre', 'https://cocina.com/pan-masa-madre', T0 + 3 * DAY),
    ];
    const res = analyzeContext(docs, { now: T0 + 3 * DAY });
    const react = groupOf(res, 'r0001');
    expect(react).toBeDefined();
    expect(new Set(react!.ids)).toEqual(new Set(['r0001', 'r0002', 'r0003', 'r0004', 'r0005']));
    expect(react!.trail[0]).toMatchObject({ kind: 'search', text: 'hooks de react' });
    expect(react!.trail[1]).toMatchObject({ kind: 'ai' });
    expect(react!.label.toLowerCase()).toMatch(/hook|react|useeffect/);
    expect(react!.kinds).toMatchObject({ search: 1, ai: 1, page: 3 });

    const bike = groupOf(res, 'r0007');
    expect(bike).toBeDefined();
    expect(new Set(bike!.ids)).toEqual(new Set(['r0007', 'r0008', 'r0009']));
    expect(bike!.label.toLowerCase()).toMatch(/bicicleta|rodado|mtb/);
    expect(groupOf(res, 'r0006')).toBeUndefined();
    expect(groupOf(res, 'r0010')).toBeUndefined();
  });

  it('learns site boilerplate instead of grouping by site name', () => {
    seq = 0;
    const docs = [
      doc('python - How to sort a dict? - Stack Overflow', 'https://stackoverflow.com/questions/1/sort-dict', T0),
      doc('python - Sort dict by value - Stack Overflow', 'https://stackoverflow.com/questions/2/sort-dict-value', T0 + MIN),
      doc('Sorting HOW TO — Python docs', 'https://docs.python.org/3/howto/sorting.html', T0 + 2 * MIN),
      doc('css - Center a div - Stack Overflow', 'https://stackoverflow.com/questions/3/center-div', T0 + 10 * DAY),
      doc('css - Flexbox centering - Stack Overflow', 'https://stackoverflow.com/questions/4/flexbox-center', T0 + 10 * DAY + MIN),
      doc('A Complete Guide to Flexbox | CSS-Tricks', 'https://css-tricks.com/snippets/css/a-guide-to-flexbox/', T0 + 10 * DAY + 3 * MIN),
    ];
    const res = analyzeContext(docs, { now: T0 + 10 * DAY });
    const py = groupOf(res, 'r0001');
    const css = groupOf(res, 'r0004');
    expect(py && css).toBeTruthy();
    expect(py!.key).not.toBe(css!.key);
    expect(new Set(py!.ids)).toEqual(new Set(['r0001', 'r0002', 'r0003']));
    expect(new Set(css!.ids)).toEqual(new Set(['r0004', 'r0005', 'r0006']));
    for (const s of res.suggestions) expect(s.label.toLowerCase()).not.toContain('stack');
  });

  it('does not group by time alone, but links an opener chain without shared words', () => {
    seq = 0;
    const docs = [
      doc('Pronóstico del tiempo', 'https://a.com/x', T0),
      doc('Resultados de fútbol', 'https://b.com/y', T0 + MIN),
      doc('Cotización del dólar', 'https://c.com/z', T0 + 2 * MIN),
    ];
    expect(analyzeContext(docs).suggestions).toEqual([]);

    seq = 0;
    const root = doc('Informe trimestral Q3', 'https://intranet.example.com/q3', T0);
    const chain = [
      root,
      doc('Planilla de ventas', 'https://sheets.example.com/1', T0 + MIN, { openerId: root.id }),
      doc('Gráfico interactivo', 'https://charts.example.com/2', T0 + 2 * MIN, { openerId: root.id }),
    ];
    const res = analyzeContext(chain);
    expect(res.suggestions).toHaveLength(1);
    expect(res.suggestions[0]!.ids).toHaveLength(3);
  });

  it('weighs time: the same word weeks apart binds less than within a session', () => {
    seq = 0;
    const docs = [
      doc('kubernetes ingress tutorial', 'https://a.com/1', T0),
      doc('kubernetes ingress nginx', 'https://b.com/2', T0 + 5 * MIN),
      doc('kubernetes ingress annotations', 'https://c.com/3', T0 + 8 * MIN),
      doc('kubernetes ingress tls', 'https://d.com/4', T0 + 60 * DAY),
    ];
    const res = analyzeContext(docs);
    const g = groupOf(res, 'r0001')!;
    expect(g.ids.slice(0, 3)).toEqual(['r0001', 'r0002', 'r0003']);
    expect(g.trail.length).toBeGreaterThan(0);
  });

  it('reports a shared project and is deterministic regardless of input order', () => {
    seq = 0;
    const docs = [
      doc('Vuelos baratos a Lisboa', 'https://vuelos.com/lisboa', T0, { project: 'Viaje' }),
      doc('Hoteles en Lisboa centro', 'https://hoteles.com/lisboa', T0 + 3 * MIN, { project: 'Viaje' }),
      doc('Qué ver en Lisboa en 3 días', 'https://blog.com/lisboa-3-dias', T0 + 6 * MIN),
      doc('Tranvía 28 Lisboa horarios', 'https://carris.pt/28', T0 + 9 * MIN, { project: 'Viaje' }),
    ];
    const a = analyzeContext(docs);
    const b = analyzeContext([...docs].reverse());
    expect({ ...a.suggestions[0], score: 0 }).toEqual({ ...b.suggestions[0], score: 0 });
    expect(a.suggestions[0]!.project).toBe('Viaje');
    expect(a.suggestions[0]!.label.toLowerCase()).toContain('lisboa');
  });

  it('scales to 10k references', () => {
    seq = 0;
    const topics = Array.from({ length: 200 }, (_, i) => ['tema' + i + 'alfa', 'tema' + i + 'beta', 'tema' + i + 'gamma']);
    const docs: ContextDoc[] = [];
    for (let i = 0; i < 10_000; i++) {
      const t = topics[i % 200]!;
      const at = T0 + (i % 200) * 3 * 3_600_000 + Math.floor(i / 200) * MIN;
      docs.push(doc(t[i % 3] + ' ' + t[(i + 1) % 3] + ' detalle ' + i, 'https://site' + (i % 37) + '.com/p' + i, at));
    }
    const res = analyzeContext(docs);
    expect(res.stats.ms).toBeLessThan(15_000);
    expect(res.suggestions.length).toBeGreaterThan(100);
    for (const s of res.suggestions.slice(0, 50)) {
      const topic = new Set(s.ids.map((id) => (Number(id.slice(1)) - 1) % 200));
      expect(topic.size).toBe(1);
    }
    console.log('10k docs:', res.stats);
  });
});

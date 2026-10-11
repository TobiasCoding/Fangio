// Text features for contextual grouping: title cleanup, tokenization (es/en/pt),
// light stemming, search-query extraction from URLs and site kinds.
// Pure functions (no chrome.*, no DOM) so the engine runs in a worker and in tests.

/** Accent-insensitive lowercase (same folding as the list search). */
export function fold(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

// Function words (es / en / pt) plus web boilerplate that says nothing about a topic.
const STOP = new Set(
  [
    // es
    'a al algo algun alguna algunas alguno algunos ante antes aqui asi aun bajo bien cada casi como con contra cual cuales cuando de del desde donde dos el ella ellas ellos en entre era es esa esas ese eso esos esta estan estas este esto estos fue ha hace hacer han hasta hay la las le les lo los mas me mi mis mucho muy nada ni no nos nuestra nuestro o otra otras otro otros para pero poco por porque que quien se sea segun ser si sin sobre solo son su sus tambien tan te tiene tienen todo todos tu tus un una uno unos usted ya yo',
    'cuanto cuantos puedo puede pueden hago mejor mejores nuevo nueva nuevos nuevas gratis online',
    // en
    'about after all also an and any are as at be been before being best but by can could did do does for from get got had has have how i if in into is it its just like make more most my new no not now of on one only or other our out over so some than that the their them then there these they this to too up us use using vs was way we were what when where which while who why will with without you your',
    // pt
    'ao aos as com da das do dos e em na nas no nos o os ou pela pelo um uma',
    // web boilerplate
    'www http https com org net html htm php asp aspx index home inicio pagina page login signin sign log untitled titulo',
    'search buscar busqueda resultados results result google bing duckduckgo yahoo ecosia brave web site sitio oficial official',
    'watch video videos chat tab pestana inbox bandeja entrada',
  ]
    .join(' ')
    .split(/\s+/)
    .filter(Boolean),
);

/** Domain labels that are not brand names (ignored when stripping a site's own name from its titles). */
const GENERIC_LABELS = new Set(['www', 'm', 'mobile', 'app', 'apps', 'web', 'en', 'es', 'pt', 'br', 'ar', 'mx', 'uk', 'us', 'co', 'com', 'org', 'net', 'gov', 'edu', 'io', 'ai', 'dev', 'blog', 'news']);

export function isStopword(t: string): boolean {
  return STOP.has(t);
}

/**
 * Conservative stemmer shared by every language: only plural/derivation endings that
 * are safe across es/en/pt ("hooks" = "hook", "aplicaciones" = "aplicacion",
 * "libraries" = "library"). Never shortens tokens of 3 chars or less.
 */
export function stem(t: string): string {
  if (t.length <= 3) return t;
  // tech names: reactjs / node.js / vuejs -> react / node / vue
  if (/^[a-z]{3,}\.?js$/.test(t)) return t.replace(/\.?js$/, '');
  // english gerund: sorting -> sort, running -> run (only when 4+ chars remain)
  if (t.endsWith('ing') && t.length >= 7) {
    const base = t.slice(0, -3);
    return /([b-df-hj-np-tv-z])\1$/.test(base) ? base.slice(0, -1) : base;
  }
  if (t.endsWith('iones') && t.length > 6) return t.slice(0, -2);
  if (t.endsWith('ies') && t.length > 4) return t.slice(0, -3) + 'y';
  if (t.endsWith('s') && !t.endsWith('ss') && !t.endsWith('us') && !t.endsWith('is')) return t.slice(0, -1);
  return t;
}

/** A token worth keeping: 2+ chars, not only digits, not an id-like blob. */
function keepToken(t: string): boolean {
  if (t.length < 2 || t.length > 30) return false;
  if (/^\d+$/.test(t)) return false;
  if (/\d/.test(t) && t.length > 10) return false; // ids, hashes
  if (/^[0-9a-f]{8,}$/.test(t)) return false;
  return !STOP.has(t);
}

export interface Token {
  /** Stemmed, folded form used for matching. */
  key: string;
  /** Original form (with accents/case) used for labels. */
  surface: string;
  /** Position among all words of the text (stopwords included): adjacency for bigrams. */
  pos: number;
}

/** Splits text into tokens; keeps the original surface form of each one. */
export function tokenize(text: string): Token[] {
  const out: Token[] = [];
  let pos = 0;
  // Letters (any script), digits and a few joiners that belong to tech terms (c++, c#, node.js).
  for (const m of text.matchAll(/[\p{L}\p{N}][\p{L}\p{N}+#]*(?:\.(?:js|ts|py|io|net)\b)?/gu)) {
    const surface = m[0];
    const f = fold(surface);
    const at = pos++;
    if (!keepToken(f)) continue;
    out.push({ key: stem(f), surface, pos: at });
  }
  return out;
}

/** Title separators that usually split "content | site name". */
const SEP_RE = /\s+[-–—|·•:»]\s+|\s*[|·•»]\s*/;

/** "(3) Bandeja de entrada - x" -> "Bandeja de entrada - x" */
export function stripCounters(title: string): string {
  return title.replace(/^\s*[([]\d+\+?[)\]]\s*/, '').trim();
}

export function titleSegments(title: string): string[] {
  return stripCounters(title)
    .split(SEP_RE)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Brand labels of a hostname: "es.wikipedia.org" -> ["wikipedia"], "docs.google.com" -> ["docs", "google"]. */
export function domainLabels(domain: string): string[] {
  const parts = domain.toLowerCase().split('.').filter(Boolean);
  if (parts.length > 1) parts.pop(); // TLD
  return parts.filter((p) => !GENERIC_LABELS.has(p) && p.length > 1).map(fold);
}

// ------------------------------------------------------------------ URL signals

export type SiteKind = 'search' | 'ai' | 'video' | 'page';

const AI_HOSTS = [
  'chatgpt.com',
  'chat.openai.com',
  'claude.ai',
  'gemini.google.com',
  'aistudio.google.com',
  'notebooklm.google.com',
  'perplexity.ai',
  'copilot.microsoft.com',
  'chat.deepseek.com',
  'chat.mistral.ai',
  'grok.com',
  'poe.com',
  'chat.qwen.ai',
  'meta.ai',
];
const VIDEO_HOSTS = ['youtube.com', 'youtu.be', 'vimeo.com', 'twitch.tv', 'dailymotion.com'];

function hostIs(host: string, list: readonly string[]): boolean {
  return list.some((h) => host === h || host.endsWith('.' + h));
}

function safeUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function decodeSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * The query typed by the user when the URL is a search results page
 * (Google, Bing, DuckDuckGo, YouTube, Amazon, Mercado Libre, Wikipedia search, ...).
 * Returns the raw (decoded) query or '' when the URL is not a search.
 */
export function searchQueryOf(url: string): string {
  const u = safeUrl(url);
  if (!u) return '';
  const host = u.hostname.replace(/^www\./, '').toLowerCase();
  const p = u.searchParams;
  const path = u.pathname;
  const pick = (...keys: string[]) => {
    for (const k of keys) {
      const v = p.get(k);
      if (v && v.trim()) return v.trim().slice(0, 300);
    }
    return '';
  };
  if (/(^|\.)google\.[a-z.]+$/.test(host) && (path === '/search' || path === '/webhp' || path === '/')) return pick('q');
  if (/^scholar\.google\./.test(host)) return pick('q');
  if (host === 'bing.com' && path.startsWith('/search')) return pick('q');
  if (host === 'duckduckgo.com' || host === 'html.duckduckgo.com') return pick('q');
  if (host === 'search.yahoo.com') return pick('p', 'q');
  if (host === 'ecosia.org' && path.startsWith('/search')) return pick('q');
  if (host === 'search.brave.com') return pick('q');
  if (host === 'yandex.com' || host === 'yandex.ru') return pick('text');
  if (host === 'perplexity.ai' && path.startsWith('/search')) return pick('q');
  if (hostIs(host, ['youtube.com']) && path === '/results') return pick('search_query', 'q');
  if (/(^|\.)amazon\.[a-z.]+$/.test(host) && path === '/s') return pick('k', 'field-keywords');
  if (host === 'github.com' && path === '/search') return pick('q');
  if (host === 'stackoverflow.com' && path === '/search') return pick('q');
  if (host.endsWith('wikipedia.org') && (path === '/w/index.php' || path.startsWith('/wiki/Special:Search'))) return pick('search');
  if (/^listado\.mercadoli[bv]re\.com/.test(host)) {
    const slug = path.split('/').filter(Boolean)[0] ?? '';
    return decodeSafe(slug).replace(/[-_]+/g, ' ').trim();
  }
  return '';
}

export function siteKindOf(url: string, domain: string): SiteKind {
  if (searchQueryOf(url)) return 'search';
  if (hostIs(domain, AI_HOSTS)) return 'ai';
  if (hostIs(domain, VIDEO_HOSTS)) return 'video';
  return 'page';
}

/** Readable words in the URL path ("/blog/how-to-use-react-hooks" -> "blog how to use react hooks"). Skips ids. */
export function pathWords(url: string): string {
  const u = safeUrl(url);
  if (!u) return '';
  const words: string[] = [];
  for (const seg of u.pathname.split('/')) {
    if (!seg || seg.length > 120) continue;
    const s = decodeSafe(seg).replace(/\.(html?|php|aspx?)$/i, '');
    if (/\d{4,}/.test(s) || /^[0-9a-f-]{12,}$/i.test(s)) continue; // ids, uuids, hashes
    if (!/[-_+]/.test(s) && s.length > 24) continue; // opaque tokens
    words.push(s.replace(/[-_+.]+/g, ' '));
  }
  return words.join(' ');
}

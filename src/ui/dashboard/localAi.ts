// Optional on-device AI (Chrome's built-in Gemini Nano, Prompt API) to name suggested
// groups and flag titles that do not belong. Feature-detected: when the browser does not
// expose LanguageModel or the device does not qualify, the UI simply hides the button.
// Everything runs locally; Chrome downloads the model once (the user starts it explicitly).

export type AiAvailability = 'unsupported' | 'unavailable' | 'downloadable' | 'downloading' | 'available';

interface LMSession {
  prompt(input: string, opts?: { responseConstraint?: unknown; signal?: AbortSignal }): Promise<string>;
  clone(): Promise<LMSession>;
  destroy(): void;
}
interface LMStatic {
  availability(opts?: unknown): Promise<string>;
  create(opts?: unknown): Promise<LMSession>;
}

const lm = (): LMStatic | undefined => (globalThis as { LanguageModel?: LMStatic }).LanguageModel;

const IO_ES = { expectedInputs: [{ type: 'text', languages: ['es', 'en'] }], expectedOutputs: [{ type: 'text', languages: ['es'] }] };
const IO_EN = { expectedInputs: [{ type: 'text', languages: ['en'] }], expectedOutputs: [{ type: 'text', languages: ['en'] }] };

let ioOpts: typeof IO_ES | typeof IO_EN = IO_ES;

export async function aiAvailability(): Promise<AiAvailability> {
  const LM = lm();
  if (!LM?.availability) return 'unsupported';
  for (const io of [IO_ES, IO_EN]) {
    try {
      const a = await LM.availability(io);
      if (a !== 'unavailable') {
        ioOpts = io;
        return a as AiAvailability;
      }
    } catch {
      // try the next language set
    }
  }
  return 'unavailable';
}

const SYSTEM = [
  'Nombrás grupos de pestañas del navegador. Recibís palabras clave y títulos de páginas que un algoritmo agrupó porque parecen la misma tarea o tema.',
  'Respondé SOLO con JSON. "name": un nombre corto (2 a 5 palabras) en español, concreto y orientado a la tarea, por ejemplo "Aprender hooks de React", "Comprar bicicleta rodado 29", "Viaje a Lisboa". Sin comillas ni emojis.',
  '"outliers": números de los títulos que claramente NO pertenecen al tema del resto (lista vacía si todos pertenecen).',
].join('\n');

const SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string', maxLength: 60 },
    outliers: { type: 'array', items: { type: 'integer' }, maxItems: 10 },
  },
  required: ['name', 'outliers'],
  additionalProperties: false,
};

export interface AiGroupInput {
  key: string;
  keywords: string[];
  titles: string[];
}
export interface AiGroupName {
  name: string;
  /** 0-based indexes into the titles sent. */
  outliers: number[];
}

let base: Promise<LMSession> | null = null;

/** Creates (once) the base session. Must be called from a user gesture when the model still has to download. */
export function startAi(onProgress?: (fraction: number) => void): Promise<LMSession> {
  const LM = lm();
  if (!LM) return Promise.reject(new Error('La IA integrada de Chrome no está disponible en este navegador'));
  if (!base) {
    base = LM.create({
      ...ioOpts,
      temperature: 0.2,
      topK: 3,
      initialPrompts: [{ role: 'system', content: SYSTEM }],
      monitor(m: EventTarget) {
        m.addEventListener('downloadprogress', (e) => onProgress?.((e as ProgressEvent).loaded));
      },
    });
    base.catch(() => {
      base = null;
    });
  }
  return base;
}

export function parseAiAnswer(text: string, count: number): AiGroupName | null {
  try {
    const v = JSON.parse(text) as { name?: unknown; outliers?: unknown };
    const name = typeof v.name === 'string' ? v.name.replace(/["«»“”]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60) : '';
    if (!name) return null;
    const outliers = Array.isArray(v.outliers)
      ? [...new Set(v.outliers.filter((x): x is number => Number.isInteger(x) && x >= 1 && x <= count).map((x) => x - 1))]
      : [];
    // Never let the model "remove" most of a group.
    return { name, outliers: outliers.length > count / 2 ? [] : outliers };
  } catch {
    return null;
  }
}

/** Names one group with a fresh clone of the base session (no context carried between groups). */
export async function nameGroup(g: AiGroupInput, signal?: AbortSignal): Promise<AiGroupName | null> {
  const s = await (await startAi()).clone();
  try {
    const titles = g.titles.slice(0, 10).map((t, i) => `${i + 1}. ${t.slice(0, 100)}`);
    const input = `Palabras clave: ${g.keywords.join(', ') || '(ninguna)'}\nTítulos:\n${titles.join('\n')}`;
    const out = await s.prompt(input, { responseConstraint: SCHEMA, ...(signal ? { signal } : {}) });
    return parseAiAnswer(out, titles.length);
  } finally {
    s.destroy();
  }
}

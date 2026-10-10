// Tiny local HTTP server for the e2e harness (127.0.0.1, random port).
//   /                 root page (exact-URL rule tests)
//   /p/<n>[?q][#f]    "Página n" (fragments never reach the server; query is echoed)
//   /audio            page that autoplays a looping tone (audible tab, if the platform allows)
//   /tone.wav         generated sine wave
//   /favicon.ico      16x16 PNG favicon
import { createServer } from 'node:http';

function png16() {
  // Minimal valid 1x1 PNG (scaled by the browser). Generated once, served as image/png.
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
  );
}

function toneWav(seconds = 2, freq = 440, rate = 8000) {
  const n = seconds * rate;
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 8000), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const page = (title, body = '') =>
  `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${esc(title)}</title>` +
  `<link rel="icon" href="/favicon.ico"></head><body><h1>${esc(title)}</h1>${body}</body></html>`;

export async function startServer() {
  const fav = png16();
  const wav = toneWav();
  let hits = 0;
  const server = createServer((req, res) => {
    hits++;
    const u = new URL(req.url, 'http://x');
    const send = (code, type, body) => {
      res.writeHead(code, { 'content-type': type, 'cache-control': 'max-age=3600' });
      res.end(body);
    };
    if (u.pathname === '/favicon.ico') return send(200, 'image/png', fav);
    if (u.pathname === '/tone.wav') return send(200, 'audio/wav', wav);
    if (u.pathname === '/') return send(200, 'text/html; charset=utf-8', page('Inicio de prueba'));
    if (u.pathname === '/audio')
      return send(200, 'text/html; charset=utf-8', page('Audio de prueba', '<audio src="/tone.wav" autoplay loop></audio>'));
    const m = /^\/p\/(\d+)$/.exec(u.pathname);
    if (m) {
      const q = u.searchParams.get('q');
      return send(200, 'text/html; charset=utf-8', page(`Página ${m[1]}${q ? ` (${q})` : ''}`));
    }
    send(404, 'text/plain', 'not found');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return {
    port,
    origin: `http://127.0.0.1:${port}`,
    get hits() { return hits; },
    close: () => new Promise((r) => server.close(() => r())),
  };
}

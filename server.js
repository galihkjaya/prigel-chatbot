import express from 'express';
import { watch } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { handleApi } from './api.js';

const app = express();
const dev = process.argv.includes('--dev');
const root = fileURLToPath(new URL('./public/', import.meta.url));
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';
const bootId = Date.now().toString();
const clients = new Set();

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'same-origin');
  res.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  next();
});

if (dev) {
  let debounce;
  watch(root, () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      for (const client of clients) client.write('event: change\ndata: updated\n\n');
    }, 180);
  });
  app.get('/_dev/watch', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
    res.write('data: ' + bootId + '\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
  });
  app.get('/_dev/reload.js', (_req, res) => {
    res.type('js').send("const updates=new EventSource('/_dev/watch');let boot;updates.onmessage=e=>{if(boot&&boot!==e.data)location.reload();boot=e.data};updates.addEventListener('change',()=>location.reload());");
  });
}

app.get(['/', '/admin', '/admin/'], async (req, res) => {
  const file = req.path === '/' ? 'index.html' : 'admin.html';
  let html;
  try {
    html = await readFile(join(root, file), 'utf8');
  } catch (error) {
    if (!dev || error.code !== 'ENOENT') throw error;
    html = '<!doctype html><html lang="en"><meta charset="utf-8"><title>PRIGEL UNNES</title><body><h1>PRIGEL UNNES</h1><p>The preview is loading. This page will refresh automatically.</p></body></html>';
  }
  if (dev) html = html.replace('</body>', '<script src="/_dev/reload.js"></script></body>');
  res.set('Cache-Control', 'no-store').type('html').send(html);
});
app.use(express.static(root, { index: false }));
app.use('/api', async (req, res) => {
  const body = !['GET', 'HEAD'].includes(req.method) ? Readable.toWeb(req) : undefined;
  const request = new Request('http://localhost' + req.originalUrl, {
    method: req.method, headers: req.headers, body, duplex: 'half',
  });
  const response = await handleApi(request);
  res.status(response.status).set(Object.fromEntries(response.headers));
  if (!response.body || req.method === 'HEAD') return res.end();
  res.flushHeaders();
  try {
    await pipeline(Readable.fromWeb(response.body), res);
  } catch (error) {
    if (!res.destroyed) throw error;
  }
});

const server = app.listen(port, host, () => console.log('PRIGEL UNNES is available at http://' + host + ':' + server.address().port));

import express from 'express';
import multer from 'multer';
import { createHash, timingSafeEqual } from 'node:crypto';
import { watch } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RequestError } from './documents.js';

const app = express();
const dev = process.argv.includes('--dev');
const root = fileURLToPath(new URL('./public/', import.meta.url));
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';
const upload = multer({ defParamCharset: 'utf8', limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 0, parts: 2 } });
const digest = text => createHash('sha256').update(text).digest();
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
    html = '<!doctype html><html lang="id"><meta charset="utf-8"><title>PRIGEL UNNES</title><body><h1>PRIGEL UNNES</h1><p>Pratinjau sedang disiapkan. Halaman ini akan diperbarui otomatis.</p></body></html>';
  }
  if (dev) html = html.replace('</body>', '<script src="/_dev/reload.js"></script></body>');
  res.set('Cache-Control', 'no-store').type('html').send(html);
});
app.use(express.static(root, { index: false }));
app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

app.post('/api/chat', express.json({ limit: '256kb' }), async (req, res) => {
  const messages = req.body?.messages;
  if (!Array.isArray(messages) || !messages.length || messages.length > 21 ||
      messages.length % 2 === 0 || messages.some((m, i) => !m ||
        m.role !== (i % 2 ? 'assistant' : 'user') || typeof m.content !== 'string' ||
        !m.content.trim() || m.content.length > (m.role === 'user' ? 4000 : 16000))) {
    return res.status(400).json({ error: 'Kirim maksimal 10 pasang pesan dan satu pertanyaan baru (maksimal 4.000 karakter).' });
  }
  const { answer } = await import('./rag.js');
  const turns = messages.map(({ role, content }) => ({ role, content }));
  if (!req.get('Accept')?.includes('application/x-ndjson')) {
    return res.json(await answer(turns));
  }
  res.set({ 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store, no-transform', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  const emit = event => {
    if (res.destroyed) throw new Error('Chat closed');
    res.write(JSON.stringify(event) + '\n');
  };
  try {
    const result = await answer(turns, progress => emit({ type: 'progress', ...progress }));
    emit({ type: 'answer', ...result });
  } catch (error) {
    if (!res.destroyed) emit({ type: 'error', error: error instanceof RequestError ? error.message : 'Asisten belum dapat menjawab. Coba lagi.' });
  } finally {
    res.end();
  }
});

app.use('/api/resources', (req, res, next) => {
  const password = process.env.ADMIN_PASSWORD;
  if (!password) return res.status(503).json({ error: 'Sandi admin belum dikonfigurasi.' });
  const auth = req.get('authorization') || '';
  if (!auth.startsWith('Bearer ') || !timingSafeEqual(digest(auth.slice(7)), digest(password))) {
    return res.status(401).json({ error: 'Sandi admin tidak sesuai.' });
  }
  next();
});
app.get('/api/resources', async (_req, res) => {
  const { listResources } = await import('./rag.js');
  res.json({ resources: await listResources() });
});
app.post('/api/resources', upload.single('file'), async (req, res) => {
  if (!req.file?.size) return res.status(400).json({ error: 'Pilih dokumen yang berisi teks.' });
  const { upsertResource } = await import('./rag.js');
  const name = basename(req.file.originalname).trim();
  res.status(201).json({ resource: await upsertResource(name, req.file.buffer) });
});

app.use('/api', (_req, res) => res.status(404).json({ error: 'Endpoint tidak ditemukan.' }));
app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError) {
    return res.status(400).json({ error: error.code === 'LIMIT_FILE_SIZE' ? 'Ukuran berkas maksimal 10 MB.' : 'Pilih satu berkas .md atau .pdf.' });
  }
  if (error.type === 'entity.parse.failed' || error.type === 'entity.too.large') {
    return res.status(error.status).json({ error: 'Format atau ukuran permintaan tidak sesuai.' });
  }
  if (error instanceof RequestError) return res.status(error.status).json({ error: error.message });
  console.error('Layanan gagal', error.constructor.name, error.status || error.code || '');
  res.status(502).json({ error: 'Layanan belum dapat memproses permintaan. Coba lagi atau hubungi admin.' });
});

const server = app.listen(port, host, () => console.log('PRIGEL UNNES tersedia di http://' + host + ':' + server.address().port));


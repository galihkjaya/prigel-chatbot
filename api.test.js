import assert from 'node:assert/strict';
import { test } from 'node:test';
import handler, { config } from './netlify/functions/api.mjs';

const url = path => 'https://prigel.example' + path;

test('Netlify exposes the browser API routes and rejects malformed chat requests', async () => {
  assert.deepEqual(config.path, ['/api/chat', '/api/resources']);
  const reply = await handler(new Request(url('/api/chat'), {
    method: 'POST',
    headers: { Accept: 'application/x-ndjson' },
    body: JSON.stringify({ messages: [{ role: 'assistant', content: 'Invalid first turn' }] }),
  }));
  assert.equal(reply.status, 400);
  assert.equal(reply.headers.get('cache-control'), 'no-store');
  assert.match((await reply.json()).error, /new question/);
});

test('Netlify checks admin credentials and handles multipart upload limits before indexing', async () => {
  process.env.ADMIN_PASSWORD = 'test-only-password';
  process.env.EMBEDDING_MODEL_API = 'test-only-key';
  process.env.EMBEDDING_MODEL = 'test-only-model';
  assert.equal((await handler(new Request(url('/api/resources')))).status, 401);

  const headers = { Authorization: 'Bearer test-only-password' };
  const invalid = new FormData();
  invalid.set('file', new File(['not a PDF'], 'invalid.pdf'));
  const invalidReply = await handler(new Request(url('/api/resources'), {
    method: 'POST', headers, body: invalid,
  }));
  assert.equal(invalidReply.status, 422);
  assert.match((await invalidReply.json()).error, /valid PDF/);

  const large = new FormData();
  large.set('file', new File([new Uint8Array(4 * 1024 ** 2 + 1)], 'large.pdf'));
  const largeReply = await handler(new Request(url('/api/resources'), {
    method: 'POST', headers, body: large,
  }));
  assert.equal(largeReply.status, 413);
  assert.match((await largeReply.json()).error, /4 MB/);
});

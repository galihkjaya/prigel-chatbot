import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import handler from './netlify/functions/api.mjs';

test('Netlify chat traces the latest question, final reply, and provider token counts', async (t) => {
  Object.assign(process.env, {
    LANGFUSE_BASE_URL: 'https://observability.example',
    LANGFUSE_PUBLIC_KEY: 'test-public',
    LANGFUSE_SECRET_KEY: 'test-secret',
    CHATBOT_API: 'test-chat-key',
    CHATBOT_ENDPOINT: 'https://models.example/v1',
    CHATBOT_MODEL: 'test-chat',
    EMBEDDING_MODEL_API: 'test-embedding-key',
    EMBEDDING_ENDPOINT: 'https://models.example/v1',
    EMBEDDING_MODEL: 'test-embedding',
    PINECONE_API: 'test-index-key',
    PINECONE_INDEX: 'test-index',
    PINECONE_NAMESPACE: 'test-index',
  });
  const key = createHash('sha256').update(JSON.stringify(['https://models.example/v1', 'test-embedding', ''])).digest('hex');
  const exports = [];
  const answerText = 'Program starts in January. [1]';
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    const url = new URL(input.url ?? input);
    if (url.host === 'observability.example') {
      exports.push({ path: url.pathname, headers: options.headers, body: options.body });
      return Response.json({});
    }
    if (url.host === 'api.pinecone.io') {
      return Response.json({ host: 'index.example', schema: { fields: { dim: { type: 'dense_vector', dimension: 3 } } } });
    }
    if (url.pathname.endsWith('/documents/fetch')) {
      return Response.json({ documents: { resource: { kind: 'prigel-resource', embedding: key, version: 'first' } } });
    }
    if (url.pathname.endsWith('/documents/search')) {
      return Response.json({ matches: [{ _score: 0.9, name: 'student-document.pdf', text: 'The program begins in January.' }] });
    }
    if (url.pathname === '/v1/embeddings') {
      return Response.json({ data: [{ index: 0, embedding: [1, 0, 0] }], usage: { prompt_tokens: 13, total_tokens: 13 } });
    }
    if (url.pathname === '/v1/chat/completions') {
      const { messages } = JSON.parse(options.body);
      const payload = JSON.parse(messages[1].content);
      if (payload.stage) return Response.json({ choices: [{ message: { content: '{"status":"Checking sources."}' } }] });
      if (!payload.sources) return Response.json({ choices: [{ message: { content: 'PRIGEL program start date' } }] });
      return Response.json({
        model: 'actual-chat-model',
        usage: { prompt_tokens: 117, completion_tokens: 29, total_tokens: 146 },
        choices: [{ message: { content: answerText } }],
      });
    }
    throw new Error('Unexpected test request');
  });

  const response = await handler(new Request('https://prigel.example/api/chat', {
    method: 'POST',
    headers: { Accept: 'application/x-ndjson' },
    body: JSON.stringify({ messages: [
      { role: 'user', content: 'earlier student question' },
      { role: 'assistant', content: 'earlier assistant reply' },
      { role: 'user', content: 'latest student question' },
    ] }),
  }));
  const events = (await response.text()).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(events.at(-1).answer, answerText);
  assert.equal(exports.length, 1);
  const [exported] = exports;
  assert.equal(exported.path, '/api/public/otel/v1/traces');
  assert.equal(exported.headers['x-langfuse-ingestion-version'], '4');
  assert.equal(exported.headers.Authorization, 'Basic ' + Buffer.from('test-public:test-secret').toString('base64'));
  assert.doesNotMatch(exported.body, /earlier student question|earlier assistant reply|The program begins|student-document|test-secret|Checking sources/);
  const [root, ...children] = JSON.parse(exported.body).resourceSpans[0].scopeSpans[0].spans;
  assert.equal(root.name, 'POST /api/chat');
  const input = root.attributes.find(item => item.key === 'langfuse.observation.input');
  const output = root.attributes.find(item => item.key === 'langfuse.observation.output');
  assert.equal(JSON.parse(input.value.stringValue), 'latest student question');
  assert.equal(JSON.parse(output.value.stringValue), answerText);
  assert.ok(children.every(span => span.traceId === root.traceId && span.parentSpanId === root.spanId));
  assert.ok(children.every(span => span.attributes.every(item => !['langfuse.observation.input', 'langfuse.observation.output'].includes(item.key))));
  const attributes = name => Object.fromEntries(children.find(span => span.name === name).attributes
    .map(({ key, value }) => [key, value.stringValue]));
  const usage = name => JSON.parse(attributes(name)['langfuse.observation.usage_details']);
  assert.deepEqual(usage('model.embed-query'), { input: 13, output: 0, total: 13 });
  assert.deepEqual(usage('model.answer'), { input: 117, output: 29, total: 146 });
  assert.equal(attributes('model.answer')['langfuse.observation.model.name'], 'actual-chat-model');
  assert.equal(attributes('model.rewrite-query')['langfuse.observation.metadata.usage_reported'], 'false');
  assert.equal(attributes('pinecone.retrieve')['langfuse.observation.type'], 'retriever');
});

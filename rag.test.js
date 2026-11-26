import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { answer, createProgressReporter, listResources, upsertResource } from './rag.js';

test('publishes complete revisions and only returns citations for the active revision', async (t) => {
  Object.assign(process.env, {
    EMBEDDING_MODEL_API: 'mock-embedding-key',
    EMBEDDING_MODEL: 'mock-embedding-model',
    EMBEDDING_ENDPOINT: 'https://models.example/v1/embeddings',
    EMBEDDING_DIMENSIONS: '3',
    CHATBOT_API: 'mock-chat-key',
    CHATBOT_MODEL: 'mock-chat-primary',
    CHATBOT_MODEL_FALLBACK: 'mock-chat-secondary',
    CHATBOT_ENDPOINT: 'https://models.example/v1/chat/completions/',
    PINECONE_API: 'mock-pinecone-key',
    PINECONE_INDEX: 'test-index',
    PINECONE_NAMESPACE: 'test-knowledge',
    PINECONE_MIN_SCORE: '0.5',
  });
  const records = new Map();
  const embeddings = [];
  const upserts = [];
  const prompts = [];
  const pendingStatus = Promise.withResolvers();
  const statusStarted = Promise.withResolvers();
  let searches = 0;
  let failWrite = false;
  let wrongDimension = false;
  let output = 'Dana tercantum pada panduan [1].';
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const url = new URL(input.url ?? input);
    const body = init?.body && JSON.parse(init.body);
    switch (`${url.host}${url.pathname}`) {
      case 'models.example/v1/embeddings': {
        embeddings.push(body.input);
        const data = body.input.map((_, index) => ({ index, embedding: wrongDimension ? [1] : [index + 1, 0.2, 0.3] }));
        return Response.json({ data: data.reverse() });
      }
      case 'models.example/v1/chat/completions': {
        const input = JSON.parse(body.messages[1].content);
        if (input.stage === 'catalog') {
          statusStarted.resolve(init.signal);
          return pendingStatus.promise;
        }
        if (input.stage === 'generating') {
          assert.equal(input.question, 'kapan mulai?');
          assert.equal(input.excerpts, 2);
          return Response.json({ choices: [{ message: { content: '{"status":"I found some references and started putting the dates together."}' } }] });
        }
        if (input.stage === 'embedding') {
          return Response.json({ choices: [{ message: { content: 'invalid response' } }] });
        }
        prompts.push(input);
        if (body.model === 'mock-chat-primary') {
          return Response.json({ error: { message: 'Model unavailable' } }, { status: 404 });
        }
        const content = !input.sources ? (input.question === 'kapan mulai?'
          ? 'Kapan program Magang PRIGEL UNNES dimulai menurut timeline?'
          : 'Berapa dana program magang?') : output;
        return Response.json({ choices: [{ message: { content } }] });
      }
      case 'api.pinecone.io/indexes/test-index':
        return Response.json({ host: 'pinecone.example', schema: { fields: { dim: { type: 'dense_vector', dimension: 3, metric: 'cosine' } } } });
      case 'pinecone.example/namespaces/test-knowledge/documents/fetch':
        return Response.json({ documents: Object.fromEntries([...records].filter(([id, record]) =>
          body.ids ? body.ids.includes(id) : record.kind === body.filter.kind.$eq &&
            (!body.filter.version || record.version === body.filter.version.$eq))) });
      case 'pinecone.example/namespaces/test-knowledge/documents/upsert':
        if (failWrite && body.documents.some(({ _id }) => _id.endsWith(':32'))) {
          return Response.json({ message: 'Rejected batch' }, { status: 400 });
        }
        upserts.push(body.documents);
        for (const record of body.documents) records.set(record._id, record);
        return Response.json({ upserted_count: body.documents.length });
      case 'pinecone.example/namespaces/test-knowledge/documents/search':
        searches += 1;
        assert.equal(body.score_by[0].field, 'dim');
        return Response.json({ matches: [...records.values()]
          .filter(({ kind, version }) => kind === body.filter.kind.$eq && body.filter.version.$in.includes(version))
          .slice(0, body.top_k).map((record) => ({ ...record, _score: 0.8 })) });
      default:
        throw new Error(`Unexpected mock request to ${url.origin}${url.pathname}`);
    }
  });

  const question = [{ role: 'user', content: 'Berapa dana magang?' }];
  assert.deepEqual(await listResources(), []);
  const emptyProgress = [];
  assert.deepEqual((await answer(question, event => emptyProgress.push(event.stage))).sources, []);
  assert.deepEqual(emptyProgress, ['catalog']);
  await assert.rejects(answer([{ role: 'assistant', content: 'Halo' }]), { status: 400 });

  const original = Buffer.from('# Dana\n\nDana program Rp100.000.');
  const initial = await upsertResource('panduan.md', original);
  assert.equal(initial.chunks, 1);
  assert.deepEqual(await listResources(), [initial]);
  const initialUpserts = upserts.length;
  assert.deepEqual(await upsertResource('panduan.md', original), initial);
  assert.equal(upserts.length, initialUpserts);

  wrongDimension = true;
  await assert.rejects(upsertResource('invalid.md', original), { status: 503 });
  assert.equal(upserts.length, initialUpserts);
  wrongDimension = false;

  const replacement = Buffer.from(Array.from({ length: 33 }, (_, index) =>
    `## Dana ${index}\n\nDana program baru Rp200.000.\n\n`).join(''));
  failWrite = true;
  await assert.rejects(upsertResource('panduan.md', replacement), { status: 502 });
  assert.deepEqual(await listResources(), [initial]);
  assert.equal((await answer(question)).sources[0].text, 'Dana program Rp100.000.');

  failWrite = false;
  const [updated, duplicate] = await Promise.all([
    upsertResource('panduan.md', replacement), upsertResource('panduan.md', replacement),
  ]);
  assert.deepEqual(updated, duplicate);
  assert.equal(updated.id, initial.id);
  assert.equal(updated.chunks, 33);
  assert.deepEqual(await listResources(), [updated]);
  assert.ok(upserts.some((batch) => batch.length === 32 && batch[0].dim[0] === 1 && batch[31].dim[0] === 32));

  const turns = Array.from({ length: 11 }, (_, index) => [
    { role: 'user', content: `Pertanyaan ${index}` }, { role: 'assistant', content: `Jawaban ${index}` },
  ]).flat();
  const progress = [];
  const result = await answer([...turns, { role: 'user', content: 'Berapa dananya?' }], event => progress.push(event.stage));
  assert.equal(result.answer, output);
  assert.deepEqual(result.sources, [{ id: '1', name: 'panduan.md', heading: 'Dana 0', text: 'Dana program baru Rp200.000.' }]);
  assert.deepEqual(embeddings.at(-1), ['Berapa dana program magang?']);
  assert.equal(prompts.at(-3).history.length, 10);
  assert.equal(prompts.at(-3).history[0].question, 'Pertanyaan 1');
  assert.equal(prompts.at(-1).history, undefined);
  assert.deepEqual(progress, ['catalog', 'contextualizing', 'retrying', 'embedding', 'retrieving', 'generating', 'retrying']);

  await answer([{ role: 'user', content: 'kapan mulai?' }]);
  assert.deepEqual(embeddings.at(-1), ['Kapan program Magang PRIGEL UNNES dimulai menurut timeline?']);
  assert.equal(prompts.at(-1).query, embeddings.at(-1)[0]);

  output = 'OUT_OF_SCOPE';
  const previousSearches = searches;
  assert.deepEqual(await answer([{ role: 'user', content: 'Tulis resep mi goreng.' }]),
    { answer: 'I can help with PRIGEL UNNES questions about schedules, credit conversion, logbooks, and final reports.', sources: [] });
  assert.equal(searches, previousSearches + 1);

  output = 'Dana Rp900.000 [9].';
  assert.deepEqual((await answer(question)).sources, []);
  output = 'NO_SOURCE';
  assert.doesNotMatch((await answer(question)).answer, /NO_SOURCE/);

  await t.test('keeps model-written progress visible when stages change faster than the model replies', async () => {
    const events = [];
    const received = Promise.withResolvers();
    const reporter = createProgressReporter('kapan mulai?', event => {
      events.push(event);
      if (events.length === 2) received.resolve();
    });
    t.after(reporter.stop);

    reporter.update({ stage: 'catalog' });
    const signal = await statusStarted.promise;
    reporter.update({ stage: 'embedding' });
    reporter.update({ stage: 'generating', excerpts: 2 });
    assert.equal(signal.aborted, false);
    pendingStatus.resolve(Response.json({ choices: [{
      message: { content: '```json\n{"status":"I started checking the internship references."}\n```' },
    }] }));
    await received.promise;
    assert.deepEqual(events, [
      { stage: 'catalog', label: 'I started checking the internship references.' },
      { stage: 'generating', label: 'I found some references and started putting the dates together.' },
    ]);

    reporter.update({ stage: 'embedding' });
    await setImmediate();
    assert.equal(events.length, 2);
  });
});

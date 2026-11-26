import { createHash, timingSafeEqual } from 'node:crypto';
import { RequestError } from './documents.js';
import { answer, createProgressReporter, listResources, upsertResource } from './rag.js';

const encoder = new TextEncoder();
const chatLimit = 256 * 1024;
const digest = text => createHash('sha256').update(text).digest();
const responseHeaders = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};

function json(data, status = 200) {
  return Response.json(data, { status, headers: responseHeaders });
}

async function readBody(request, limit, errorMessage) {
  const tooLarge = () => new RequestError(413, errorMessage);
  if (Number(request.headers.get('Content-Length')) > limit) throw tooLarge();
  const chunks = [];
  let size = 0;
  if (request.body) {
    for await (const chunk of request.body.values({ preventCancel: true })) {
      size += chunk.byteLength;
      if (size > limit) throw tooLarge();
      chunks.push(chunk);
    }
  }
  return Buffer.concat(chunks, size);
}

async function chat(request) {
  const payload = await readBody(request, chatLimit, 'The request is too large.');
  let messages;
  try {
    messages = JSON.parse(payload.toString('utf8'))?.messages;
  } catch {
    throw new RequestError(400, 'The request format is invalid.');
  }
  if (!Array.isArray(messages) || !messages.length || messages.length > 21 ||
      messages.length % 2 === 0 || messages.some((message, index) => !message ||
        message.role !== (index % 2 ? 'assistant' : 'user') || typeof message.content !== 'string' ||
        !message.content.trim() || message.content.length > (message.role === 'user' ? 4000 : 16000))) {
    throw new RequestError(400, 'Send up to 10 message pairs and one new question of up to 4,000 characters.');
  }
  const turns = messages.map(({ role, content }) => ({ role, content }));
  if (!request.headers.get('Accept')?.includes('application/x-ndjson')) return json(await answer(turns));

  let cancelled = false;
  let progress;
  const body = new ReadableStream({
    async start(controller) {
      const emit = event => controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'));
      // Flush the response while the model prepares its first progress update.
      controller.enqueue(encoder.encode('\n'));
      progress = createProgressReporter(turns.at(-1).content, status => emit({ type: 'progress', ...status }));
      try {
        const result = await answer(turns, event => {
          if (cancelled) throw new Error('Chat closed');
          progress.update(event);
        });
        if (!cancelled) emit({ type: 'answer', ...result });
      } catch (error) {
        if (!cancelled) emit({ type: 'error', error: error instanceof RequestError ? error.message : 'The assistant could not reply. Please try again.' });
      } finally {
        progress.stop();
        if (!cancelled) controller.close();
      }
    },
    cancel() {
      cancelled = true;
      progress?.stop();
    },
  });
  return new Response(body, {
    headers: {
      ...responseHeaders,
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      'X-Accel-Buffering': 'no',
    },
  });
}

async function resources(request, maxUploadBytes) {
  const password = process.env.ADMIN_PASSWORD;
  if (!password) throw new RequestError(503, 'The admin password has not been configured.');
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ') || !timingSafeEqual(digest(auth.slice(7)), digest(password))) {
    throw new RequestError(401, 'Incorrect admin password.');
  }
  if (request.method === 'GET') return json({ resources: await listResources(), maxUploadBytes });

  const type = request.headers.get('Content-Type');
  if (!type?.startsWith('multipart/form-data;')) throw new RequestError(400, 'Choose one .md or .pdf file.');
  const sizeError = `The maximum file size is ${maxUploadBytes / 1024 ** 2} MB.`;
  const payload = await readBody(request, maxUploadBytes + 16 * 1024, sizeError);
  let form;
  try {
    form = await new Response(payload, { headers: { 'Content-Type': type } }).formData();
  } catch {
    throw new RequestError(400, 'Choose one .md or .pdf file.');
  }
  const file = form.get('file');
  if (!(file instanceof File) || [...form.keys()].length !== 1 || !file.size) {
    throw new RequestError(400, 'Choose one .md or .pdf file containing text.');
  }
  if (file.size > maxUploadBytes) throw new RequestError(413, sizeError);
  return json({ resource: await upsertResource(file.name, Buffer.from(await file.arrayBuffer())) }, 201);
}

export async function handleApi(request, maxUploadBytes = 10 * 1024 ** 2) {
  const path = new URL(request.url).pathname.replace(/\/$/, '');
  try {
    if (path === '/api/chat' && request.method === 'POST') return await chat(request);
    if (path === '/api/resources' && ['GET', 'POST'].includes(request.method)) {
      return await resources(request, maxUploadBytes);
    }
    return json({ error: 'Endpoint not found.' }, 404);
  } catch (error) {
    if (error instanceof RequestError) return json({ error: error.message }, error.status);
    console.error('Service error', error.constructor.name, error.status || error.code || '');
    return json({ error: 'Could not complete the request. Try again or contact an administrator.' }, 502);
  }
}

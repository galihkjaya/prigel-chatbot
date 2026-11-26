import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';

const activeTrace = new AsyncLocalStorage();
const scope = { name: 'prigel' };
const attribute = (key, value) => ({ key, value: { stringValue: value } });
const now = () => (BigInt(Date.now()) * 1_000_000n).toString();
const id = bytes => randomBytes(bytes).toString('hex');

function destination() {
  const { LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, LANGFUSE_BASE_URL } = process.env;
  if (!LANGFUSE_PUBLIC_KEY || !LANGFUSE_SECRET_KEY || !LANGFUSE_BASE_URL) return;
  try {
    const url = new URL('/api/public/otel/v1/traces', LANGFUSE_BASE_URL);
    if (url.protocol === 'https:' && !url.username && !url.password) {
      const credentials = Buffer.from(`${LANGFUSE_PUBLIC_KEY}:${LANGFUSE_SECRET_KEY}`).toString('base64');
      return { url, credentials };
    }
  } catch {
    // Invalid optional telemetry settings should leave the application usable.
  }
}

function span(traceId, traceName, name, type, parentSpanId) {
  return {
    traceId, spanId: id(8), parentSpanId, name, kind: parentSpanId ? 1 : 2,
    startTimeUnixNano: now(),
    attributes: [
      attribute('langfuse.trace.name', traceName),
      attribute('langfuse.observation.type', type),
    ],
  };
}

function recordFailure(observation, error) {
  observation.status = { code: 2, message: 'Operation failed' };
  if (Number.isInteger(error?.status)) {
    observation.attributes.push(attribute('langfuse.observation.metadata.http_status', String(error.status)));
  }
}

function tokenUsage(usage, type) {
  if (!usage) return;
  const counts = {
    input: usage.prompt_tokens ?? usage.input_tokens,
    output: usage.completion_tokens ?? usage.output_tokens,
    total: usage.total_tokens,
  };
  const reported = Object.fromEntries(Object.entries(counts).filter(([, count]) => Number.isSafeInteger(count) && count >= 0));
  if (!Object.keys(reported).length) return;
  if (type === 'embedding') reported.output ??= 0;
  return reported;
}

async function sendTrace({ url, credentials }, spans) {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/json',
        'x-langfuse-ingestion-version': '4',
      },
      body: JSON.stringify({
        resourceSpans: [{
          resource: { attributes: [attribute('service.name', 'prigel-ai')] },
          scopeSpans: [{ scope, spans }],
        }],
      }),
      redirect: 'error',
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) {
      console.warn('Langfuse trace export failed', response.status);
      await response.body?.cancel();
      return;
    }
    const result = await response.json().catch(() => undefined);
    if (Number(result?.partialSuccess?.rejectedSpans) > 0) {
      console.warn('Langfuse rejected spans', Number(result.partialSuccess.rejectedSpans));
    }
  } catch {
    console.warn('Langfuse trace export unavailable');
  }
}

export async function traceChat(question, run) {
  const target = destination();
  if (!target) return run();
  const name = 'POST /api/chat';
  const root = span(id(16), name, name, 'span');
  root.attributes.push(attribute('langfuse.observation.input', JSON.stringify(question)));
  const spans = [root];
  try {
    const result = await activeTrace.run({ root, spans }, run);
    root.attributes.push(attribute('langfuse.observation.output', JSON.stringify(result.answer)));
    return result;
  } catch (error) {
    recordFailure(root, error);
    throw error;
  } finally {
    root.endTimeUnixNano = now();
    await sendTrace(target, spans);
  }
}

export async function traceOperation(name, run, { type = 'span', model } = {}) {
  const trace = activeTrace.getStore();
  if (!trace) return run();
  const observation = span(trace.root.traceId, trace.root.name, name, type, trace.root.spanId);
  try {
    const result = await run();
    if (model) {
      if (typeof result?.model === 'string' && result.model) model = result.model;
      const usage = tokenUsage(result?.usage, type);
      if (usage) observation.attributes.push(attribute('langfuse.observation.usage_details', JSON.stringify(usage)));
      else observation.attributes.push(attribute('langfuse.observation.metadata.usage_reported', 'false'));
    }
    return result;
  } catch (error) {
    recordFailure(observation, error);
    throw error;
  } finally {
    if (model) observation.attributes.push(attribute('langfuse.observation.model.name', model));
    observation.endTimeUnixNano = now();
    trace.spans.push(observation);
  }
}

const chat = document.querySelector('#chat');
const composer = document.querySelector('#composer');
const question = document.querySelector('#question');
const send = document.querySelector('#send');
const messages = document.querySelector('#messages');
const errorNotice = document.querySelector('#chat-error');
const welcome = document.querySelector('#welcome');
const conversation = document.querySelector('#conversation');
const exchanges = [];
const exchangeLimit = 10;
let activeRequest;

function updateLayout() {
  const hasMessages = messages.childElementCount > 0;
  welcome.hidden = hasMessages;
  conversation.hidden = !hasMessages;
  chat.classList.toggle('has-messages', hasMessages);
}

function showError(message = '') {
  errorNotice.textContent = message;
  errorNotice.hidden = !message;
}

function appendInline(element, text) {
  for (const [index, part] of text.split(/(\*\*[^*\n]+\*\*|__[^_\n]+__)/g).entries()) {
    if (index % 2 === 0) {
      element.append(part);
    } else {
      const bold = document.createElement('strong');
      bold.textContent = part.slice(2, -2);
      element.append(bold);
    }
  }
}

function renderAnswer(content, text) {
  let current;
  for (const line of text.split(/\r?\n/)) {
    const heading = line.match(/^\s*#{1,6}\s+(.+)$/);
    const item = line.match(/^\s*(?:([-*+])|(\d+)[.)])\s+(.+)$/);
    if (!line.trim()) {
      current = undefined;
    } else if (heading) {
      const label = document.createElement('h3');
      appendInline(label, heading[1]);
      content.append(label);
      current = undefined;
    } else if (item) {
      const tag = item[2] ? 'OL' : 'UL';
      if (current?.tagName !== tag) {
        current = document.createElement(tag);
        if (item[2]) current.start = Number(item[2]);
        content.append(current);
      }
      const entry = document.createElement('li');
      appendInline(entry, item[3]);
      current.append(entry);
    } else {
      if (current?.tagName !== 'P') {
        current = document.createElement('p');
        content.append(current);
      } else {
        current.append('\n');
      }
      appendInline(current, line);
    }
  }
}

function renderMessage(role, text) {
  const article = document.createElement('article');
  article.className = `message ${role}`;

  article.setAttribute('aria-label', role === 'user' ? 'Pesan kamu' : 'Jawaban asisten');

  const content = document.createElement('div');
  content.className = 'message-content';
  if (role === 'assistant') renderAnswer(content, text);
  else content.textContent = text;

  article.append(content);
  return article;
}

function renderSources(sources) {
  const section = document.createElement('div');
  section.className = 'source-list';

  for (const source of sources) {
    const details = document.createElement('details');
    const label = document.createElement('summary');
    const location = [source.name, source.page ? `hlm. ${source.page}` : '', source.heading]
      .filter(Boolean).join(' · ');
    label.textContent = `[${source.id}]`;
    label.setAttribute('aria-label', `Sumber ${source.id} · ${location}`);

    const title = document.createElement('p');
    title.className = 'source-title';
    title.textContent = location;

    const excerpt = document.createElement('blockquote');
    excerpt.textContent = source.text;
    details.append(label, title, excerpt);
    section.append(details);
  }

  return section;
}

function setBusy(busy) {
  send.disabled = busy;
  send.setAttribute('aria-label', busy ? 'Sedang menjawab' : 'Kirim');
}

async function readAnswer(response, showProgress) {
  if (!response.ok || !response.headers.get('Content-Type')?.includes('application/x-ndjson')) {
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Jawaban tidak tersedia. Silakan coba lagi.');
    return data;
  }

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let remaining = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      const lines = (remaining + (value ?? '')).split('\n');
      remaining = done ? '' : lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        if (event.type === 'progress' && typeof event.label === 'string') showProgress(event.label);
        if (event.type === 'error') throw new Error(event.error || 'Jawaban tidak tersedia. Silakan coba lagi.');
        if (event.type === 'answer') return event;
      }
      if (done) throw new Error('Jawaban terputus. Silakan coba lagi.');
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

question.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    composer.requestSubmit();
  }
});

composer.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (activeRequest) return;

  const content = question.value.trim();
  if (!content) {
    showError('Tulis pertanyaan untuk memulai.');
    question.focus();
    return;
  }

  const request = new AbortController();
  activeRequest = request;
  const userMessage = { role: 'user', content };
  const userArticle = renderMessage('user', content);
  const pending = renderMessage('assistant', '');
  pending.classList.add('pending');
  const progress = pending.querySelector('.message-content');
  progress.setAttribute('role', 'status');
  const indicator = document.createElement('span');
  indicator.setAttribute('aria-hidden', 'true');
  indicator.textContent = '…';
  progress.append(indicator);

  showError();
  messages.append(userArticle, pending);
  question.value = '';
  setBusy(true);
  updateLayout();
  pending.scrollIntoView({ block: 'nearest' });

  try {
    const history = exchanges.flatMap((exchange) => exchange.history);
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
      body: JSON.stringify({ messages: [...history, userMessage] }),
      signal: request.signal,
    });
    const data = await readAnswer(response, (label) => {
      if (activeRequest === request) progress.textContent = label;
    });
    if (activeRequest !== request) return;

    const assistantArticle = renderMessage('assistant', data.answer);
    if (data.sources?.length) assistantArticle.append(renderSources(data.sources));
    const followAnswer = pending.getBoundingClientRect().top < window.innerHeight;
    pending.replaceWith(assistantArticle);
    exchanges.push({
      articles: [userArticle, assistantArticle],
      history: [userMessage, { role: 'assistant', content: data.answer }],
    });
    if (exchanges.length > exchangeLimit) {
      for (const article of exchanges.shift().articles) article.remove();
    }
    if (followAnswer && assistantArticle.getBoundingClientRect().top > window.innerHeight - 160) {
      assistantArticle.scrollIntoView({ block: 'start' });
    }
  } catch (error) {
    if (activeRequest !== request) return;
    userArticle.remove();
    pending.remove();
    if (!question.value) question.value = content;
    showError(error instanceof SyntaxError || error instanceof TypeError
      ? 'Asisten tidak dapat dihubungi. Silakan coba lagi.'
      : error.message);
    updateLayout();
  } finally {
    if (activeRequest === request) {
      activeRequest = undefined;
      setBusy(false);
    }
  }
});

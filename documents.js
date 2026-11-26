import { extname } from 'node:path';
import { marked } from 'marked';
import { PDFParse } from 'pdf-parse';

export class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const maxPages = 300;
const maxChunks = 400;
const chunkSize = 1250;
const overlap = 160;

function normalize(text) {
  return text.normalize('NFC').replace(/\u00ad/g, '').replace(/\r\n?/g, '\n')
    .replace(/[\t\u00a0]+/g, ' ').replace(/^ +| +$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
}

function markdownSections(buffer) {
  let markdown;
  try {
    markdown = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw new RequestError(422, 'Save the Markdown file with UTF-8 encoding.');
  }
  if (/\p{Cc}/u.test(markdown.replace(/[\t\n\r]/g, ''))) {
    throw new RequestError(422, 'The Markdown file contains unreadable characters.');
  }

  const source = markdown.replace(/\r\n?/g, '\n')
    .replace(/^---\s*\n[\s\S]*?\n(?:---|\.\.\.)[ \t]*(?:\n|$)/, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  const sections = [];
  const headings = [];
  let lines = [];
  function finishSection() {
    const text = normalize(lines.join(''));
    if (text) sections.push({ heading: headings.filter(Boolean).join(' › ').slice(0, 240), text });
    lines = [];
  }
  for (const token of marked.lexer(source)) {
    if (token.type === 'heading') {
      finishSection();
      headings.length = token.depth - 1;
      headings.push(token.text.trim());
    } else {
      lines.push(token.raw);
    }
  }
  finishSection();
  if (!sections.length && headings.some(Boolean)) {
    sections.push({ text: normalize(source) });
  }
  return sections;
}

async function pdfSections(buffer) {
  if (!buffer.subarray(0, 1024).includes('%PDF-')) {
    throw new RequestError(422, 'This file is not a valid PDF.');
  }
  const parser = new PDFParse({ data: new Uint8Array(buffer), isEvalSupported: false });
  try {
    const result = await parser.getText({ first: maxPages + 1 });
    if (result.total > maxPages) throw new RequestError(422, `PDFs are limited to ${maxPages} pages.`);
    return result.pages.map(({ num, text }) => ({ page: num, text: normalize(text) }));
  } catch (error) {
    if (error instanceof RequestError) throw error;
    throw new RequestError(422, 'Could not read the PDF. Check whether the file is damaged or password-protected.');
  } finally {
    await parser.destroy();
  }
}

function* splitText(text) {
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + chunkSize);
    if (end < text.length) {
      const window = text.slice(start, end);
      for (const separator of ['\n\n', '\n', '. ', ' ']) {
        const boundary = window.lastIndexOf(separator);
        if (boundary < chunkSize * 0.65) continue;
        end = start + boundary + separator.length;
        break;
      }
    }
    const part = text.slice(start, end).trim();
    if (part) yield part;
    if (end === text.length) break;
    const nextWord = text.slice(end - overlap, end).indexOf(' ');
    start = end - overlap + nextWord + 1;
  }
}

export async function preprocessDocument(name, buffer) {
  const type = extname(name).toLowerCase().slice(1);
  if (type !== 'md' && type !== 'pdf') throw new RequestError(415, 'Choose a .md or .pdf file.');

  const sections = type === 'pdf' ? await pdfSections(buffer) : markdownSections(buffer);
  const chunks = [];
  let emptyPages = 0;
  for (const { text, ...location } of sections) {
    if (!text) {
      emptyPages += 1;
      continue;
    }
    for (const part of splitText(text)) {
      chunks.push({ ...location, text: part });
      if (chunks.length > maxChunks) {
        throw new RequestError(422, 'The document is too long. Split it into smaller files.');
      }
    }
  }
  if (!chunks.length) {
    throw new RequestError(422, type === 'pdf'
      ? 'This PDF contains no readable text. Run OCR on the scan or upload a Markdown version.'
      : 'The Markdown file contains no text.');
  }
  return { type, chunks, emptyPages };
}

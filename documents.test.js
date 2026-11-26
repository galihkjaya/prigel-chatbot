import assert from 'node:assert/strict';
import test from 'node:test';
import { preprocessDocument } from './documents.js';

// Tiny text PDF, including a valid cross-reference table, so the test runs offline.
function makePdf(lines) {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Count ' + lines.length + ' /Kids [' + lines.map((_, i) => (4 + i * 2) + ' 0 R').join(' ') + '] >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  for (const line of lines) {
    const content = line ? 'BT /F 12 Tf 50 700 Td (' + line + ') Tj ET' : '';
    objects.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F 3 0 R >> >> /Contents ' + (objects.length + 2) + ' 0 R >>',
      '<< /Length ' + content.length + ' >>\nstream\n' + content + '\nendstream');
  }
  let pdf = '%PDF-1.4\n';
  const offsets = ['0000000000 65535 f '];
  for (const [index, value] of objects.entries()) {
    offsets.push(String(pdf.length).padStart(10, '0') + ' 00000 n ');
    pdf += (index + 1) + ' 0 obj\n' + value + '\nendobj\n';
  }
  const xref = pdf.length;
  pdf += 'xref\n0 ' + offsets.length + '\n' + offsets.join('\n') + '\ntrailer\n<< /Size ' + offsets.length + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF';
  return Buffer.from(pdf);
}

test('preserves Markdown heading paths, overlapping text and meaningful paragraph boundaries', async () => {
  const source = '---\ninternal: draft\n---\n# Magang\n## Logbook\n' +
    Array.from({length: 220}, (_, i) => 'Kegiatan' + i).join(' ') + '\n\n## Laporan\nLampirkan ringkasan.';
  const { chunks } = await preprocessDocument('Pedoman.MD', Buffer.from(source));
  assert.ok(chunks.length > 2);
  assert.equal(chunks[0].heading, 'Magang › Logbook');
  assert.ok(chunks[0].text.includes(chunks[1].text.split(' ').slice(0, 3).join(' ')));
  assert.equal(chunks.at(-1).heading, 'Magang › Laporan');
  assert.ok(chunks.every(chunk => chunk.text.length <= 1250 && !chunk.text.includes('internal:')));
});

test('retains original PDF page numbers and reports pages without extractable text', async () => {
  const { chunks, emptyPages } = await preprocessDocument('Pedoman.pdf', makePdf(['Isi logbook.', '', 'Contoh lampiran.']));
  assert.deepEqual(chunks.map(({page, text}) => [page, text]), [[1, 'Isi logbook.'], [3, 'Contoh lampiran.']]);
  assert.equal(emptyPages, 1);
  await assert.rejects(preprocessDocument('Pindai.pdf', makePdf([''])), /OCR/);
});

test('rejects unsupported or unreadable uploads', async () => {
  await assert.rejects(preprocessDocument('doc.txt', Buffer.from('text')), {status: 415});
  await assert.rejects(preprocessDocument('doc.pdf', Buffer.from('broken')), {status: 422});
  await assert.rejects(preprocessDocument('empty.md', Buffer.from('  ')), {status: 422});
  await assert.rejects(preprocessDocument('binary.md', Buffer.from([255, 255])), {status: 422});
});


import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { auditKnowledgeBrief } from '../audit.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repo = resolve(__dirname, '..', '..');

const valid = `
<!doctype html><html lang="id"><head><meta name="teaser" content="Strategi perlu diuji seperti hipotesis."></head><body>
<p class="dek">Edisi ini menambat strategi pada bukti, bukan keyakinan awal.</p>
<div class="seconds"><div class="blk-k">60 detik</div><ul><li>Satu konsep utama mengikat keputusan.</li><li>Satu konsep pembanding mencegah salah pakai.</li><li>Satu konsep praktik menurunkannya ke rapat.</li></ul><p class="act"><b>Ide untuk dibawa ke rapat:</b> tulis bukti pembatal sebelum anggaran dikunci.</p></div>
<section class="trigger"><div class="blk-k">Business Trigger</div><p>Tekanan keputusan pada BUMN dan AI membuat strategi perlu dibaca sebagai hipotesis.</p><div class="field"><span class="fk">Mengapa konsep ini dipilih</span><p>Konsep ini membantu membaca kapan target berubah menjadi pembelaan proyek.</p></div></section>
<section class="knowledge-matrix"><div class="blk-k">Knowledge Matrix</div><table><tr><th>Layer</th><th>Isi</th></tr><tr><td>Konsep utama</td><td>Strategi sebagai hipotesis</td></tr></table></section>
<section class="relationship"><div class="blk-k">Concept Relationship</div><p>Hipotesis menjelaskan asumsi, target menjadi pembanding, dan review cadence menjadi mekanisme praktik.</p></section>
<section class="application-matrix"><div class="blk-k">Application Matrix</div><table><tr><th>Konteks</th><th>Pakai untuk</th></tr><tr><td>Rapat capex</td><td>Menulis bukti pembatal.</td></tr></table></section>
<section class="learn-next"><div class="blk-k">Learn Next</div><ul><li>Decision rights</li><li>Pre-mortem</li></ul></section>
<section class="thesis">
  <p class="thesis-pos"><b>Thesis.</b> Strategi yang sehat ditulis sebagai hipotesis yang punya sinyal pembukti dan sinyal pembatal.</p>
  <div class="thesis-objection"><span class="fk">Keberatan terbaik</span><p>Organisasi juga membutuhkan komitmen, bukan eksperimen tanpa batas.</p></div>
  <div class="thesis-falsify"><span class="fk">Kapan tesis ini gugur</span><p>Tesis ini gugur bila perubahan indikator tidak mengubah keputusan modal.</p></div>
</section>
<section class="diagnostic">
  <div class="field"><span class="fk">Salah kaprah</span><p>Strategi sering disamakan dengan target.</p></div>
  <div class="field"><span class="fk">Gap lapangan</span><p>Rapat menyetujui proyek tanpa menyebut sinyal pembatal.</p></div>
  <div class="field"><span class="fk">Pertanyaan diagnosis</span><p>Bukti apa yang membuat keputusan diubah?</p></div>
  <div class="field"><span class="fk">Jangan pakai konsep ini jika</span><p>Keputusan kecil dan murah lebih baik diuji cepat.</p></div>
</section>
</body></html>`;

test('audit accepts complete production brief', () => {
  assert.doesNotThrow(() => auditKnowledgeBrief(valid));
});

test('audit rejects dry-run placeholder', () => {
  assert.throws(() => auditKnowledgeBrief(valid.replace('Strategi perlu diuji', 'DRAF DRY-RUN')), /dry-run marker/);
});

test('audit rejects unresolved VERIFY in production', () => {
  assert.throws(() => auditKnowledgeBrief(valid.replace('bukti', 'VERIFY')), /VERIFY/);
});

test('audit allows VERIFY only outside production', () => {
  assert.doesNotThrow(() => auditKnowledgeBrief(valid.replace('bukti', 'VERIFY'), { production: false }));
});

test('audit rejects missing falsification clause', () => {
  assert.throws(() => auditKnowledgeBrief(valid.replace('Kapan tesis ini gugur', 'Catatan')), /falsification/);
});

test('audit rejects brief without field gap discipline', () => {
  assert.throws(() => auditKnowledgeBrief(valid.replace('Gap lapangan', 'Catatan lapangan')), /field gap/);
});

test('audit rejects utopian language', () => {
  assert.throws(() => auditKnowledgeBrief(valid.replace('bukti, bukan keyakinan awal', 'game changer bagi semua organisasi')), /utopian/);
});

test('audit rejects duplicate visible numbering', () => {
  assert.throws(() => auditKnowledgeBrief(valid.replace('</body>', '<span class="item-num">1</span></body>')), /duplicate visible numbering/);
});

test('audit rejects missing trigger rationale', () => {
  assert.throws(() => auditKnowledgeBrief(valid.replace('Mengapa konsep ini dipilih', 'Catatan konsep')), /concept selection/);
});

test('audit rejects missing knowledge matrix', () => {
  assert.throws(() => auditKnowledgeBrief(valid.replace('Knowledge Matrix', 'Knowledge Notes')), /knowledge matrix/);
});

test('published editions pass production audit', () => {
  const dir = join(repo, 'briefs');
  const files = readdirSync(dir).filter((name) => /^\d{4}-\d{2}-\d{2}\.html$/.test(name));
  assert.ok(files.length > 0, 'at least one published edition is required');
  for (const file of files) {
    const html = readFileSync(join(dir, file), 'utf8');
    assert.doesNotThrow(() => auditKnowledgeBrief(html), file);
  }
});

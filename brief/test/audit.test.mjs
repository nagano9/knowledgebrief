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
<section class="thesis">
  <p class="thesis-pos"><b>Thesis.</b> Strategi yang sehat ditulis sebagai hipotesis yang punya sinyal pembukti dan sinyal pembatal.</p>
  <div class="thesis-objection"><span class="fk">Keberatan terbaik</span><p>Organisasi juga membutuhkan komitmen, bukan eksperimen tanpa batas.</p></div>
  <div class="thesis-falsify"><span class="fk">Kapan tesis ini gugur</span><p>Tesis ini gugur bila perubahan indikator tidak mengubah keputusan modal.</p></div>
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

test('published editions pass production audit', () => {
  const dir = join(repo, 'briefs');
  const files = readdirSync(dir).filter((name) => /^\d{4}-\d{2}-\d{2}\.html$/.test(name));
  assert.ok(files.length > 0, 'at least one published edition is required');
  for (const file of files) {
    const html = readFileSync(join(dir, file), 'utf8');
    assert.doesNotThrow(() => auditKnowledgeBrief(html), file);
  }
});

export class AuditError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AuditError';
  }
}

export function stripTagsForAudit(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

export function auditKnowledgeBrief(html, options = {}) {
  const text = stripTagsForAudit(html);
  const failures = [];
  const production = options.production !== false;

  if (!/<meta\s+name=["']teaser["']/i.test(html)) failures.push('missing teaser meta');
  if (!/<p\s+class=["']dek["']>/i.test(html)) failures.push('missing dek');
  if (!/class=["']thesis/.test(html)) failures.push('missing thesis section');
  if (!/Kapan tesis ini gugur/i.test(text)) failures.push('missing falsification clause');
  if (!/Keberatan terbaik/i.test(text)) failures.push('missing strongest objection');
  if (!/Salah kaprah/i.test(text)) failures.push('missing misconception block');
  if (!/Gap lapangan/i.test(text)) failures.push('missing field gap block');
  if (!/Pertanyaan diagnosis/i.test(text)) failures.push('missing diagnostic question');
  if (!/(?:Jangan pakai konsep ini jika|Kapan konsep ini tidak berlaku)/i.test(text)) failures.push('missing boundary-of-use block');
  if (!/Dipicu oleh/i.test(text)) failures.push('missing trigger block');
  if (!/Mengapa konsep ini dipilih/i.test(text)) failures.push('missing concept selection rationale');
  if (/<span\s+class=["']item-num["']/i.test(html)) failures.push('duplicate visible numbering');

  const productionBanned = [
    { name: 'dry-run marker', pattern: /\b(?:DRAF|DRY-RUN|dry-run|Kerangka dry-run)\b/i },
    { name: 'placeholder marker', pattern: /(?:Bullet\s+\d|isi satu ide|posisi satu-dua kalimat|klausa falsifikasi|Cth ilustrasi|<isi|&lt;isi)/i },
    { name: 'utopian language', pattern: /\b(?:revolusioner|transformasional|game changer|mengubah segalanya|solusi untuk semua|peluang tanpa batas|masa depan yang cerah)\b/i },
    { name: 'motivational filler', pattern: /\b(?:terus berinovasi|berpikir out of the box|menjadi lebih baik lagi|langkah nyata menuju kesuksesan)\b/i },
  ];
  const alwaysBanned = [
    { name: 'em dash', pattern: /—/ },
    { name: 'generic opening', pattern: /\b(?:Pada era yang terus berubah|Perlu dicatat bahwa|Dalam lanskap|Di tengah dinamika)\b/i },
    { name: 'mechanical list framing', pattern: /\b(?:tiga konsep utama|3 konsep utama|berikut adalah|berikut ini adalah)\b/i },
  ];
  for (const rule of alwaysBanned) {
    if (rule.pattern.test(text) || rule.pattern.test(html)) failures.push(rule.name);
  }
  for (const rule of production ? productionBanned : []) {
    if (rule.pattern.test(text) || rule.pattern.test(html)) failures.push(rule.name);
  }

  if (production && /\bVERIFY\b/i.test(text)) {
    failures.push('unresolved VERIFY marker in production');
  }

  if (failures.length > 0) {
    throw new AuditError('KnowledgeBrief audit failed: ' + failures.join('; '));
  }
}

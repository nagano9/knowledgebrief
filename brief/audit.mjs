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

  const productionBanned = [
    { name: 'dry-run marker', pattern: /\b(?:DRAF|DRY-RUN|dry-run|Kerangka dry-run)\b/i },
    { name: 'placeholder marker', pattern: /(?:Bullet\s+\d|isi satu ide|posisi satu-dua kalimat|klausa falsifikasi|Cth ilustrasi|<isi|&lt;isi)/i },
  ];
  const alwaysBanned = [
    { name: 'em dash', pattern: /—/ },
    { name: 'generic opening', pattern: /\b(?:Pada era yang terus berubah|Perlu dicatat bahwa|Dalam lanskap|Di tengah dinamika)\b/i },
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

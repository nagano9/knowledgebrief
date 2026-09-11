// Knowledge Brief generator (runner) - STATEFUL
// Garis besar: baca kalender kurikulum + ledger + arsip, pilih topik hari kerja,
// lalu minta LLM menulis SATU dokumen HTML edisi per kontrak prompt.md.
// Mode --dry-run membangun kerangka HTML tanpa LLM (uji struktur/desain/CSS).
//
//   node generate.mjs              -> jalankan penuh (butuh DEEPSEEK_API_KEY)
//   node generate.mjs --dry-run    -> tanpa LLM, bangun kerangka & plumb bekas
//   KB_DATE=YYYY-MM-DD ...         -> paksa tanggal (tes)
//
// Keluaran: ../briefs/<YYYY-MM-DD>.html + update manifest.json, index.html, ledger.

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AuditError, auditKnowledgeBrief } from './audit.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENGINE = __dirname;
const REPO = resolve(__dirname, '..');
const BRIEFS = join(REPO, 'briefs');
const ASSETS = join(REPO, 'assets');
const VISUALS = join(ASSETS, 'visuals');
const LEDGER_DIR = join(ENGINE, 'ledger');
const STATE_FILE = join(ENGINE, 'rotation-state.json');
const TOPICS_FILE = join(ENGINE, 'topics.json');
const PROMPT_FILE = join(ENGINE, 'prompt.md');
const CSS_FILE = join(ENGINE, 'template.css');
const ARCHIVE_FILE = join(LEDGER_DIR, 'archive.jsonl');
const LEDGER_FILE = join(LEDGER_DIR, 'ledger.json');
const SITE_URL = 'https://knowledgebrief.id';

const DEEPSEEK = process.env.DEEPSEEK_API_KEY || '';
const OPENAI = process.env.OPENAI_API_KEY || '';
const MODEL = process.env.BRIEF_MODEL || 'deepseek-v4-flash';
const MAX_TOKENS = Number(process.env.BRIEF_MAX_TOKENS || 24000);
const IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1';
const IMAGE_SIZE = process.env.OPENAI_IMAGE_SIZE || '1536x1024';
const IMAGE_QUALITY = process.env.OPENAI_IMAGE_QUALITY || 'high';
const DRY = process.argv.includes('--dry-run');
const WIB_ONLY = process.env.KB_MODE !== 'utc';

const WD = ['Minggu','Senin','Selasa','Rabu','Kamis','Jumat','Sabtu'];

function jakartaNow(){
  const nowReal = new Date();
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta', year:'numeric', month:'2-digit', day:'2-digit', weekday:'short', hour:'2-digit', minute:'2-digit', hour12:false });
  const parts = {}; for(const p of f.formatToParts(nowReal)) parts[p.type] = p.value;
  const dateISO = parts.year + '-' + parts.month + '-' + parts.day;
  const wdMap = { Mon:0, Tue:1, Wed:2, Thu:3, Fri:4, Sat:5, Sun:6 };
  const wdIdx = (wdMap[parts.weekday] ?? 6); // 0=Senin..6=Minggu
  return { dateISO, hour: parseInt(parts.hour,10), minute: parseInt(parts.minute,10), wdIdx };
}
let jk = jakartaNow();
if (process.env.KB_DATE && /^\d{4}-\d{2}-\d{2}$/.test(process.env.KB_DATE)){
  const forced = process.env.KB_DATE;
  const dArr = forced.split('-').map(Number);
  const jsDay = new Date(Date.UTC(dArr[0], dArr[1]-1, dArr[2])).getUTCDay(); // 0=Sun
  jk = { dateISO: forced, hour: 5, minute: 30, wdIdx: (jsDay + 6) % 7 }; // 0=Senin..6=Minggu
}
const dateStr = jk.dateISO;
const iso = dateStr + 'T' + String(jk.hour).padStart(2,'0') + ':' + String(jk.minute).padStart(2,'0') + ':00+07:00';
const weekday = WD[(jk.wdIdx + 1) % 7]; // WD sun-first: 0=Minggu..6=Sabtu
const pretty = new Intl.DateTimeFormat('id-ID', { timeZone:'Asia/Jakarta', weekday:'long', day:'numeric', month:'long', year:'numeric' }).format(new Date(iso));

function json(path, fallback){ if(!existsSync(path)) return fallback; try{ return JSON.parse(readFileSync(path,'utf8')); } catch(e){ return fallback; } }
function escapeHtml(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function escapeXml(s){ return escapeHtml(s).replace(/'/g, '&apos;'); }
function isWorkingDay(w){ return w!=='Sabtu' && w!=='Minggu'; }
function uid(){ return Date.now().toString(36) + Math.random().toString(36).slice(2,6); }
function absUrl(pathname){ return SITE_URL + pathname; }

// ---------- topik round-robin per bucket ----------
function pickTopic(cfg, state, wd){
  const keyMaps = { 'senin':'Senin','selasa':'Selasa','rabu':'Rabu','kamis':'Kamis','jumat':'Jumat' };
  const buckets = cfg.bucketByWeekday || {};
  // mbak hari: bucket diindeks nama hari kecil (key) -> slug list
  // tentukan kunci bucket utk tanggal ini
  const mapToKey = { 'Senin':'senin','Selasa':'selasa','Rabu':'rabu','Kamis':'kamis','Jumat':'jumat','Sabtu':null,'Minggu':null };
  const bucketSel = mapToKey[wd];
  if (!bucketSel) return null;
  const slugs = buckets[bucketSel] || [];
  if (!slugs.length) return null;
  state.counts = state.counts || {};
  const idx = state.counts[bucketSel] || 0;
  const slug = slugs[idx % slugs.length];
  return { slug, key: bucketSel, idx };
}

function advanceState(state, sel){
  state.counts = state.counts || {};
  state.counts[sel.key] = ((state.counts[sel.key]||0) + 1);
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

// ---------- gathering opsional konteks (tidak wajib) ----------
async function tavilySearch(q){
  const TAVILY = process.env.TAVILY_API_KEY || ''; if (!TAVILY) return [];
  const res = await fetch('https://api.tavily.com/search',{ method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ api_key:TAVILY, query:q, max_results:5, search_depth:'basic', include_answer:false }), signal:AbortSignal.timeout(30000) });
  if(!res.ok) return []; const d = await res.json();
  return (d.results||[]).map(function(r){ return { title:r.title, link:r.url, snippet:String(r.content||'').slice(0,300) }; });
}
async function contextFor(topic){
  if (DRY) return '';
  const q = (topic && topic.title ? topic.title : '') + (topic && topic.coreConcept ? ' - ' + topic.coreConcept : '');
  if (!q) return '';
  const sel = process.env.TAVILY_API_KEY ? await tavilySearch(q) : [];
  return sel.map(function(r,i){ return (i+1)+'. '+r.title+'\n   '+r.link+'\n   '+r.snippet; }).join('\n\n');
}

function stripPublicHtml(s){
  return stripHtml(String(s || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' '));
}

async function fetchPublicSignal(name, url){
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(25000) });
    if (!res.ok) return name + ': tidak tersedia saat generate.';
    const text = stripPublicHtml(await res.text()).slice(0, 2200);
    return name + ' (' + url + '):\n' + text;
  } catch (e) {
    return name + ': tidak tersedia saat generate.';
  }
}

async function groundingContext(){
  if (DRY) return '';
  const ecosystemSignals = await Promise.all([
    fetchPublicSignal('DailyBrief.id', 'https://dailybrief.id/'),
    fetchPublicSignal('LeaderBrief.id', 'https://leaderbrief.id/')
  ]);
  const businessQuery = [
    'Indonesia business macro regulation AI energy finance risk',
    topicSafeTitle()
  ].filter(Boolean).join(' ');
  const businessSignals = process.env.TAVILY_API_KEY ? await tavilySearch(businessQuery) : [];
  const businessText = businessSignals.length
    ? 'Business context:\n' + businessSignals.map(function(r,i){ return (i+1)+'. '+r.title+'\n   '+r.link+'\n   '+r.snippet; }).join('\n\n')
    : 'Business context: gunakan pengetahuan durable dari TOPIK_HARI_INI bila sinyal eksternal tidak tersedia.';
  return ecosystemSignals.concat([businessText]).join('\n\n');
}

function topicSafeTitle(){
  try {
    const cfg = json(TOPICS_FILE, {});
    const state = json(STATE_FILE, { counts: {} });
    const sel = pickTopic(cfg, state, weekday);
    const topics = cfg.topics || [];
    const topic = sel ? topics.find(function(t){ return t.slug===sel.slug; }) : null;
    return topic ? [topic.title, topic.coreConcept, topic.pillar].filter(Boolean).join(' ') : '';
  } catch (e) {
    return '';
  }
}

// ---------- call LLM ----------
async function callDeepSeek(promptText, topic){
  const ledger = json(LEDGER_FILE, { concepts: [] });
  const recent = (ledger.concepts || []).slice(-5).reverse()
    .map(function(c){ return ' - ['+(c.date||'')+'] '+(c.title||c.slug||'')+(c.lens? ' ('+c.lens+')':''); }).join('\n') || '(belum ada)';
  const sys = 'Anda adalah editor dan information designer Knowledge Brief: kurator intelektual harian untuk manajer eksekutif dan Subject Matter Expert. Kaliber jelas bagi manajer yang naik level dan dalam bagi SME; jujur terhadap ketidakpastian; Bahasa Indonesia eksekutif natural. Ikuti kontrak editorial dan kontrak HTML pada prompt pengguna.';
  const user = [
    'TANGGAL: ' + pretty + ' (' + dateStr + ')',
    '',
    '=== TOPIK HARI INI ===',
    'Slug: ' + topic.slug,
    'Judul: ' + topic.title,
    'Pilar: ' + (topic.pillar || ''),
    'Model/Framework: ' + (topic.model || ''),
    'Konsep inti: ' + (topic.coreConcept || ''),
    '',
    '=== MEMORI (LEDGER) - konsep yang sudah dijelaskan edisi lalu (JANGAN jelaskan ulang penuh; rujuk dan fokus penerapan/geseran baru) ===',
    recent,
    '',
    promptText,
    '',
    'AUDIT GATE: output produksi akan ditolak bila memuat DRAF, DRY-RUN, placeholder, em dash, VERIFY yang belum diselesaikan, bahasa utopis, nomor ganda item-num, tesis tanpa keberatan terbaik, tesis tanpa klausa falsifikasi, edisi tanpa Business Trigger, Mengapa konsep ini dipilih, Knowledge Matrix, Concept Relationship, Application Matrix, Learn Next, Salah kaprah, Gap lapangan, Pertanyaan diagnosis, Jangan pakai konsep ini jika, kolom Red flag, atau class field danger pada blok negatif.',
    '',
    'Tulis HTML lengkap sekarang. Kembalikan HANYA HTML (tanpa fence markdown, tanpa komentar).'
  ].join('\n');
  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST', headers: { 'Content-Type':'application/json', 'Authorization':'Bearer ' + DEEPSEEK },
    body: JSON.stringify({ model:MODEL, messages:[{role:'system',content:sys},{role:'user',content:user}], temperature:0.4, max_tokens:MAX_TOKENS, stream:false }),
    signal: AbortSignal.timeout(420000)
  });
  if (!res.ok){ const b=await res.text(); throw new Error('DeepSeek HTTP '+res.status+': '+b.slice(0,300)); }
  const data = await res.json();
  const choice = data.choices && data.choices[0];
  if (choice && choice.finish_reason && !['stop', 'end_turn'].includes(choice.finish_reason)) {
    throw new Error('DeepSeek output incomplete: finish_reason=' + choice.finish_reason + '. Increase BRIEF_MAX_TOKENS or reduce prompt size.');
  }
  let html = (choice && choice.message && choice.message.content) || '';
  html = html.replace(/^\s*\x60\x60\x60[a-zA-Z]*\s*\n?/, '').replace(/\n?\x60\x60\x60\s*$/, '').trim();
  return html;
}

function stripHtml(s){ return String(s).replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim(); }

function assertCompleteHtml(html, stage) {
  const source = String(html || '').trim();
  const failures = [];
  if (source.length < 2000) failures.push('too short');
  if (!/<\/body>\s*<\/html>\s*$/i.test(source)) failures.push('missing closing body/html');
  if (/<\s*$/.test(source) || /<[^>]{0,80}$/.test(source)) failures.push('ends inside an HTML tag');
  if ((source.match(/<section\b/gi) || []).length !== (source.match(/<\/section>/gi) || []).length) failures.push('unbalanced section tags');
  if ((source.match(/<div\b/gi) || []).length !== (source.match(/<\/div>/gi) || []).length) failures.push('unbalanced div tags');
  if (failures.length) throw new Error(stage + ' incomplete HTML: ' + failures.join(', '));
}

function extractMeta(html){
  const dekM = html.match(/<p class="dek">([\s\S]*?)<\/p>/);
  const lensM = html.match(/<div class="lensa">([\s\S]*?)<\/div>/);
  const teaserM = html.match(/<meta name="teaser" content="([^"]*)">/);
  let lens = lensM ? stripHtml(lensM[1]) : '';
  lens = lens.replace(/^lensa\s*[:\-\u2014]?\s*/i,'').replace(/^\s*Knowledge Brief\s*[-\u2014]\s*/i,'').trim();
  return { dek: dekM ? stripHtml(dekM[1]) : '', lens: lens, teaser: teaserM ? teaserM[1].trim() : '' };
}

function normalizeAuditLanguage(html) {
  return String(html || '')
    .replace(/\bPada era yang terus berubah\b/gi, 'Saat variabel keputusan berubah cepat')
    .replace(/\bPerlu dicatat bahwa\b/gi, '')
    .replace(/\bDalam lanskap\b/gi, 'Dalam kondisi')
    .replace(/\bDi tengah dinamika\b/gi, 'Dalam kondisi')
    .replace(/\btiga konsep utama\b/gi, 'tiga konsep')
    .replace(/\b3 konsep utama\b/gi, 'tiga konsep')
    .replace(/\bberikut ini adalah\b/gi, '')
    .replace(/\bberikut adalah\b/gi, '');
}

function compactText(s, fallback = '') {
  return String(s || fallback || '')
    .replace(/\s+/g, ' ')
    .replace(/[<>]/g, '')
    .trim();
}

function wrapWords(text, limit, maxLines = 3) {
  const words = compactText(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    const next = line ? line + ' ' + word : word;
    if (next.length > limit && line) {
      lines.push(line);
      line = word;
      if (lines.length >= maxLines) break;
    } else {
      line = next;
    }
  }
  if (line && lines.length < maxLines) lines.push(line);
  return lines.length ? lines : [''];
}

function svgLines(text, x, y, opts = {}) {
  const size = opts.size || 24;
  const limit = opts.limit || 30;
  const maxLines = opts.maxLines || 3;
  const weight = opts.weight || 500;
  const fill = opts.fill || '#17191d';
  const family = opts.family || '"Segoe Print","Comic Sans MS","Trebuchet MS",sans-serif';
  return wrapWords(text, limit, maxLines)
    .map(function(line, i) {
      return '<text x="' + x + '" y="' + (y + i * (size + 8)) + '" font-family=' + "'" + family + "'" + ' font-size="' + size + '" font-weight="' + weight + '" fill="' + fill + '">' + escapeXml(line) + '</text>';
    })
    .join('\n');
}

function renderKnowledgeCanvasSvg(topic, meta) {
  const title = compactText(topic.title || topic.slug || 'Knowledge Brief');
  const model = compactText(topic.model || topic.coreConcept || 'Framework');
  const core = compactText(topic.coreConcept || topic.title || 'Konsep inti');
  const pillar = compactText(topic.pillar || 'Decision knowledge');
  const lens = compactText(meta.lens || meta.dek || 'Lensa hari ini');
  const dek = compactText(meta.dek || 'Peta konsep, hubungan, dan batas pemakaian.');
  const dateLabel = pretty;
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" width="1400" height="840" viewBox="0 0 1400 840" role="img" aria-labelledby="title desc">',
    '<title id="title">' + escapeXml(title + ' - Knowledge Canvas') + '</title>',
    '<desc id="desc">' + escapeXml('Visual knowledge canvas for ' + title) + '</desc>',
    '<rect width="1400" height="840" fill="#ffffff"/>',
    '<path d="M64 76 C240 56, 482 70, 660 60 C900 46, 1120 66, 1328 54" fill="none" stroke="#e6e8ee" stroke-width="3" stroke-linecap="round"/>',
    '<text x="72" y="88" font-family="ui-monospace,Consolas,monospace" font-size="22" letter-spacing="3" fill="#7a8290">KNOWLEDGE CANVAS</text>',
    '<text x="1126" y="88" font-family="ui-monospace,Consolas,monospace" font-size="20" fill="#8a92a0">' + escapeXml(dateLabel) + '</text>',
    '<g transform="translate(86 132)">',
    '<path d="M0 0 H1228 Q1260 0 1260 32 V606 Q1260 638 1228 638 H0 Q-32 638 -32 606 V32 Q-32 0 0 0 Z" fill="#fff" stroke="#20242b" stroke-width="3.5"/>',
    '<path d="M-6 12 C250 -8, 420 18, 638 6 C840 -5, 1030 9, 1250 2" fill="none" stroke="#dfe3ec" stroke-width="2"/>',
    '<path d="M382 50 C508 28, 725 24, 874 56 C972 78, 1024 148, 1010 244 C992 366, 832 424, 668 418 C490 412, 336 332, 316 214 C300 118, 330 66, 382 50 Z" fill="#f7fbff" stroke="#1652a0" stroke-width="4" stroke-linecap="round"/>',
    svgLines(title, 386, 136, { size: 46, limit: 24, maxLines: 3, weight: 700, fill: '#11151a', family: 'Georgia,"Times New Roman",serif' }),
    '<text x="426" y="304" font-family="ui-monospace,Consolas,monospace" font-size="21" letter-spacing="2.6" fill="#1652a0">CORE CONCEPT</text>',
    svgLines(core, 426, 345, { size: 27, limit: 34, maxLines: 2, weight: 600, fill: '#1652a0' }),
    '<g transform="translate(54 132)">',
    '<path d="M0 0 C92 -18, 188 -12, 278 8 C318 18, 342 54, 334 102 C326 154, 268 178, 164 176 C70 174, 10 142, -4 92 C-17 44, -4 11, 0 0 Z" fill="#fffaf5" stroke="#b45309" stroke-width="3"/>',
    '<text x="24" y="42" font-family="ui-monospace,Consolas,monospace" font-size="17" letter-spacing="2" fill="#b45309">BUSINESS TRIGGER</text>',
    svgLines(lens, 24, 80, { size: 23, limit: 24, maxLines: 3, fill: '#2b2b2b' }),
    '</g>',
    '<g transform="translate(900 132)">',
    '<path d="M0 10 C78 -10, 218 -6, 306 6 C344 12, 366 44, 360 90 C354 148, 294 176, 188 176 C88 176, 14 142, -2 94 C-16 52, -10 24, 0 10 Z" fill="#f7fff9" stroke="#0e7c66" stroke-width="3"/>',
    '<text x="24" y="42" font-family="ui-monospace,Consolas,monospace" font-size="17" letter-spacing="2" fill="#0e7c66">FRAMEWORK</text>',
    svgLines(model, 24, 80, { size: 23, limit: 24, maxLines: 3, fill: '#21312d' }),
    '</g>',
    '<g transform="translate(94 438)">',
    '<path d="M0 0 H308 V118 H0 Z" fill="#ffffff" stroke="#20242b" stroke-width="2.5"/>',
    '<path d="M18 28 H286 M18 60 H252 M18 92 H220" stroke="#aeb6c4" stroke-width="3" stroke-linecap="round"/>',
    '<text x="18" y="-20" font-family="ui-monospace,Consolas,monospace" font-size="18" letter-spacing="2" fill="#6b7280">THEORY</text>',
    svgLines(pillar, 18, 42, { size: 22, limit: 22, maxLines: 2, fill: '#17191d' }),
    '</g>',
    '<path d="M426 496 C520 458, 664 458, 758 496" fill="none" stroke="#1652a0" stroke-width="4" stroke-linecap="round"/>',
    '<path d="M742 482 L762 496 L738 506" fill="none" stroke="#1652a0" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>',
    '<text x="520" y="548" font-family="ui-monospace,Consolas,monospace" font-size="18" letter-spacing="2" fill="#1652a0">APPLIED APPROACH</text>',
    svgLines(dek, 454, 586, { size: 24, limit: 46, maxLines: 2, fill: '#23272f' }),
    '<g transform="translate(882 438)">',
    '<path d="M0 0 H308 V118 H0 Z" fill="#fff7f7" stroke="#b42318" stroke-width="2.5"/>',
    '<path d="M28 30 L84 86 M84 30 L28 86" stroke="#b42318" stroke-width="6" stroke-linecap="round"/>',
    '<text x="112" y="42" font-family="ui-monospace,Consolas,monospace" font-size="17" letter-spacing="2" fill="#b42318">AVOID</text>',
    '<text x="112" y="78" font-family="Segoe Print,Comic Sans MS,sans-serif" font-size="23" fill="#24272e">salah kaprah</text>',
    '</g>',
    '<path d="M300 322 C404 386, 530 402, 636 394" fill="none" stroke="#20242b" stroke-width="3" stroke-dasharray="9 12" stroke-linecap="round"/>',
    '<path d="M982 322 C892 374, 810 394, 712 394" fill="none" stroke="#20242b" stroke-width="3" stroke-dasharray="9 12" stroke-linecap="round"/>',
    '</g>',
    '<text x="72" y="794" font-family="ui-monospace,Consolas,monospace" font-size="18" fill="#8a92a0">whiteboard visual system · concept → framework → applied approach → boundary</text>',
    '</svg>',
    ''
  ].join('\n');
}

function pngVisualAssetUrl() {
  return '/assets/visuals/' + dateStr + '.png';
}

function svgVisualAssetUrl() {
  return '/assets/visuals/' + dateStr + '.svg';
}

function knowledgeCanvasPrompt(topic, meta) {
  const title = compactText(topic.title || topic.slug || 'Knowledge Brief');
  const model = compactText(topic.model || topic.coreConcept || 'Framework');
  const core = compactText(topic.coreConcept || topic.title || 'Konsep inti');
  const pillar = compactText(topic.pillar || 'Decision knowledge');
  const lens = compactText(meta.lens || meta.dek || 'Lensa hari ini');
  const dek = compactText(meta.dek || 'Peta konsep, hubungan, dan batas pemakaian.');
  return [
    'Create one premium executive whiteboard knowledge visual for KnowledgeBrief.id.',
    '',
    'Subject:',
    'Title: ' + title,
    'Core concept: ' + core,
    'Framework or approach: ' + model,
    'Theory or domain: ' + pillar,
    'Business trigger / lens: ' + lens,
    'Applied interpretation: ' + dek,
    '',
    'Visual style:',
    '- pure clean white background, editorial and premium, not decorative',
    '- hand-drawn marker/whiteboard style, but master-level and precise',
    '- black marker lines with restrained blue accents for core concept, green accents for framework/application, red accents only for avoid/red flag',
    '- use conceptual shapes, arrows, causal loops, small matrices, and boundary markers',
    '- visually explain the relationship: business trigger -> core concept -> framework -> applied approach -> boundary/red flag',
    '- polished consulting-grade whiteboard, like a senior strategy professor explaining the topic',
    '',
    'Composition:',
    '- landscape 3:2 composition',
    '- central concept map, not a poster',
    '- a few short legible labels only; avoid dense paragraphs',
    '- leave generous whitespace',
    '- no stock photo, no people, no cartoon mascots, no 3D render, no gradient blob, no neon, no generic AI dashboard',
    '- avoid fake logos, fake citations, and tiny unreadable text',
    '',
    'Output should feel consistent with a serious knowledge ledger for CEOs, CFOs, policy leaders, and senior professionals.'
  ].join('\n');
}

async function writeOpenAiKnowledgeCanvas(topic, meta) {
  if (!OPENAI || DRY) return '';
  const res = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + OPENAI
    },
    body: JSON.stringify({
      model: IMAGE_MODEL,
      prompt: knowledgeCanvasPrompt(topic, meta),
      size: IMAGE_SIZE,
      quality: IMAGE_QUALITY,
      n: 1
    }),
    signal: AbortSignal.timeout(300000)
  });
  if (!res.ok) {
    const body = await res.text().catch(function(){ return ''; });
    throw new Error('OpenAI image HTTP ' + res.status + ': ' + body.slice(0, 300));
  }
  const data = await res.json();
  const b64 = data && data.data && data.data[0] && data.data[0].b64_json;
  if (!b64) throw new Error('OpenAI image response missing b64_json');
  mkdirSync(VISUALS, { recursive: true });
  writeFileSync(join(VISUALS, dateStr + '.png'), Buffer.from(b64, 'base64'));
  return pngVisualAssetUrl();
}

async function writeKnowledgeCanvas(topic, meta) {
  mkdirSync(VISUALS, { recursive: true });
  try {
    const png = await writeOpenAiKnowledgeCanvas(topic, meta);
    if (png) return png;
  } catch (e) {
    console.error('OpenAI visual generation failed; publishing without visual: ' + (e && e.message ? e.message : e));
  }
  return '';
}

function insertKnowledgeCanvas(html, topic, visualUrl) {
  if (!visualUrl) return html;
  if (/class=["'][^"']*\bknowledge-canvas\b/i.test(html)) return html;
  const alt = 'Knowledge canvas: ' + compactText(topic.title || topic.slug || 'Knowledge Brief');
  const block = [
    '<figure class="knowledge-canvas">',
    '<img src="' + escapeHtml(visualUrl) + '" alt="' + escapeHtml(alt) + '" loading="lazy" decoding="async">',
    '<figcaption>Visual knowledge layer: peta konsep, framework, pendekatan terapan, dan batas pemakaian.</figcaption>',
    '</figure>'
  ].join('\n');
  if (/<p\s+class=["']dek["'][^>]*>[\s\S]*?<\/p>/i.test(html)) {
    return html.replace(/(<p\s+class=["']dek["'][^>]*>[\s\S]*?<\/p>)/i, '$1\n' + block);
  }
  return block + '\n' + html;
}

function updateLedger(topic, meta){
  if (!existsSync(LEDGER_FILE)) return;
  const ledger = json(LEDGER_FILE, { concepts: [] });
  ledger.concepts = ledger.concepts || [];
  const entry = { uid: uid(), date: dateStr, slug: topic.slug, title: topic.title, pillar: topic.pillar||'', lens: meta.lens, dek: meta.dek };
  ledger.concepts.push(entry);
  ledger.updated = dateStr;
  writeFileSync(LEDGER_FILE, JSON.stringify(ledger, null, 2) + '\n', 'utf8');
  try { appendFileSync(ARCHIVE_FILE, JSON.stringify(entry) + '\n', 'utf8'); } catch(e){}
}

// ---------- templating / inject ----------
function injectTemplate(html, visualUrl){
  const css = readFileSync(CSS_FILE, 'utf8');
  const styleTag = '<style>\n' + css + '\n</style>';
  const meta = extractMeta(html);
  const title = escapeHtml((meta.lens || meta.dek || 'Knowledge Brief').slice(0, 80) + ' | KnowledgeBrief.id');
  const description = escapeHtml((meta.dek || meta.teaser || 'Kurasi pengetahuan harian untuk manajer eksekutif dan Subject Matter Expert.').slice(0, 160));
  const seo = [
    '<title>' + title + '</title>',
    '<meta name="description" content="' + description + '">',
    '<meta name="robots" content="index,follow,max-image-preview:large">',
    '<link rel="canonical" href="' + absUrl('/briefs/' + dateStr + '.html') + '">',
    '<link rel="icon" href="/favicon.svg" type="image/svg+xml">',
    '<link rel="manifest" href="/site.webmanifest">',
    '<meta name="theme-color" content="#1652a0">',
    '<meta property="og:type" content="article">',
    '<meta property="og:title" content="' + title + '">',
    '<meta property="og:description" content="' + description + '">',
    '<meta property="og:url" content="' + absUrl('/briefs/' + dateStr + '.html') + '">',
    visualUrl ? '<meta property="og:image" content="' + absUrl(visualUrl) + '">' : '',
    visualUrl ? '<meta name="twitter:card" content="summary_large_image">' : ''
  ].join('\n');
  html = html.replace(/<style[\s\S]*?<\/style>/gi, '');
  html = html.replace(/<title>[\s\S]*?<\/title>/gi, '');
  html = html.replace(/<meta\s+name=["']description["'][^>]*>/gi, '');
  html = html.replace(/<link\s+rel=["']canonical["'][^>]*>/gi, '');
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, seo + '\n' + styleTag + '\n</head>');
  return '<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' + seo + styleTag + '</head><body>' + html + '</body></html>';
}
function addChrome(html){
  const secTitles=[];
  html = html.replace(/<span\s+class=["']item-num["'][^>]*>[\s\S]*?<\/span>/gi, '');
  html = html.replace(/<h2 class="sec-kicker">([^<]*)<span class="spacer"><\/span><\/h2>/g, function(m,t){ secTitles.push(t); return '<h2 class="sec-kicker" id="sec-' + secTitles.length + '">' + t + '<span class="spacer"></span></h2>'; });
  const links = secTitles.map(function(t,i){ return '<a href="#sec-' + (i+1) + '">' + escapeHtml(t) + '</a>'; }).join('');
  const toc = '<aside class="toc"><div class="k">On this page</div>' + links + '</aside>';
  const tocMobile = '<details class="toc-mobile"><summary>Daftar isi</summary>' + links + '</details>';
  const aside = '<aside class="aside"><div class="box"><div class="k">Edisi</div><p>' + pretty + '</p><p>Analisis pengetahuan terbit setiap hari kerja, 05:30 WIB.</p></div><div class="box"><div class="k">Navigasi</div><p><a href="./index.html">Arsip semua edisi</a></p></div></aside>';
  html = html.replace(/<body[^>]*>/, '<body>\n<div class="layout">\n' + toc + tocMobile);
  html = html.replace(/<\/body>/, aside + '\n</div>\n</body>');
  return html;
}

// ---------- skeleton dry-run (full dokument) tanpa LLM ----------
function skeleton(full){
  const base = [
    '<header class="masthead"><div class="masthead-name">Knowledge Brief</div><div class="masthead-sub">Konstruksi pengetahuan lintas hari · diakumulasi</div><div class="masthead-date">' + pretty + '</div></header>',
    '<div class="lensa">Lensa Knowledge Brief - Penerapan</div>',
    '<p class="dek">Kerangka dry-run untuk menguji struktur & desain CSS. Nama topik ditampilkan agar kontrak HTML mudah disentuh.</p>',
    '<div class="seconds"><div class="blk-k">60 detik</div><ul><li>Bullet 1: inti yang bisa diucapkan dalam satu tarikan napas.</li><li>Bullet 2: satu pergeseran agar tidak terasa seperti ringkasan wiki.</li><li>Bullet 3: satu hal yang menuntut keputusan atau dalil.</li></ul><p class="act"><b>Ide untuk dibawa ke rapat:</b> &lt;isi satu ide tajam di sini&gt;</p></div>',
    '<section class="trigger"><div class="blk-k">Business Trigger</div><p>Sinyal bisnis membuat konsep hari ini relevan untuk keputusan perusahaan.</p><div class="field"><span class="fk">Mengapa konsep ini dipilih</span><p>Konsep ini dipilih karena menjelaskan gap keputusan yang muncul dari sinyal tersebut.</p></div></section>',
    '<section class="knowledge-matrix"><div class="blk-k">Knowledge Matrix</div><div class="table-wrap"><table><thead><tr><th>Layer</th><th>Isi</th><th>Fungsi Praktis</th></tr></thead><tbody><tr><td>Konsep utama</td><td>...</td><td>...</td></tr><tr><td>Framework / Approach</td><td>...</td><td>...</td></tr></tbody></table></div></section>',
    '<section class="relationship"><div class="blk-k">Concept Relationship</div><p>Konsep utama menjelaskan masalah, pembanding membatasi salah paham, dan toolkit menurunkannya ke praktik.</p></section>',
    '<section class="application-matrix"><div class="blk-k">Application Matrix</div><div class="table-wrap"><table><thead><tr><th>Konteks</th><th>Dipakai untuk</th><th>Red flag</th></tr></thead><tbody><tr><td>Rapat</td><td>...</td><td>...</td></tr></tbody></table></div></section>',
    '<div class="question"><div class="blk-k">Pertanyaan hari ini</div><p>Bagaimana <b></b> berubah ketika konteks keputusan berubah cepat?</p></div>',
    '<section class="thesis"><div class="blk-k">Tesis hari ini</div><div class="thesis-pos"><b>Thesis.</b> &lt;posisi satu-dua kalimat, tegas, bisa diuji.&gt;</div><div class="thesis-support"><div class="field"><span class="fk">Penopang</span><p><span class="ev-fact">FACT</span> satu fakta/jejak · <span class="ev-inf">INFERENCE</span> satu kesimpulan.</p></div></div><div class="thesis-objection"><span class="fk">Keberatan terbaik</span><p>&lt;counter terkuat, ditulis adil.&gt;</p></div><div class="thesis-falsify"><span class="fk">Kapan tesis ini gugur</span><p>&lt;klausa falsifikasi eksplisit.&gt;</p></div></section>',
    '<section class="diagnostic"><div class="field danger"><span class="fk">Salah kaprah</span><p>&lt;satu salah kaprah yang sering terjadi.&gt;</p></div><div class="field"><span class="fk">Gap lapangan</span><p>&lt;satu gap praktik di rapat, memo, governance, atau eksekusi.&gt;</p></div><div class="field"><span class="fk">Pertanyaan diagnosis</span><p>&lt;satu pertanyaan untuk menguji situasi nyata.&gt;</p></div><div class="field danger"><span class="fk">Jangan pakai konsep ini jika</span><p>&lt;batas kondisi ketika konsep ini salah konteks.&gt;</p></div></section>'
  ];
  if(!full) return base.join('\n');
  const parts = [].concat(base);
  const sec = function(n,title,kick){ return '<h2 class="sec-kicker">'+n+' · '+title+'<span class="spacer"></span></h2>' + '<article class="item"><div class="item-head"><h3>'+title+'</h3></div><div class="meta"><span class="chip">'+escapeHtml(kick)+'</span></div><p class="field" style="border:0"></p></article>'; };
  // Actually produce readable placeholder lenses
  const lenses = [
    ['Konsep','Definisi kanonik, pencetus, sumber, dan batas konsep.'],
    ['Aturan / Kerangka','Framework yang dipakai praktik, asumsi tersirat, dan kapan bisa salah.'],
    ['Penerapan','Kasus nyata: keputusan/struktur yang benar-benar memakainya.'],
    ['Geseran','Kapan prinsip klasik mulai gagal atau berubah makna, dan implikasinya untuk memutuskan.']
  ];
  lenses.forEach(function(L,i){ parts.push('<h2 class="sec-kicker" id="sec-'+(i+1)+'">'+(i+1)+' · '+L[0]+'<span class="spacer"></span></h2><div class="field"><span class="fk">Lensa</span><p>'+L[1]+'</p></div><article class="item"><div class="meta"><span class="chip">'+escapeHtml(L[0])+'</span></div><p class="lede">Cth ilustrasi konsep & aplikasi nyata (fakta ber-<span class="ev-fact">FACT</span>, tafsir <span class="ev-inf">INFERENCE</span>, yang ragu <span class="ev-unc">VERIFY</span>).</p></article>'); });
  parts.push('<dl class="glossary"><div class="blk-k">Glosarium harian</div><dt>Istilah</dt><dd>definisi kanonik satu baris.</dd></dl>');
  parts.push('<section class="learn-next"><div class="blk-k">Learn Next</div><ul><li><b>Konsep prasyarat:</b> ...</li><li><b>Konsep terkait:</b> ...</li><li><b>Jalur 7 hari:</b> ...</li></ul></section>');
  parts.push('<section class="whatnot"><p><b>Yang tidak boleh dipercaya begitu saja:</b> &lt;satu common belief yang menyesatkan terkait topik ini.&gt;</p></section>');
  parts.push('<section class="ledger-note"><div class="blk-k">Catatan ledger</div><p>[dry-run] Topik ini akan tercatat di ledger agar edisi besok merujuk, bukan menjelaskan ulang.</p></section>');
  return parts.join('\n');
}

function renderDryHtml(topic){
  const body = skeleton(true);
  return '<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="teaser" content="DRAF DRY-RUN - ' + escapeHtml(topic.title) + '"><title>' + escapeHtml('Knowledge Brief · ' + pretty) + '</title></head><body><div class="wrap">' + body + '<footer class="foot"><p><b>DRAF KERANGKA (dry-run).</b> Belum ditinjau editor/apapun; dipakai utk uji struktur & CSS. Nama topik: <b>' + escapeHtml(topic.title) + '</b> · pilar ' + escapeHtml(topic.pillar||'') + '.</p></footer></div></body></html>';
}

// ---------- manifest & arsip ----------
function updateManifest(d, meta, file){
  const p = join(BRIEFS,'manifest.json'); let m = json(p, {});
  const title = pretty + (meta.lens ? ' - ' + meta.lens : '');
  m[d] = { date:d, title:title, dek:meta.dek, teaser:meta.teaser, headline:meta.lens||meta.dek, file:file };
  writeFileSync(p, JSON.stringify(m, null, 2) + '\n', 'utf8');
}

function writeSeoFiles(){
  const m = json(join(BRIEFS,'manifest.json'), {});
  const dates = Object.keys(m).sort().reverse();
  const latest = dates[0] || dateStr;
  const urls = [
    { loc: absUrl('/'), lastmod: latest },
    { loc: absUrl('/briefs/'), lastmod: latest },
    { loc: absUrl('/knowledge-os.html'), lastmod: latest }
  ];
  for (const d of dates) {
    const e = m[d] || {};
    if (e.file) urls.push({ loc: absUrl('/briefs/' + e.file), lastmod: d });
  }
  const sitemap = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    urls.map(function(u){ return '  <url><loc>' + escapeHtml(u.loc) + '</loc><lastmod>' + escapeHtml(u.lastmod) + '</lastmod></url>'; }).join('\n'),
    '</urlset>',
    ''
  ].join('\n');
  writeFileSync(join(REPO, 'sitemap.xml'), sitemap, 'utf8');
  writeFileSync(join(REPO, 'robots.txt'), 'User-agent: *\nAllow: /\n\nSitemap: ' + absUrl('/sitemap.xml') + '\n', 'utf8');
}
function writeIndex(){
  const m = json(join(BRIEFS,'manifest.json'), {});
  const dates = Object.keys(m).sort().reverse();
  const rows = dates.map(function(d){
    const e = m[d];
    const pd = new Date(d+'T00:00:00Z').toLocaleDateString('id-ID',{weekday:'long',day:'numeric',month:'long',year:'numeric',timeZone:'Asia/Jakarta'});
    return '<li><a href="'+escapeHtml(e.file)+'">'+escapeHtml(e.title||pd)+'</a>'+(e.dek?'<span>'+escapeHtml(e.dek)+'</span>':'')+'</li>';
  }).join('\n');
  const html = ['<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">','<title>Knowledge Brief - Arsip</title><meta name="description" content="Arsip edisi harian KnowledgeBrief.id."><meta name="robots" content="index,follow,max-image-preview:large"><link rel="canonical" href="' + absUrl('/briefs/') + '"><style>',
  ':root{--bg:#fff;--fg:#191919;--fg2:#6b6b6b;--accent:#1652a0;--border:#e8e8e8}',
  '@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--bg:#121212;--fg:#e6e6e6;--fg2:#9a9a9a;--accent:#5b9bff;--border:#2a2a2a}}',
  'body{margin:0;background:var(--bg);color:var(--fg);font-family:system-ui,sans-serif;line-height:1.6}',
  '.wrap{max-width:760px;margin:0 auto;padding:40px 20px 80px}h1{font-size:28px;margin:0 0 6px}.sub{color:var(--fg2);margin:0 0 24px}',
  'input{width:100%;padding:12px 14px;font-size:16px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--fg);margin-bottom:20px;box-sizing:border-box}',
  'ul{list-style:none;padding:0}li{padding:14px 0;border-top:1px solid var(--border)}a{color:var(--accent);text-decoration:none;font-weight:600;display:block}li span{color:var(--fg2);display:block;margin-top:3px;font-size:13.5px;line-height:1.55}',
  '</style></head><body><div class="wrap"><h1>Knowledge Brief</h1><p class="sub">Arsip edisi harian yang mengakumulasi konsep, pembanding, mekanisme praktik, dan catatan ledger.</p>','<input type="search" placeholder="Cari tanggal, topik, atau konsep…" oninput="f()"><ul id="list">',rows,
  '</ul><script>function f(){var q=(document.querySelector("input").value||"").toLowerCase();var items=document.querySelectorAll("#list li");for(var i=0;i<items.length;i++){items[i].style.display=items[i].textContent.toLowerCase().indexOf(q)>-1?"":"none";}}</script>','</div></body></html>'].join('\n');
  writeFileSync(join(BRIEFS,'index.html'), html, 'utf8');
}

function writeKnowledgeOsPage(){
  const m = json(join(BRIEFS,'manifest.json'), {});
  const dates = Object.keys(m).sort().reverse();
  const latestDate = dates[0] || dateStr;
  const latest = m[latestDate] || {};
  const latestHref = latest.file ? '/briefs/' + latest.file : '/briefs/';
  const rows = dates.slice(0, 12).map(function(d){
    const e = m[d] || {};
    if (!e.file) return '';
    const pd = new Date(d+'T00:00:00Z').toLocaleDateString('id-ID',{weekday:'long',day:'numeric',month:'long',year:'numeric',timeZone:'Asia/Jakarta'});
    return '<article class="row"><div><span>' + escapeHtml(pd) + '</span><h3><a href="/briefs/' + escapeHtml(e.file) + '">' + escapeHtml(e.headline || e.title || pd) + '</a></h3></div><p>' + escapeHtml(stripHtml(e.dek || '').slice(0, 190)) + '</p></article>';
  }).join('\n');
  const topics = json(TOPICS_FILE, { topics: [] }).topics || [];
  const topicRows = topics.slice(0, 24).map(function(t){
    return '<tr><td><b>' + escapeHtml(t.title || t.slug) + '</b><span>' + escapeHtml(t.pillar || '') + '</span></td><td>' + escapeHtml(t.model || t.coreConcept || '') + '</td><td>' + escapeHtml((t.tags || []).slice(0, 4).join(', ')) + '</td></tr>';
  }).join('\n');
  const html = [
    '<!doctype html>',
    '<html lang="id">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>Knowledge Operating System | KnowledgeBrief.id</title>',
    '<meta name="description" content="Knowledge Operating System KnowledgeBrief.id: matriks konsep, toolkit, misuse index, dan learning path untuk profesional eksekutif.">',
    '<meta name="robots" content="index,follow,max-image-preview:large">',
    '<link rel="canonical" href="' + absUrl('/knowledge-os.html') + '">',
    '<link rel="icon" href="/favicon.svg" type="image/svg+xml">',
    '<link rel="manifest" href="/site.webmanifest">',
    '<meta name="theme-color" content="#1652a0">',
    '<style>',
    ':root{--bg:#fff;--fg:#17191d;--muted:#626875;--faint:#8b93a1;--accent:#1652a0;--green:#0e7c66;--risk:#a63a32;--soft:#f6f8fb;--line:#e1e6ef;--line2:#b9c4d4;--serif:Georgia,"Times New Roman",serif;--sans:Inter,system-ui,sans-serif;--mono:ui-monospace,Consolas,monospace}',
    '*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font-family:var(--sans);line-height:1.7}.wrap{max-width:1100px;margin:0 auto;padding:32px 24px 80px}.brand{font-family:var(--serif);font-size:26px;font-weight:700;text-decoration:none;color:var(--fg)}.brand span{color:var(--accent)}header{border-bottom:1px solid var(--line2);padding-bottom:18px;margin-bottom:48px;display:flex;justify-content:space-between;gap:18px;align-items:baseline;flex-wrap:wrap}nav a{font-family:var(--mono);font-size:12px;text-transform:uppercase;letter-spacing:.09em;color:var(--muted);text-decoration:none;margin-left:18px}nav a:hover{color:var(--accent)}h1{font-family:var(--serif);font-size:52px;line-height:1.06;letter-spacing:-.02em;margin:0 0 18px;max-width:820px}.dek{font-family:var(--serif);font-size:22px;line-height:1.48;color:var(--muted);max-width:780px;margin:0 0 30px}.btn{display:inline-block;background:var(--accent);color:#fff;text-decoration:none;padding:12px 18px;border-radius:6px;font-weight:700}.link{display:inline-block;margin-left:14px;color:var(--accent);font-weight:700;text-decoration:none}.grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:22px;margin:42px 0}.cell{border-top:1px solid var(--line2);padding-top:15px}.cell h2{font-size:15px;margin:0 0 8px}.cell p{font-size:14px;color:var(--muted);margin:0}.k{font-family:var(--mono);font-size:11px;letter-spacing:.13em;text-transform:uppercase;color:var(--faint);margin:44px 0 12px}table{width:100%;border-collapse:collapse;margin-bottom:34px}th{text-align:left;font-family:var(--mono);font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--faint);border-bottom:1px solid var(--line2);padding:10px 8px}td{border-bottom:1px solid var(--line);padding:14px 8px;vertical-align:top;font-size:14px}td span{display:block;color:var(--muted);margin-top:3px}.row{display:grid;grid-template-columns:minmax(230px,.42fr) minmax(0,1fr);gap:24px;border-top:1px solid var(--line);padding:16px 0}.row span{font-family:var(--mono);font-size:11px;color:var(--faint);text-transform:uppercase;letter-spacing:.08em}.row h3{font-family:var(--serif);font-size:21px;line-height:1.2;margin:4px 0}.row a{color:var(--fg);text-decoration:none}.row p{color:var(--muted);margin:0}.misuse{border-top:1px solid var(--line2);border-bottom:1px solid var(--line2);padding:18px 0;margin:0 0 34px;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:24px}.misuse b{display:block;color:var(--risk);margin-bottom:6px}.misuse p{margin:0;color:var(--muted);font-size:14px}.path{border-top:1px solid var(--line2);padding-top:18px}.path ol{margin:0;padding-left:22px}.path li{margin-bottom:9px}@media(max-width:900px){.grid{grid-template-columns:1fr 1fr}.misuse{grid-template-columns:1fr}.row{grid-template-columns:1fr}h1{font-size:38px}}@media(max-width:560px){.wrap{padding:24px 18px 64px}nav a{margin:0 14px 0 0}.grid{grid-template-columns:1fr}h1{font-size:32px}.dek{font-size:19px}}',
    '</style>',
    '</head>',
    '<body><div class="wrap">',
    '<header><a class="brand" href="/">KnowledgeBrief<span>.id</span></a><nav><a href="/briefs/">Arsip</a><a href="/knowledge-os.html">Knowledge OS</a><a href="' + escapeHtml(latestHref) + '">Edisi terbaru</a></nav></header>',
    '<main>',
    '<h1>Knowledge Operating System.</h1>',
    '<p class="dek">KnowledgeBrief.id dibangun sebagai sistem pengetahuan untuk pengambil kebijakan, CEO, CFO, dan chief lainnya. Tujuannya bukan memperbanyak bacaan, tetapi membuat konsep, framework, tokoh, pendekatan, dan batas pemakaian saling terlihat.</p>',
    '<p><a class="btn" href="' + escapeHtml(latestHref) + '">Baca edisi terbaru</a><a class="link" href="/briefs/">Lihat arsip</a></p>',
    '<section class="grid"><div class="cell"><h2>Knowledge Matrix</h2><p>Daftar konsep, teori, framework, dan pendekatan yang perlu dipahami lintas fungsi.</p></div><div class="cell"><h2>Concept Graph</h2><p>Hubungan antar konsep agar pembaca melihat sebab, batas, dan konsekuensi.</p></div><div class="cell"><h2>Toolkit Library</h2><p>Konsep diturunkan ke alat kerja: diagnosis, memo, gate, review, dan pertanyaan keputusan.</p></div><div class="cell"><h2>Misuse Index</h2><p>Bagian merah untuk salah kaprah, konsep yang tidak cocok, dan red flag pemakaian.</p></div><div class="cell"><h2>Learning Path</h2><p>Jalur belajar 7 hari, 30 hari, dan 90 hari untuk membangun kapasitas eksekutif.</p></div></section>',
    '<div class="k">Knowledge matrix awal</div>',
    '<table><thead><tr><th>Konsep</th><th>Framework atau approach</th><th>Tag</th></tr></thead><tbody>' + topicRows + '</tbody></table>',
    '<div class="k">Misuse index</div>',
    '<section class="misuse"><div><b>Salah kaprah</b><p>Memakai istilah strategis sebagai pengganti pilihan yang jelas.</p></div><div><b>Jangan pakai jika</b><p>Konteks keputusan, data, owner, dan horizon belum cukup untuk diuji.</p></div><div><b>Red flag</b><p>Konsep terdengar cerdas tetapi tidak mengubah memo, rapat, gate, atau keputusan.</p></div></section>',
    '<div class="k">Learning path</div>',
    '<section class="path"><ol><li><b>7 hari:</b> pahami istilah, batas konsep, dan satu pertanyaan diagnosis.</li><li><b>30 hari:</b> hubungkan konsep dengan rapat, risiko, capital allocation, governance, atau operating model.</li><li><b>90 hari:</b> bangun ledger keputusan agar konsep tidak berhenti sebagai bacaan.</li></ol></section>',
    '<div class="k">Edisi yang membangun ledger</div>',
    rows,
    '</main>',
    '</div></body></html>',
    ''
  ].join('\n');
  writeFileSync(join(REPO, 'knowledge-os.html'), html, 'utf8');
}

function writeHomePage(){
  const m = json(join(BRIEFS,'manifest.json'), {});
  const dates = Object.keys(m).sort().reverse();
  const latestDate = dates[0] || dateStr;
  const latest = m[latestDate] || {};
  const latestHref = latest.file ? '/briefs/' + latest.file : '/briefs/';
  const latestTitle = latestDate ? new Date(latestDate + 'T00:00:00Z').toLocaleDateString('id-ID', { weekday:'long', day:'numeric', month:'long', year:'numeric', timeZone:'Asia/Jakarta' }) : 'Edisi terbaru';
  const latestHeadline = latest.headline || latest.title || 'Edisi terbaru';
  const latestDek = latest.dek || 'Tiga konsep, satu tesis, dan satu gap praktik yang bisa diuji.';
  const html = [
    '<!doctype html>',
    '<html lang="id">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>KnowledgeBrief.id</title>',
    '<meta name="description" content="Kurasi pengetahuan harian untuk manajer eksekutif dan Subject Matter Expert: tiga konsep, satu tesis, dan satu gap praktik yang bisa diuji.">',
    '<meta name="robots" content="index,follow,max-image-preview:large">',
    '<link rel="canonical" href="' + absUrl('/') + '">',
    '<link rel="icon" href="/favicon.svg" type="image/svg+xml">',
    '<link rel="manifest" href="/site.webmanifest">',
    '<meta name="theme-color" content="#1652a0">',
    '<meta property="og:type" content="website">',
    '<meta property="og:title" content="KnowledgeBrief.id">',
    '<meta property="og:description" content="Kurasi pengetahuan harian yang menghubungkan konsep, pembanding, dan mekanisme praktik.">',
    '<meta property="og:url" content="' + absUrl('/') + '">',
    '<style>',
    ':root{--bg:#fff;--fg:#17191d;--muted:#626875;--faint:#8b93a1;--accent:#1652a0;--accent2:#0e7c66;--soft:#f5f8fc;--line:#e1e6ef;--serif:Georgia,"Times New Roman",serif;--sans:Inter,system-ui,sans-serif;--mono:ui-monospace,Consolas,monospace}',
    '*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font-family:var(--sans);line-height:1.7;-webkit-font-smoothing:antialiased}.wrap{max-width:1080px;margin:0 auto;padding:0 24px}header{border-bottom:1px solid var(--line);padding:26px 0 18px}.nav{display:flex;justify-content:space-between;gap:20px;align-items:flex-end}.brand{font-family:var(--serif);font-size:30px;font-weight:700;letter-spacing:-.01em}.brand span{color:var(--accent)}nav a{font-family:var(--mono);font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);text-decoration:none;margin-left:18px}.hero{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(280px,.75fr);gap:46px;padding:58px 0 48px;border-bottom:1px solid var(--line)}h1{font-family:var(--serif);font-size:52px;line-height:1.06;margin:0 0 18px;letter-spacing:-.02em}.dek{font-family:var(--serif);font-size:22px;line-height:1.48;color:var(--muted);margin:0 0 26px}.btn{display:inline-block;background:var(--accent);color:#fff;text-decoration:none;padding:12px 18px;border-radius:6px;font-weight:700}.link{display:inline-block;margin-left:14px;color:var(--accent);font-weight:700;text-decoration:none}.latest{border-top:3px solid var(--accent);background:var(--soft);padding:20px 22px}.k{font-family:var(--mono);font-size:11px;text-transform:uppercase;letter-spacing:.12em;color:var(--faint);font-weight:800}.latest h2{font-family:var(--serif);font-size:26px;line-height:1.18;margin:8px 0}.latest a{color:var(--fg);text-decoration:none}.latest p{color:var(--muted);margin:0 0 6px}.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:24px;padding:34px 0 62px}.card{border-top:1px solid var(--line);padding-top:16px}.card h3{font-size:16px;margin:0 0 8px}.card p{margin:0;color:var(--muted);font-size:14.5px}.audit{border-top:1px solid var(--line);padding:18px 0 46px;color:var(--muted);font-size:13px}.audit b{color:var(--accent2);text-transform:uppercase;letter-spacing:.08em}@media(max-width:900px){.grid{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:760px){.wrap{padding:0 18px}.nav{display:block}nav{margin-top:10px}nav a{margin-left:0;margin-right:16px}.hero,.grid{grid-template-columns:1fr}h1{font-size:36px}.dek{font-size:19px}.link{display:block;margin:12px 0 0}}',
    '</style>',
    '</head>',
    '<body>',
    '<header><div class="wrap nav"><div class="brand">KnowledgeBrief<span>.id</span></div><nav><a href="/briefs/">Arsip</a><a href="/knowledge-os.html">Knowledge OS</a><a href="' + escapeHtml(latestHref) + '">Edisi terbaru</a></nav></div></header>',
    '<main class="wrap">',
    '<section class="hero"><div><h1>Tiga konsep setiap pagi, satu tesis yang bisa diuji.</h1><p class="dek">KnowledgeBrief.id bukan ringkasan berita. Ia membangun ledger pengetahuan dari konsep utama, konsep pembanding, dan mekanisme praktik yang bisa dipakai ulang oleh manajer eksekutif dan Subject Matter Expert.</p><a class="btn" href="' + escapeHtml(latestHref) + '">Baca edisi terbaru</a><a class="link" href="/briefs/">Lihat arsip</a></div>',
    '<aside class="latest"><div class="k">Latest brief</div><h2><a href="' + escapeHtml(latestHref) + '">' + escapeHtml(latestHeadline) + '</a></h2><p>' + escapeHtml(latestTitle) + '</p><p>' + escapeHtml(latestDek) + '</p></aside></section>',
    '<section class="grid"><div class="card"><h3>Konsep utama</h3><p>Satu konsep pusat dipilih untuk menjawab dilema keputusan hari itu, bukan untuk menambah istilah baru.</p></div><div class="card"><h3>Pembanding</h3><p>Konsep yang sering tertukar dipakai untuk membuat batas berpikir lebih jelas dan mencegah salah pakai.</p></div><div class="card"><h3>Praktik</h3><p>Setiap edisi turun ke mekanisme rapat, memo, review proyek, governance, atau desain organisasi.</p></div><div class="card"><h3>Ledger</h3><p>Konsep yang sudah dibahas dicatat agar edisi berikutnya membangun lapisan baru, bukan mengulang definisi lama.</p></div></section>',
    '<div class="audit"><b>Editorial note</b> · Dibantu AI, dikurasi dengan kontrol editorial, dan dirancang untuk pengetahuan yang dapat diuji. Bukan nasihat investasi, hukum, atau akademik formal.</div>',
    '</main>',
    '</body>',
    '</html>',
    ''
  ].join('\n');
  writeFileSync(join(REPO, 'index.html'), html, 'utf8');
}

async function main(){
  mkdirSync(BRIEFS,{recursive:true}); mkdirSync(LEDGER_DIR,{recursive:true});
  if(!existsSync(LEDGER_FILE)) writeFileSync(LEDGER_FILE, JSON.stringify({version:1,concepts:[],theses:[]},null,2)+'\n','utf8');
  const cfg = json(TOPICS_FILE, {});
  if(!isWorkingDay(weekday)){ console.log('Hari ini ' + weekday + ', bukan hari kerja; lewati.'); return; }
  const state = json(STATE_FILE, { counts: {} });
  const sel = pickTopic(cfg, state, weekday);
  if(!sel){ console.log('Tidak ada bucket topik untuk ' + weekday + '; lewati.'); return; }
  const topics = cfg.topics || [];
  const topic = topics.find(function(t){ return t.slug===sel.slug; }) || { slug:sel.slug, title:sel.slug, pillar:'' };
  console.log('['+dateStr+'] '+weekday+' → topik: '+topic.slug+' ('+topic.title+')');

  // tentukan file
  const file = dateStr + '.html';

  let finalHtml;
  if (DRY){
    console.log('(dry-run) membangun kerangka tanpa DeepSeek.');
    const dryHtml = renderDryHtml(topic);
    const visualUrl = await writeKnowledgeCanvas(topic, extractMeta(dryHtml));
    finalHtml = injectTemplate(addChrome(insertKnowledgeCanvas(dryHtml, topic, visualUrl)), visualUrl);
  } else {
    if(!DEEPSEEK){ console.error('DEEPSEEK_API_KEY belum diset. Gunakan --dry-run atau set env.'); process.exit(1); }
    const promptText = readFileSync(PROMPT_FILE, 'utf8');
    const context = await contextFor(topic); // optional
    const grounding = await groundingContext();
    const enrichedPrompt = promptText
      + (grounding ? '\n\n=== SINYAL GROUNDING DARI EKOSISTEM BRIEF ===\n' + grounding : '')
      + (context ? '\n\n=== MATERI KONTEKSTUAL (boleh verifikasi) ===\n' + context : '');
    let lastAudit = '';
    for (let attempt = 1; attempt <= 3; attempt++) {
      const repairNote = lastAudit
        ? '\n\n=== HASIL AUDIT DRAFT SEBELUMNYA ===\n' + lastAudit + '\nTulis ulang dari awal. Jangan buka dengan frasa generik, jangan pakai framing list mekanis, dan buka dengan trigger bisnis, angka, keputusan, atau konsep yang spesifik.'
        : '';
      console.log('calling deepseek... attempt ' + attempt);
      const html = await callDeepSeek(enrichedPrompt + repairNote, topic);
      assertCompleteHtml(html, 'raw KnowledgeBrief draft');
      const visualUrl = await writeKnowledgeCanvas(topic, extractMeta(html));
      const dressed = normalizeAuditLanguage(injectTemplate(addChrome(insertKnowledgeCanvas(html, topic, visualUrl)), visualUrl));
      assertCompleteHtml(dressed, 'rendered KnowledgeBrief draft');
      try {
        auditKnowledgeBrief(dressed, { production: true });
        finalHtml = dressed;
        break;
      } catch (e) {
        if (!(e instanceof AuditError) || attempt === 3) throw e;
        lastAudit = e.message;
        console.error('audit rejected attempt ' + attempt + ': ' + e.message);
      }
    }
  }

  if(!finalHtml || finalHtml.length < 400) throw new Error('HTML kosong/terlalu pendek');
  auditKnowledgeBrief(finalHtml, { production: !DRY });
  const meta = extractMeta(finalHtml);
  writeFileSync(join(BRIEFS, file), finalHtml + '\n', 'utf8');
  if (!DRY) updateLedger(topic, meta);
  updateManifest(dateStr, meta, file);
  writeIndex();
  writeHomePage();
  writeKnowledgeOsPage();
  writeSeoFiles();
  advanceState(state, sel); // sekarang maju; jika topik besok harus incremental, jangan maju terlalu agresif.
  console.log('done -> briefs/' + file + (DRY?' (dry-run)':''));
}

main().catch(function(e){ console.error(e); process.exit(1); });

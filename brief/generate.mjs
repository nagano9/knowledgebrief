// Knowledge Brief generator (runner) — STATEFUL
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
import { auditKnowledgeBrief } from './audit.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENGINE = __dirname;
const REPO = resolve(__dirname, '..');
const BRIEFS = join(REPO, 'briefs');
const LEDGER_DIR = join(ENGINE, 'ledger');
const STATE_FILE = join(ENGINE, 'rotation-state.json');
const TOPICS_FILE = join(ENGINE, 'topics.json');
const PROMPT_FILE = join(ENGINE, 'prompt.md');
const CSS_FILE = join(ENGINE, 'template.css');
const ARCHIVE_FILE = join(LEDGER_DIR, 'archive.jsonl');
const LEDGER_FILE = join(LEDGER_DIR, 'ledger.json');
const SITE_URL = 'https://knowledgebrief.id';

const DEEPSEEK = process.env.DEEPSEEK_API_KEY || '';
const MODEL = process.env.BRIEF_MODEL || 'deepseek-chat';
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
  const q = (topic && topic.title ? topic.title : '') + (topic && topic.coreConcept ? ' — ' + topic.coreConcept : '');
  if (!q) return '';
  const sel = process.env.TAVILY_API_KEY ? await tavilySearch(q) : [];
  return sel.map(function(r,i){ return (i+1)+'. '+r.title+'\n   '+r.link+'\n   '+r.snippet; }).join('\n\n');
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
    'AUDIT GATE: output produksi akan ditolak bila memuat DRAF, DRY-RUN, placeholder, em dash, VERIFY yang belum diselesaikan, atau tesis tanpa keberatan terbaik dan klausa falsifikasi.',
    '',
    'Tulis HTML lengkap sekarang. Kembalikan HANYA HTML (tanpa fence markdown, tanpa komentar).'
  ].join('\n');
  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST', headers: { 'Content-Type':'application/json', 'Authorization':'Bearer ' + DEEPSEEK },
    body: JSON.stringify({ model:MODEL, messages:[{role:'system',content:sys},{role:'user',content:user}], temperature:0.4, stream:false }),
    signal: AbortSignal.timeout(420000)
  });
  if (!res.ok){ const b=await res.text(); throw new Error('DeepSeek HTTP '+res.status+': '+b.slice(0,300)); }
  const data = await res.json();
  let html = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
  html = html.replace(/^\s*\x60\x60\x60[a-zA-Z]*\s*\n?/, '').replace(/\n?\x60\x60\x60\s*$/, '').trim();
  return html;
}

function stripHtml(s){ return String(s).replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim(); }

function extractMeta(html){
  const dekM = html.match(/<p class="dek">([\s\S]*?)<\/p>/);
  const lensM = html.match(/<div class="lensa">([\s\S]*?)<\/div>/);
  const teaserM = html.match(/<meta name="teaser" content="([^"]*)">/);
  let lens = lensM ? stripHtml(lensM[1]) : '';
  lens = lens.replace(/^lensa\s*[:\-—]?\s*/i,'').replace(/^\s*Knowledge Brief\s*—\s*/i,'').trim();
  return { dek: dekM ? stripHtml(dekM[1]) : '', lens: lens, teaser: teaserM ? teaserM[1].trim() : '' };
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
function injectTemplate(html){
  const css = readFileSync(CSS_FILE, 'utf8');
  const styleTag = '<style>\n' + css + '\n</style>';
  const meta = extractMeta(html);
  const title = escapeHtml((meta.lens || meta.dek || 'Knowledge Brief').slice(0, 80) + ' | KnowledgeBrief.id');
  const description = escapeHtml((meta.dek || meta.teaser || 'Kurasi pengetahuan harian untuk manajer eksekutif dan Subject Matter Expert.').slice(0, 160));
  const seo = [
    '<title>' + title + '</title>',
    '<meta name="description" content="' + description + '">',
    '<link rel="canonical" href="' + absUrl('/briefs/' + dateStr + '.html') + '">',
    '<link rel="icon" href="/favicon.svg" type="image/svg+xml">',
    '<link rel="manifest" href="/site.webmanifest">',
    '<meta name="theme-color" content="#1652a0">',
    '<meta property="og:type" content="article">',
    '<meta property="og:title" content="' + title + '">',
    '<meta property="og:description" content="' + description + '">',
    '<meta property="og:url" content="' + absUrl('/briefs/' + dateStr + '.html') + '">'
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
    '<div class="question"><div class="blk-k">Pertanyaan hari ini</div><p>Bagaimana <b></b> berubah ketika konteks keputusan berubah cepat?</p></div>',
    '<section class="thesis"><div class="blk-k">Tesis hari ini</div><div class="thesis-pos"><b>Thesis.</b> &lt;posisi satu-dua kalimat, tegas, bisa diuji.&gt;</div><div class="thesis-support"><div class="field"><span class="fk">Penopang</span><p><span class="ev-fact">FACT</span> satu fakta/jejak · <span class="ev-inf">INFERENCE</span> satu kesimpulan.</p></div></div><div class="thesis-objection"><span class="fk">Keberatan terbaik</span><p>&lt;counter terkuat, ditulis adil.&gt;</p></div><div class="thesis-falsify"><span class="fk">Kapan tesis ini gugur</span><p>&lt;klausa falsifikasi eksplisit.&gt;</p></div></section>'
  ];
  if(!full) return base.join('\n');
  const parts = [].concat(base);
  const sec = function(n,title,kick){ return '<h2 class="sec-kicker">'+n+' · '+title+'<span class="spacer"></span></h2>' + '</span></h2><article class="item"><div class="item-head"><span class="item-num">'+n+'</span><h3>'+title+'</h3></div><div class="meta"><span class="chip">'+escapeHtml(kick)+'</span></div><p class="field" style="border:0"></p></article>'; };
  // Actually produce readable placeholder lenses
  const lenses = [
    ['Konsep','Definisi kanonik, pencetus, sumber, dan batas konsep.'],
    ['Aturan / Kerangka','Framework yang dipakai praktik, asumsi tersirat, dan kapan bisa salah.'],
    ['Penerapan','Kasus nyata: keputusan/struktur yang benar-benar memakainya.'],
    ['Geseran','Kapan prinsip klasik mulai gagal atau berubah makna, dan implikasinya untuk memutuskan.']
  ];
  lenses.forEach(function(L,i){ parts.push('<h2 class="sec-kicker" id="sec-'+(i+1)+'">'+(i+1)+' · '+L[0]+'<span class="spacer"></span></h2><div class="field"><span class="fk">Lensa</span><p>'+L[1]+'</p></div><article class="item"><div class="meta"><span class="chip">'+escapeHtml(L[0])+'</span></div><p class="lede">Cth ilustrasi konsep & aplikasi nyata (fakta ber-<span class="ev-fact">FACT</span>, tafsir <span class="ev-inf">INFERENCE</span>, yang ragu <span class="ev-unc">VERIFY</span>).</p></article>'); });
  parts.push('<dl class="glossary"><div class="blk-k">Glosarium harian</div><dt>Istilah</dt><dd>definisi kanonik satu baris.</dd></dl>');
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
    { loc: absUrl('/briefs/'), lastmod: latest }
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
  const rows = dates.map(function(d){ const e=m[d]; const pd=new Date(d+'T00:00:00Z').toLocaleDateString('id-ID',{weekday:'long',day:'numeric',month:'long',year:'numeric',timeZone:'Asia/Jakarta'}); return '<li><a href="'+e.file+'">'+(e.title||pd)+'</a>'+(e.dek?'<span>'+escapeHtml(e.dek)+'</span>':'')+'</li>'; }).join('\n');
  const html = ['<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">','<title>Knowledge Brief — Arsip</title><style>',
  ':root{--bg:#fff;--fg:#191919;--fg2:#6b6b6b;--accent:#1652a0;--border:#e8e8e8}',
  '@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--bg:#121212;--fg:#e6e6e6;--fg2:#9a9a9a;--accent:#5b9bff;--border:#2a2a2a}}',
  'body{margin:0;background:var(--bg);color:var(--fg);font-family:system-ui,sans-serif;line-height:1.6}',
  '.wrap{max-width:760px;margin:0 auto;padding:40px 20px 80px}h1{font-size:28px;margin:0 0 6px}.sub{color:var(--fg2);margin:0 0 24px}',
  'input{width:100%;padding:12px 14px;font-size:16px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--fg);margin-bottom:20px;box-sizing:border-box}',
  'ul{list-style:none;padding:0}li{padding:14px 0;border-top:1px solid var(--border)}a{color:var(--accent);text-decoration:none;font-weight:600;display:block}li span{color:var(--fg2);display:block;margin-top:3px;font-size:13.5px;line-height:1.55}',
  '</style></head><body><div class="wrap"><h1>Knowledge Brief</h1><p class="sub">Arsip edisi — kurasi pengetahuan harian (diakumulasi). Ketik untuk memfilter.</p>','<input type="search" placeholder="Cari tanggal, topik, atau konsep…" oninput="f()"><ul id="list">',rows,
  '</ul><script>function f(){var q=(document.querySelector("input").value||"").toLowerCase();var items=document.querySelectorAll("#list li");for(var i=0;i<items.length;i++){items[i].style.display=items[i].textContent.toLowerCase().indexOf(q)>-1?"":"none";}}</script>','</div></body></html>'].join('\n');
  writeFileSync(join(BRIEFS,'index.html'), html, 'utf8');
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
    finalHtml = injectTemplate( addChrome( renderDryHtml(topic) ) );
  } else {
    if(!DEEPSEEK){ console.error('DEEPSEEK_API_KEY belum diset. Gunakan --dry-run atau set env.'); process.exit(1); }
    const promptText = readFileSync(PROMPT_FILE, 'utf8');
    const context = await contextFor(topic); // optional
    let html = await callDeepSeek(promptText + (context?('\n\n=== MATERI KONTEKSTUAL (boleh verifikasi) ===\n'+context):''), topic);
    finalHtml = injectTemplate( addChrome(html) );
    updateLedger(topic, extractMeta(finalHtml));
  }

  if(!finalHtml || finalHtml.length < 400) throw new Error('HTML kosong/terlalu pendek');
  auditKnowledgeBrief(finalHtml, { production: !DRY });
  const meta = extractMeta(finalHtml);
  writeFileSync(join(BRIEFS, file), finalHtml + '\n', 'utf8');
  updateManifest(dateStr, meta, file);
  writeIndex();
  writeSeoFiles();
  advanceState(state, sel); // sekarang maju; jika topik besok harus incremental (sisakan state ke topik berikutnya utk bucket yg sama): jangan maju di sini terlalu agresif—maju tiap running.
  console.log('done -> briefs/' + file + (DRY?' (dry-run)':''));
}

main().catch(function(e){ console.error(e); process.exit(1); });

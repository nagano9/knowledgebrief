# Knowledge Brief — knowledgebrief.id

Generator otomatis **Knowledge Brief**: kurasi pengetahuan harian untuk manajer eksekutif dan
Subject Matter Expert, berorientasi kualitas yang **diakumulasi** (stateful), bukan ringkasan berita.

Mengikuti pola yang sudah terbukti di Daily Brief & Leader Brief (editorial contract di
`prompt.md`, CSS di-inject memakai `template.css`, auto-publish via GitHub Actions ke GitHub Pages).

## Positioning unik
| Produk | Objek |
|---|---|
| Daily Brief | Berita hari ini (stateful pada waktu) |
| Leader Brief | Keputusan eksekutif & board (stateful pada keputusan) |
| **Knowledge Brief** | Konsep, prinsip, rule, dan pergeseran paradigma yang **terakumulasi antar-hari** |

Lapis tiap edisi: **Tesis Harian** (pertanyaan → posisi → penopang FACT/INFERENCE → keberatan →
klausa falsifikasi) di atas **Blok Pengetahuan** (Concept → Rule → Application → Shift), ditopang
memori lintas-waktu (`ledger/`) dan kalender kurikulum (`topics.json`).

## Layout folder (repo root = halaman GitHub Pages)
```
knowledge-brief/
  brief/
    generate.mjs        # runner utama (pilih topik, panggil LLM, terbitkan)
    prompt.md           # kontrak editorial + HTML (jiplak DNA Leader Brief)
    topics.json         # kalender kurikulum & rotasi per hari kerja
    template.css        # desain (di-inject otomatis)
    feeds.json          # konteks RSS opsional (tidak dipakai bila memakai riset/kurikulum)
    ledger/             # memori akumulatif: ledger.json + archive.jsonl
    rotation-state.json # (dibuat otomatis)
  briefs/               # OUTPUT: YYYY-MM-DD.html + index.html + manifest.json
  .github/workflows/    # knowledge-brief.yml (cron 05:30 WIB hari kerja)
  CNAME                 # knowledgebrief.id (pastikan domain Anda)
  index.html            # beranda root
```

## Menjalankan lokal
- **Tanpa API (uji struktur/desain):** jalankan dari folder `brief`.
  ```bash
  cd knowledge-brief/brief
  KB_DATE=2026-08-27 node generate.mjs --dry-run   # output ke ../briefs/2026-08-27.html
  ```
  Buka `briefs/<tanggal>.html` di browser untuk melihat struktur; teks masih kerangka.
- **Produksi (butuh kunci DeepSeek):**
  ```bash
  cd knowledge-brief/brief
  DEEPSEEK_API_KEY=... node generate.mjs
  ```
  Edisi dihasilkan, manifest & arsip diperbarui. Ulangi dengan `KB_DATE` berbeda untuk uji multi-hari.

## Auto-publish GitHub Pages
1. Repo GitHub deploy-to-Pages memakai folder root `knowledge-brief/` (atau branch `gh-pages`).
2. Set secret repo `DEEPSEEK_API_KEY` (wajib produksi) dan `TAVILY_API_KEY` (opsional).
3. Workflow `.github/workflows/knowledge-brief.yml` cron 22:30 UTC (Minggu–Kamis) =
   05:30 WIB (Senin–Jumat); juga bisa `workflow_dispatch` manual.
4. `CNAME` berisi `knowledgebrief.id`. Pastikan domain didelegasikan ke Pages sebelum diaktifkan.

## Menyesuaikan
- **Topik:** edit `brief/topics.json` (bucket per hari kerja + daftar topik + siklus).
- **Doktrin:** edit `brief/prompt.md`.
- **Gaya:** edit `brief/template.css` (warna aksen default biru/hijau; light/dark auto).

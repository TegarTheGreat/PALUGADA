# Perbandingan fitur dan kematangan per area (30 September 2026)

Dokumen ini membandingkan PALUGADA dengan kompetitornya **dari fitur dan
kodenya**: apa yang ada, seberapa matang, apa keunggulannya, dan apa
kekurangannya. Metrik popularitas (bintang, kontributor, unduhan) sengaja
tidak dibahas, karena itu bukan ukuran kematangan produk.

Revisi yang dibaca: PALUGADA `2d468df`, Paperclip `0189931`, serta Buzz,
Auto-Company, Multica, dan Opifer pada HEAD 30 September.

## 1. Perbandingan per area

### Cara menilai

- **Aturan hitung.** Setiap proyek dibaca kodenya pada HEAD 30 September.
  Sebuah fitur dihitung hanya jika **terpasang dan tersambung** ke produk
  yang berjalan, bukan sekadar ada di dokumen atau tes.
- **Skala kematangan:**
  - **0**: tidak ada;
  - **1**: rangka atau spesifikasi saja;
  - **2**: jalan dengan celah besar;
  - **3**: kokoh untuk pemakaian nyata satu owner;
  - **4**: tangguh, yaitu kasus tepi, jalur gagal, dan konkurensi ditangani
    dan dites.
- **Verifikasi.** Klaim yang paling menentukan skor diperiksa ulang secara
  manual di kode masing-masing proyek.

| Area | PALUGADA | Paperclip | Multica | Opifer | Buzz | Auto-Company |
|---|---|---|---|---|---|---|
| 1. Model organisasi (peran, tujuan, proyek, tiket) | 3 | **4** | 3 | 3 | 2 | 1 |
| 2. Eksekusi & ketahanan crash | **4** | **4** | **4** | 3 | 2 | 2 |
| 3. Jadwal & pemicu | **4** | **4** | **4** | 3 | 3 | 2 |
| 4. Runtime agen | 3 | **4** | **4** | 3 | **4** | 3 |
| 5. Lapisan tool/kapabilitas & MCP | **4** | **4** | 3 | 3 | 3 | 1 |
| 6. Tata kelola & persetujuan | **4** | 3 | 1 | 3 | 1 | 1 |
| 7. Anggaran & biaya | **3** | 2 | 2 | **3** | 1 | 2 |
| 8. Isolasi antar perusahaan | **4** | 3 | 2 | 1 | 3 | 0 |
| 9. Memori & pengetahuan | **3** | 2 | 2 | **3** | 2 | 2 |
| 10. Integrasi | 2 | 3 | **4** | 2 | 1 | 0 |
| 11. Permukaan owner (web, ponsel, chat, suara) | 3 | 3 | **4** | 3 | 3 | 2 |
| 12. Banyak pengguna & hak akses | 1 | 3 | 3 | 2 | **4** | 0 |
| 13. Observabilitas & audit | 3 | 3 | 3 | 3 | 3 | 2 |
| 14. Keamanan | 3 | 3 | 2 | 2 | 3 | 1 |
| 15. Operasi (deploy, upgrade, backup) | 3 | **4** | 3 | 2 | 3 | 2 |
| 16. Ekstensibilitas (plugin, API, template) | 2 | **4** | **4** | 2 | 3 | 1 |
| **Jumlah (maks. 64)** | **49** | **53** | 48 | 41 | 41 | 22 |

**Jumlah skor bukan intinya; profilnya yang penting.**

- **PALUGADA memimpin di inti keselamatan:** tata kelola (4), isolasi (4),
  anggaran (3, satu-satunya selain Opifer yang mereservasi sebelum kerja),
  dan memori (3).
- **Paperclip dan Multica memimpin di keluasan:** integrasi, runtime,
  ekstensibilitas, banyak pengguna, dan operasi.

### Keunggulan PALUGADA yang terbukti di kode (dan tidak dimiliki kompetitor)

1. **Faktor kedua untuk aksi ireversibel.** Tier 3 selalu butuh owner dengan
   TOTP atau passkey, satu persetujuan terikat ke tepat satu aksi, dan
   persetujuan yang tidak dijawab kedaluwarsa menjadi batal. Tidak satu pun
   dari lima kompetitor punya faktor kedua. Paperclip punya persetujuan
   terikat argumen di gateway MCP-nya, tetapi tanpa 2FA dan tanpa
   kedaluwarsa pada persetujuan board.
2. **Isolasi di database.** Paperclip, Multica, Opifer, dan Buzz
   menegakkannya di kode aplikasi, dan Multica bahkan membuang foreign
   key-nya.
3. **Verifikasi setelah aksi (read-back).** Setiap penulisan tier ≥1 dibaca
   ulang, dan kegagalannya menjadi insiden. Tidak ada kompetitor yang
   memverifikasi hasil aksi.
4. **Jurnal per langkah.** Crash dilanjutkan dari langkah terakhir tanpa
   efek ganda (diuji langsung: `kill -9`, pulih dalam 47 detik, tepat 5
   tiket). Paperclip pulih per run dengan melanjutkan sesi CLI.
5. **Anggaran direservasi sebelum kerja, dan biaya tak berharga tidak pernah
   dianggap gratis.** Paperclip dan Opifer menghitung model tanpa harga
   sebagai 0.
6. **Batas hop, siklus, dan fan-out** antar agen. Kompetitor hanya punya
   batasan parsial atau tidak ada sama sekali.
7. **Bahasa Indonesia penuh** di console (1.563 kalimat). Paperclip hanya
   punya kerangka i18n.

### Kekurangan PALUGADA dibanding kompetitor

1. **Integrasi siap pakai tipis.** Hanya 7 preset vendor, dan tidak satu pun
   jalan tanpa akun. Tidak ada Shopee, Tokopedia, TikTok, Instagram,
   Shopify, maupun kotak masuk email (IMAP). Pembanding: Paperclip punya 80
   definisi aplikasi dengan 87 metode OAuth; Multica punya integrasi GitHub,
   Slack, Telegram, Lark, dan Composio.
2. **Tidak ada kanal untuk pelanggan.** WhatsApp dan Telegram hanya untuk
   owner; nomor lain ditolak (`src/owner/whatsapp.ts:14-18`). Agen belum bisa
   membalas chat pelanggan.
3. **Satu owner saja.** Tidak ada staf, *viewer*, atau penyetuju delegasi.
   Buzz, Multica, dan Paperclip punya peran dan undangan.
4. **Ekstensibilitas.** Tidak ada SDK plugin, token API jangka panjang,
   webhook keluar, maupun jalur menerbitkan bundle pihak ketiga
   (`publishBundle` hanya dipanggil oleh seed). Hanya ada satu template
   perusahaan.
5. **Runtime.** Tidak ada penyedia sandbox (E2B, Daytona, Modal,
   Kubernetes) seperti di Paperclip.
6. **Operasi.** Backup dan PITR hanya berupa dokumen. Paperclip punya backup
   terjadwal dengan retensi dan restore.

### Terdokumentasi "Built" tetapi tidak tersambung ke produk yang berjalan

Diverifikasi manual di kode `2d468df`:

- **Replay kering (F11.4).** `npm start` memanggil `start()` tanpa handler
  (`src/main.ts:1226`), sehingga rute replay selalu menolak
  (`src/owner/api.ts:3530-3541`) dan tombol Replay di halaman Work tidak
  pernah berhasil.
- **Device gateway (F12.7–F12.10).** Console hanya memakai fungsi
  pendaftaran (`src/owner/api.ts:147`). `connect`, `assertWithinQuarantine`,
  dan `claimIdempotencyKey` (`src/gateway/gateway.ts:252,350,376`) tidak
  dipanggil di mana pun.
- **Sandbox kode (F8.10).** `src/sandbox/sandbox.ts` tidak diimpor modul
  mana pun, dan `code.execute` tidak pernah terikat.
- **Pencarian memori berbasis makna.** Tidak ada yang menulis embedding
  memori; `memory.search` hanya mencocokkan kata. Dokumen pengetahuan
  sudah bisa dicari berbasis makna bila provider embedding dipasang.
- **Bundle pihak ketiga dan penerbit tepercaya (F16).** Penerbitan bundle
  hanya terjadi untuk bundle bawaan saat seed.
- **Perubahan struktur yang diusulkan agen (F3.9).** `proposeStructuralChange`
  tidak punya pemanggil.
- **"Token dan uang direservasi sebelum task dimulai"** (`docs/features.md`).
  Yang direservasi hanya token; uang dibebankan per panggilan.

---

## 2. Biaya nyata DeepSeek: koreksi atas laporan sebelumnya

[`MATURITY-RECHECK-2026-09-30.md`](MATURITY-RECHECK-2026-09-30.md) melaporkan
satu tugas pemasaran yang "memakai 325 ribu token", tanpa menghitung
tagihannya. Karena DeepSeek murah, angka itu perlu diukur, bukan ditebak.

### Cara mengukur

- PALUGADA diarahkan ke proxy pencatat yang meneruskan setiap request ke
  DeepSeek **tanpa mengubahnya**, lalu mencatat blok `usage` asli dari
  DeepSeek, termasuk `prompt_cache_hit_tokens` dan
  `prompt_cache_miss_tokens`.
- Tugas yang sama dijalankan ulang di perusahaan uji "Kopi Senja", dengan
  data produk sudah disertakan: rencana Instagram 2 minggu, 3 caption, dan
  draf email.
- Harganya harga resmi DeepSeek untuk `deepseek-flash` per 1 juta token:
  - input cache-hit: $0,003 (off-peak) / $0,006 (peak);
  - input cache-miss: $0,15 / $0,30;
  - output: $0,60 / $1,20.
  - Pengukuran berjalan 22:23 UTC, jadi tarif off-peak yang berlaku.

### Hasil

| | Nilai |
|---|---|
| Panggilan model | 8: 5 giliran agen dan 3 panggilan drafting (`doc.draft`, `email.draft`) |
| Input kena cache | 49.536 token (**85%** dari input) |
| Input tanpa cache | 8.917 token |
| Output | 26.706 token, 20.190 di antaranya *reasoning* |
| **Tagihan DeepSeek nyata** | **$0,0175** off-peak, $0,035 peak |
| Tercatat oleh PALUGADA (harga models.dev sudah disimpan di console) | 8 sen: 4,6× off-peak, 2,3× peak |
| Token yang dihitung ke plafon token PALUGADA | 78.845 (agen saja) |

**Tugas "325 ribu token" kemarin** mengulang giliran reasoning dua kali.
Dengan rasio cache yang sama, biaya nyatanya **±$0,04–0,09**, bukan masalah
uang.

### Masalah yang sesungguhnya: plafon token yang buta harga

- **Plafon token dan uang berjalan terpisah.** Template standar memberi
  setiap perusahaan dua plafon:
  - **2 juta token seumur hidup**, dengan divisi Growth 300 ribu dan Lab
    150 ribu (`src/templates/standard.ts:578, 607-614`);
  - **$200 per bulan**.
- **Dengan DeepSeek, plafon token habis jauh lebih dulu.** 2 juta token
  kira-kira setara **$0,45** biaya nyata, atau ±25 tugas seperti di atas.
  Perusahaan uji sudah memakai **844 ribu dari 2 juta token (42%)** setelah
  sekitar satu jam uji, sementara biaya nyatanya masih di bawah satu dolar.
- **Plafon token tidak pernah reset.** Owner kini bisa menaikkannya dari
  console dengan faktor kedua, tetapi harus menyadarinya dulu. Task yang
  terhenti tidak muncul sebagai item inbox.
- **PALUGADA tidak mengenal harga cache.**
  - `src/llm/openai.ts:134` hanya membaca `prompt_tokens`, jadi
    `prompt_cache_hit_tokens` DeepSeek dan `cached_tokens` OpenAI diabaikan.
  - Klien Anthropic menjumlahkan `cache_read_input_tokens` ke input dengan
    harga penuh (`src/llm/anthropic.ts:161`).
  - Setiap panggilan dibulatkan ke atas minimal 1 sen
    (`src/engine/pricing.ts:84`).
  - Untuk loop agen yang mengirim ulang konteks setiap giliran, ketiganya
    membuat biaya tercatat berlipat dari tagihan nyata.
- **Tidak ada setelan *reasoning effort* atau *thinking*** untuk provider
  OpenAI-compatible. Pesan error di `src/runtime/agent-loop.ts:144` sendiri
  menyarankan menurunkan *reasoning effort*, tetapi PALUGADA tidak punya
  cara untuk mengirim parameter itu.

**Rekomendasi:**

- Jadikan uang (dengan harga model termasuk cache) sebagai batas utama, atau
  jadikan plafon token berperiode bulanan.
- Baca token cache dari `usage` setiap provider.
- Tambahkan setelan *reasoning effort* per tier model.

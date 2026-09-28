# Analisa kematangan PALUGADA dan perbandingan kompetitor (28 September 2026)

Pertanyaan yang dijawab dokumen ini: **apakah PALUGADA sudah sangat handal dan
matang, dan bagaimana posisinya dibanding Buzz, Paperclip, auto-company, dan
kompetitor lain?**

Analisa dikerjakan bertahap. Setiap tahap mengumpulkan bukti sendiri dan tidak
menerima klaim dokumen repositori (README, `STATUS.md`, `RESEARCH-2026-09.md`)
begitu saja.

1. **Menjalankan definisi "selesai" repositori.** `npm run check` dan suite
   dengan coverage dijalankan di PostgreSQL 16 + pgvector.
2. **Uji langsung dengan model AI sungguhan.** PALUGADA dijalankan dengan
   DeepSeek V4.1 Flash, model yang tersedia di environment ini. Uji ini
   bertindak sebagai owner sungguhan: membuat perusahaan, berbicara dengan
   CEO, menugaskan kerja, menjawab pertanyaan agen, dan menyetujui aksi tier 3
   dengan TOTP. Uji ini juga mencakup `kill -9` di tengah run dan simulasi
   plafon token yang habis.
3. **Audit kode.** Tiga subagen AI mengaudit keamanan, keandalan, dan
   kelengkapan produk. Temuan terberat lalu diverifikasi ulang secara manual,
   baris per baris dan secara empiris.
4. **Riset kompetitor.** Empat subagen AI meriset kompetitor. Repositori
   Paperclip, Buzz, dan Auto-Company di-clone pada HEAD terbaru dan dibaca
   kodenya. Klaim kunci diverifikasi ulang langsung di kode mereka dan di
   halaman GitHub publik.

Revisi yang dianalisa: PALUGADA `61dbfa6` (27 Sep 2026), Paperclip `0f14d26`,
Buzz `b0d6fb8`, Auto-Company `8becd54`.

---

## 1. Jawaban singkat

**Belum.** Inti rekayasa PALUGADA memang kuat, dan pada beberapa properti
keselamatan paling ketat di antara semua sistem sejenis yang diperiksa.
Namun sebagai produk ia masih **alpha lanjut**, belum "sangat handal dan
matang".

**Yang sudah matang: fondasi.**

- **Isolasi tenant dipaksakan oleh database.** Row-level security dipaksakan
  (FORCE RLS) pada setiap tabel tenant, dan foreign key membawa `company_id`.
- **Gerbang aksi ireversibel.** Aksi tier 3 terbukti tertahan sampai owner
  menyetujui dengan faktor kedua. Satu persetujuan menghasilkan tepat satu
  aksi, dengan idempotency key.
- **Anggaran dan eksekusi.** Anggaran direservasi sebelum kerja dimulai, dan
  eksekusi dijurnal dengan lease: terbukti pulih dari `kill -9` tanpa efek
  ganda. Tersedia 1.027 tes yang semuanya lulus.

**Tidak ada kompetitor open-source yang diperiksa yang memiliki kombinasi
ini.** Paperclip, Buzz, dan Auto-Company tidak memakai RLS. Tidak satu pun
meminta faktor kedua. Paperclip bahkan mencatat biaya yang tak berharga
sebagai 0 sen.

**Yang belum matang: bukti operasi nyata dan kelengkapan produk.**

- **Umur dan adopsi.** Proyek berumur 26 hari (commit pertama 2 September
  2026), punya satu penulis, 0 pengguna, 0 bintang, tanpa lisensi, dan tanpa
  rilis. Kriteria keluar Fase 0/1 di PRD (7 dan 14 hari operasi nyata) belum
  mungkin terpenuhi.
- **Uji langsung dengan model sungguhan menemukan cacat yang lolos dari
  1.027 tes.** Tugas pertama owner ("buatkan draf rencana pemasaran") gagal
  pada ketiga upaya: task asli dan dua rerun, masing-masing tiga percobaan.
  Kegagalan itu disebabkan dua cacat berbeda (L4 dan L5) dan diperparah
  cacat ketiga (L6).
- **Plafon token perusahaan bersifat seumur hidup.** Plafon ini tidak pernah
  reset dan tidak bisa dinaikkan lewat console. Perusahaan yang
  menghabiskannya berhenti permanen kecuali ada intervensi SQL.
- **Integrasi dunia nyata masih harus dirakit tangan.** Perlu file JSON
  vendor, restart, `INSERT` SQL untuk kredensial, dan penukaran tool peran.
  Tidak ada katalog konektor atau OAuth.

**Skor ringkas** (0–10, 10 = siap produksi untuk bisnis nyata):

| Dimensi | PALUGADA | Paperclip | Buzz | Auto-Company |
|---|---|---|---|---|
| Rigor rekayasa inti | **8** | 6 | 6 | 5 |
| Keamanan & tata kelola agen | **7** | 4 | 3 | 2 |
| Keandalan operasional | 5 | 6 | 5 | 5 |
| Kelengkapan produk & integrasi | 3 | **8** | 6 | 3 |
| Adopsi, ekosistem, keberlanjutan | 1 | **9** | 7 | 4 |
| **Kematangan keseluruhan** | **4,5 — alpha lanjut** | 5,5 | 4 (2–3 sebagai control plane agen) | 3 |

PALUGADA unggul pada hal yang paling sulit ditiru, yaitu keselamatan di
lapisan database dan engine. Ia kalah telak pada hal yang paling menentukan
pasar: ekosistem, integrasi, dan bukti operasi nyata.

---

## 2. Tahap 1 — suite dan kesehatan kode

| Ukuran | Hasil |
|---|---|
| `npm run typecheck` | lulus (7,8 dtk) |
| Build console (Vite + typecheck) | lulus (9 dtk); satu peringatan `INEFFECTIVE_DYNAMIC_IMPORT` untuk `Work.tsx` |
| `npm run test:coverage` | **1.027 dari 1.027 lulus**, 0 gagal, 0 dilewati, 6 mnt 50 dtk |
| Coverage `src/` | fungsi 94,3%; branch 85,5%; baris 97,5%; setiap file `src/` dimuat oleh tes |
| Log PostgreSQL selama suite | 432 baris. Semua `ERROR` adalah penolakan yang memang diuji (RLS, constraint, grant, byte NUL di `owner-channels.test.ts:345`) |
| Ukuran kode | 53,4 rb baris TS server, 43,1 rb baris tes, 14,0 rb baris console, 77 migrasi, 179 rute API |
| Status PRD (`STATUS.md`) | 146 kebutuhan: 142 "Built", 4 "Partial", 0 "Not built" |

Audit subagen menemukan setidaknya enam nilai "Built" yang terlalu tinggi:

- **F3.1, F3.6, F3.11 (charter).** `src/main.ts:609` memanggil
  `seed({ keepPublished: true })` tanpa `charterRoot`, dan tidak ada rute
  API yang menulis charter. Deployment uji langsung berisi **0 charter**.
- **F2.5.** Kebutuhan ini berbunyi "tidak ada jabatan C-level bawaan",
  padahal template standar memuat CEO, CPO, CTO, CMO, dan CFO.
- **F13.5 dan F12.9.** Backend default adalah `local`, bukan `docker`.
- **F11.3.** Dashboard biaya tidak punya dimensi runtime.
- **F4.2.** Pencarian produksi memakai full-text search; pgvector terpasang
  tapi tidak dipakai.
- **F9.4.** Tidak ada review anggaran bulanan.

`STATUS.md` jujur dan sangat rinci, tetapi berbentuk buku harian audit
sepanjang 3.735 baris, sehingga beberapa barisnya basi.

**Sinyal kesehatan proyek:**

- 190 commit, satu penulis, dikerjakan pada 7 hari aktif antara 2 dan 27
  September. Puncaknya 86 commit dalam sehari, dan pola ini menunjukkan
  pengerjaan oleh agen koding.
- Tidak ada `LICENSE`, tag, rilis, CHANGELOG, atau issue.
- Default branch masih `claude/palugada-orchestrator-prd-w7f657`, bukan
  `main`.
- CI punya 180 run; 3 dari 10 run terakhir gagal (run 172, 173, 176) sebelum
  diperbaiki.

---

## 3. Tahap 2 — uji langsung dengan DeepSeek V4.1 Flash

**Konfigurasi uji:**

- Satu proses PALUGADA dengan database terpisah (`palugada_live`).
- Model `deepseek-flash` (DeepSeek-V4.1-Flash) untuk tier `fast` dan
  `standard`, serta `deepseek-v4-pro` untuk tier `deep`, lewat API
  OpenAI-compatible.
- Tanpa daftar harga model, sesuai quickstart.
- Owner bertindak lewat API console dengan TOTP.
- Dua perusahaan dibuat: "Kopi Senja" (dengan bundle `company-os`, yaitu
  opsi "Let it run itself") dan "Toko Batik".

### 3.1 Kronologi

| Waktu (UTC) | Kejadian | Nilai |
|---|---|---|
| 00:52 | Boot. Log boot jujur dan jelas: 10 kapabilitas terikat platform (13 setelah `PALUGADA_FILES_ROOT` diisi), **34 butuh vendor atau konfigurasi**, tanpa daftar harga, tanpa kanal push/Telegram | ✔ |
| 00:53 | Perusahaan dibuat (8 divisi, 8 peran) dengan faktor kedua. Bundle `company-os` langsung mengantrikan **9 task review skill** | — |
| 00:53:53 | Owner menulis (dalam bahasa Indonesia) ke CEO: minta rencana Instagram 2 minggu, 3 caption, dan email pelanggan setia, **draf saja**. CEO menjawab dalam **14,5 detik** dalam bahasa Indonesia: membaca struktur tim, mencatat bahwa memori perusahaan kosong, **menolak mengarang harga**, dan mengajukan kartu penugasan ke CMO dengan batas tegas "tidak ada `email.send`/`social.publish`" | ✔ sangat baik |
| 00:54:06 | Owner menerapkan kartu, dan wake `assignment` berprioritas 0 dibuat | — |
| 00:54–00:59 | Task owner **menunggu 5 menit 33 detik** di belakang 9 review skill otomatis. Worker menjalankan task satu per satu dalam satu *tick*. `/api/health` tetap `ok:true` walau `lastTickAt` membeku lebih dari 6 menit | ✘ |
| 01:00:02 | CMO bertanya balik ke owner (tanggal peluncuran) dengan pilihan jawaban, alih-alih mengarang | ✔ |
| 01:02:31 | Owner menjawab. Run berlanjut, lalu **gagal 3 kali dalam 1 detik**: `400 Invalid assistant message: content or tool_calls must be set` | ✘ **cacat L4** |
| 01:04 | Rerun pertama membawa jawaban owner. Agen menghabiskan 3 panggilan mencoba CRM yang tidak terikat, lalu bertanya ke owner "bind HubSpot atau Salesforce?", pertanyaan konfigurasi yang tidak bisa diselesaikan dari inbox | ✘ |
| 01:06:49 | Rerun gagal lagi dengan pola L4 yang sama (terreproduksi 2 dari 2 kali) | ✘ |
| 01:07 | *Workaround uji:* proxy lokal mematikan mode *thinking* DeepSeek. Rerun ketiga menulis 4 draf dalam 45 detik, tetapi **task tetap `failed`**: kriteria selesai CMO bawaan tidak mungkin terpenuhi | ✘ **cacat L5** |
| 01:09 | Perusahaan kedua dengan token disimulasikan hampir habis: penugasan ditolak (`budget.reservation_refused`). Owner membuka akun budget baru dengan faktor kedua, tetapi **tetap ditolak** | ✘ **cacat L11 (P0)** |
| 01:10:42 | `kill -9` pada proses saat task sudah membuat 2 dari 5 tiket | — |
| 01:13 | Setup tier 3 (`record.delete` ke vendor tiruan). Perlu file vendor, restart, grant bertanda faktor, `INSERT` SQL kredensial (divalidasi least privilege oleh trigger DB ✔), dan penukaran tool CEO (batas 12 tool) | ⚠ gesekan |
| 01:13:52 | CEO diminta menghapus data pelanggan `cust-042`. Task berhenti di `waiting_approval`, dan **vendor tidak menerima DELETE apa pun** | ✔ |
| 01:14 | Approve tanpa faktor kedua ditolak **403 `approval.channel_forbidden`**. Approve dengan TOTP menghasilkan **tepat 1 DELETE** dengan idempotency key | ✔ **terbukti** |
| 01:14:26 | Read-back GET mengembalikan 404 (record memang terhapus), tetapi task **`halted: verification_failed`**. Owner menerima 2 insiden dan 1 alert untuk aksi yang sebenarnya berhasil | ✘ **cacat L10** |
| 01:10–01:26 | Task yang di-`kill -9` tetap dipegang lease worker mati selama **±15 menit**. Setelah itu task dilanjutkan dari jurnal **tanpa efek ganda** (tepat 5 tiket) dan `completed` pukul 01:26:02 | ✔ benar, ⚠ lambat |

### 3.2 Cacat yang ditemukan uji langsung

Cacat-cacat ini tidak tertangkap 1.027 tes karena tes memakai model tiruan dan
vendor tiruan yang dirancang sendiri. Pemeriksaan boot (`scripts/smoke.ts`)
bahkan memakai template khusus. Komentarnya sendiri menjelaskan alasannya:
template standar tidak bisa berjalan di instalasi baru tanpa vendor.

| # | Keparahan | Cacat | Bukti |
|---|---|---|---|
| L4 | **Tinggi** | Model *reasoning* yang menghitung token berpikir ke dalam `max_tokens` (DeepSeek V4 mode default; berpotensi juga model reasoning lain) membuat run gagal. Batas per panggilan dikunci `Math.min(8_192, …)`. Saat model menghabiskan 8.192 token untuk berpikir, `content` kosong, `stopReason: 'max_tokens'` tidak ditangani, dan giliran kosong didorong ke riwayat. API menolak (400), lalu **percobaan ulang me-replay giliran kosong dari jurnal**, sehingga 3 percobaan habis dalam 1 detik tanpa panggilan model baru. Operator tidak punya setelan untuk menaikkan batas atau menurunkan *effort* | `src/runtime/agent-loop.ts:108`, `:126`; `src/llm/openai.ts` (`toWire`: `content: text \|\| null`). Trace: `output_tokens = 8192`, `content: []` (2 dari 2 kali) |
| L5 | **Tinggi** | Peran CMO bawaan **tidak bisa menyelesaikan task apa pun** di instalasi baru. Kriteria selesainya ("catatan pelanggan menyebut apa yang dikirim dan ke siapa") butuh `crm.note`, yang tidak terikat tanpa vendor. Draf sudah jadi, tetapi agen dengan jujur melaporkan kriteria tidak terpenuhi, dan 3 percobaan gagal identik | `src/templates/standard.ts:399`, `:259-260`; event `task.attempt_failed` |
| L11 | **P0** | Plafon token perusahaan dan divisi bersifat **seumur hidup**. `tokens_spent` hanya bertambah, tidak ada kolom periode, dan tidak ada rute untuk menaikkan `tokens_max`. Membuka akun baru tidak membantu karena reservasi tetap ke rantai akun lama. Perusahaan standar punya 2 juta token (divisi Lab 150 rb). Dengan ±7–20 rb token per run, itu cukup untuk ~100–280 run **seumur hidup** perusahaan, sebelum plafon $200/bulan tercapai | `db/migrations/0003:197`, `0024:111` (hanya `+`); simulasi di §3.1 pukul 01:09 |
| L10 | Sedang | Read-back tidak bisa memverifikasi penghapusan lewat 404. `if (answer.status >= 400) return false` dieksekusi **sebelum** aturan `matches.status` diperiksa, padahal skema vendor menerima `status: 404` saat boot. Delete tier 3 yang berhasil dilaporkan gagal, memicu insiden, dan menahan task. Tidak ada tes untuk kasus ini | `src/capabilities/http.ts:348`; `src/capabilities/vendors.ts:331-333` |
| L3 | Sedang | *Head-of-line blocking*: satu worker per proses menjalankan task berurutan, sehingga tugas owner (prioritas 0) menunggu di belakang pekerjaan otomatis. Audit keandalan menunjukkan dampak lanjutannya: expiry approval, notifikasi, dan jeda anggaran juga tertahan selama run panjang | `src/worker.ts:305-447`, `:533` |
| L8 | Sedang | Charter tidak pernah dimuat di produksi. Reviewer **menolak 5 dari 9 skill bawaan** dengan alasan "charter dan policy perusahaan tidak disediakan", dan penolakan ini terlihat di beranda console | `src/main.ts:609`; `charters` = 0 baris |
| L6 | Sedang | Jawaban owner terbawa tidak konsisten. Rerun pertama (`862adf55…`) membawa harga dan akun Instagram di briefing-nya, tetapi rerun dari rerun (`7c2091a2…`) tidak. Draf akhir berisi "[TBD: harga]" padahal harga sudah diberikan owner dua kali | `agent_runs.briefing`: memuat "95.000" pada `862adf55`, tidak pada `7c2091a2` |
| L12 | Sedang | Biaya fallback: PALUGADA mencatat **$8,42** untuk 34 panggilan (203 rb token input, 69 rb output). Biaya DeepSeek sebenarnya ≈ **$0,14** (harga puncak, tanpa cache), jadi overestimasi ~58×. `npm run setup` dan console tidak pernah menulis daftar harga, sehingga plafon default $200 setara ~$3,4 biaya nyata. Ini disengaja (lebih baik berhenti terlalu awal), tetapi tanpa bantuan harga di setup, efeknya mengejutkan | `llm_traces`; harga resmi DeepSeek |
| L7 | Rendah | Agen mengeskalasi pertanyaan konfigurasi ("bind vendor CRM mana?") yang tidak bisa dijawab owner dari inbox, karena peran template diberi kapabilitas yang tidak terikat | inbox item `0ad05feb…` |
| L9 | Rendah | Kartu approval tier 3 berjudul generik "Run record.delete". Argumen (`recordId: cust-042`) ada di payload, tetapi tidak ikut dalam respons daftar inbox | `GET /inbox` tidak mengembalikan `input` |
| L18 | Rendah | Rute `POST …/inbox/:id/answer` mencatat jawaban tetapi tidak melanjutkan task pertanyaan agen, padahal komentar kodenya bilang "puts the task back on the queue". Console memakai `decide(approve, note)`, jadi owner di console tidak terkena | `src/owner/api.ts:2863-2876`, `src/inbox/inbox.ts:1676` |

### 3.3 Yang terbukti bekerja di uji langsung

- **Gerbang tier 3**: tidak ada efek eksternal sebelum persetujuan. Tanpa
  faktor kedua, persetujuan ditolak 403. Dengan TOTP, terjadi tepat satu aksi
  dengan idempotency key. Kartu menampilkan tier, kedaluwarsa 72 jam,
  konsekuensi bila ditolak, dan rantai tujuan.
- **Isolasi tenant di database** (diperiksa langsung di katalog PostgreSQL):
  - 66 tabel, 54 di antaranya punya `company_id`; 52 FORCE RLS + policy.
  - Dua sisanya (`assistant_messages`, `telegram_topics`) sama sekali tidak
    punya grant untuk role aplikasi.
  - Role aplikasi hanya bisa `SELECT` pada `capabilities` dan
    `platform_control`.
- **Least privilege kredensial ditegakkan database**: kredensial dengan scope
  yang belum di-grant ditolak oleh trigger (F12.6).
- **Database tetap bersih**: log PostgreSQL selama uji langsung tidak memuat
  satu pun error dari role aplikasi. Semua `ERROR` berasal dari kueri manual
  analis.
- **Penolakan anggaran yang eksplisit**: penugasan tanpa dana ditolak dengan
  pesan jelas, tidak menggantung diam-diam.
- **Kualitas agen**: CEO membumi dan tidak mengarang, CMO bertanya alih-alih
  menebak, dan draf berbahasa Indonesia layak pakai setelah diisi.
- **Console**: rapi, cepat, responsif di ponsel (navigasi bawah), dan
  menandai run yang diam ("Quiet since 6 min. ago").
- **Kunci model dari environment tidak bocor**: temuan keamanan #1 di §4.1
  hanya berlaku bila kunci disimpan lewat console. Ini diuji dengan listener
  penangkap header, dan hasilnya `hasAuth: false`.
- **Pemulihan crash (`kill -9`) benar.** Proses dibunuh saat 2 dari 5 tiket
  sudah dibuat.
  - Setelah lease kedaluwarsa (01:25:46), worker baru melanjutkan dari
    jurnal. Tiket yang sudah dibuat **tidak dibuat ulang**, dan giliran model
    yang sudah dijurnal tidak dipanggil lagi.
  - Hasilnya tepat 5 tiket dengan 5 judul berbeda, dan task `completed`
    pukul 01:26:02.
  - Harga yang dibayar: **±15 menit mati suri** (panjang lease). Di satu
    host, proses baru dengan *boot id* berbeda sebenarnya bisa tahu bahwa
    pemegang lease sudah mati, tetapi tetap menunggu.

---

## 4. Tahap 3 — audit kode (diverifikasi)

### 4.1 Keamanan — 7/10

**Terverifikasi kuat:**

- **Row-level security.** FORCE RLS pada setiap tabel tenant, `set_config`
  berparameter, dan pool aplikasi terpisah dari pool admin.
- **Gerbang tier 3 lengkap.** Kanal chat tidak bisa memutuskan tier 3,
  `decideMany` melewati tier 3, dan persetujuan terikat pada fingerprint
  argumen serta "dibelanjakan" sebelum eksekusi.
- **TOTP.** Perbandingan waktu-konstan dan klaim langkah atomik anti-replay.
- **WebAuthn.** Memeriksa origin, rpIdHash, UP+UV, dan counter.
- **SSRF.** Setiap alamat hasil resolve diperiksa dan koneksi di-*pin*;
  setiap redirect diperiksa ulang.
- **Rahasia.** AES-256-GCM dengan nama rahasia sebagai AAD.
- **Runtime CLI.** Tanpa environment warisan dan dengan HOME sendiri.
- **Docker.** `--network none`, `--read-only`, `--cap-drop ALL`.
- **Console.** CSP ketat, tanpa `innerHTML`.
- **Dependensi server.** Hanya 3 dependensi.

**Temuan (diverifikasi manual):**

| Keparahan | Temuan | Catatan verifikasi |
|---|---|---|
| Tinggi (kondisional) | Asisten owner boleh memanggil `/api/control/settings/model/models` dan `/test` tanpa kartu persetujuan. `modelSettingFrom` memakai ulang kunci tersimpan bila **provider** sama tanpa membandingkan URL, sehingga kunci bisa dikirim ke host lain lewat injeksi prompt | Kode dikonfirmasi (`src/owner/api.ts:4545`, `src/owner/assistant-actions.ts:507-511`). Uji empiris: kunci dari **env** tidak bocor; risiko berlaku untuk kunci yang disimpan via console |
| Sedang | Gerbang taint F8.9 bisa "dicuci". `outsideContentIn` hanya menelusuri rantai **ke atas**, sehingga induk yang menerima output anak "terkontaminasi" lewat `task.await` tetap bersih dan boleh melakukan aksi tier 2 | Dikonfirmasi (`src/engine/tasks.ts:120-137`) |
| Sedang | Kapabilitas tier 0 (`web.fetch`) bisa dipakai mengeksfiltrasi data oleh task yang tercemar; tidak ada allow-list egress default | Desain; didokumentasikan sebagai risiko injeksi saja |
| Sedang | Lockout MFA global (10 gagal per 15 menit) dengan throttle 5 per alamat. Dua alamat cukup untuk mengunci owner dari console dan persetujuan tier 3 | Dikonfirmasi (`src/owner/mfa.ts:96-97`); komentar kode mengakui trade-off ini |
| Sedang | Impor perusahaan memulihkan approval yang sudah diputuskan dan referensi rahasia dari arsip | Laporan subagen; dilindungi faktor kedua owner |
| Rendah | Role aplikasi masih bisa `UPDATE` `inbox_items`; token env di baris perintah `docker`; `/api/health` membocorkan teks error DB; celah IPv6 kecil | Laporan subagen |

### 4.2 Keandalan — 6/10 menurut audit kode, 5/10 setelah uji langsung

Kebenaran saat crash dinilai ±7,5 dan terbukti di §3.3. Ketersediaan dan
skala dinilai ±4, dan diperburuk oleh L3 dan L4.

**Terverifikasi kuat:**

- **Klaim task atomik.** Memakai advisory lock plus `FOR UPDATE SKIP LOCKED`.
- **Transisi state di bawah row lock.**
- **Jurnal yang dipagari `attempt`.** Pemegang lease lama tidak bisa
  meng-commit langkah.
- **Idempotency key wajib** untuk setiap write HTTP.
- **Aritmetika anggaran di database** dengan urutan kunci tetap, sehingga
  tidak ada deadlock atau overspend.
- **Batas hop dan deteksi siklus.**
- **SIGTERM ditangani sebelum boot.**

**Temuan utama:**

- **H1: worker serial.** Satu run panjang menahan expiry approval,
  notifikasi, jadwal, dan jeda anggaran untuk semua perusahaan di replika
  itu. Terbukti langsung sebagai L3.
- **H2: gangguan vendor sesaat menjadi halt permanen.** Preflight yang
  menerima 429/5xx menandai kapabilitas tidak sehat selama 15 menit, dan
  semua task yang memakainya di-*halt*.
- **H3: rate limit penyedia model tidak di-*park*.** Hanya 2 retry (±35
  detik), lalu task di-*halt*.
- **H4: resume per langkah hanya berlaku untuk runtime in-process.** Runtime
  CLI mulai dari awal; restart karena perubahan setelan menjadi halt
  `journal.divergence`.
- **M6: jeda bulanan menghancurkan antrean.** Task di-*halt* satu per satu,
  dan jeda tidak terangkat otomatis di awal bulan.
- **M10: tabel tanpa batas.** `task_steps`, `agent_runs`, dan tabel lain
  tumbuh tanpa batas, dan retensi menghapus tanpa batch.
- **Tanpa metrik dan tracing.**

**Plafon skala realistis:** ±1.400 task/hari per replika (run ±60 detik).
Target PRD v1 (5.000/hari) butuh 4–6 replika.

### 4.3 Produk dan operasi — 3/10 kesiapan pasar

- **Integrasi (46 kapabilitas di katalog):**
  - Sejak boot hanya 10 yang terikat (8 kapabilitas platform, `web.fetch`,
    dan `uptime.check`); jumlahnya menjadi 13 bila `PALUGADA_FILES_ROOT`
    diisi.
  - Log boot menyebut 34 sisanya butuh vendor atau konfigurasi: 8 cukup
    dengan konfigurasi, 26 butuh entri vendor.
  - Contoh vendor yang dikirim: Resend, Cloudflare, Midtrans QRIS sandbox,
    Mastodon, dan Plausible.
  - MCP hanya lewat Streamable HTTP dengan token statis, tanpa OAuth.
  - **Belum ada satu pun loop bisnis nyata** (mengirim email ke pelanggan,
    menerima pembayaran, menerbitkan situs, posting media sosial populer)
    yang berjalan tanpa merakit konfigurasi dengan tangan.
- **Operasi:**
  - Tidak ada metrik atau tracing (PRD meminta OpenTelemetry/Langfuse).
  - Tidak ada backup otomatis atau PITR.
  - Tidak ada rotasi master key.
  - Tidak ada rilis bertag; peningkatan versi berarti `git pull` di branch
    `claude/…`.
  - Linux saja.
- **Satu owner dan dua bahasa.** Hanya satu owner, tanpa delegasi atau SSO
  (keputusan desain NG3). Console dua bahasa (1.563 kalimat, 100%
  diterjemahkan), dan ini keunggulan unik untuk pasar Indonesia.

---

## 5. Tahap 4 — kompetitor

### 5.1 Ringkasan adopsi dan aktivitas

Diperiksa 28 September 2026 di halaman GitHub publik, clone repositori, npm,
dan Discord.

| | PALUGADA | Paperclip | Buzz (Block) | Auto-Company (MaxMiksa) |
|---|---|---|---|---|
| Bintang / fork | 0 / 0 | **89,9 rb / 15,7 rb** | 35,1 rb / 4,6 rb | 3,1 rb / 492 |
| Lisensi | **tidak ada** | MIT (+ "Paperclip EE" proprietary) | Apache-2.0 | MIT |
| Umur | 26 hari | ±7 bulan (Feb 2026) | ±7 bulan (Mar 2026), rilis publik 21 Jul 2026 | ±7 bulan |
| Commit / kontributor | 190 / 1 | 4.603 / 224 (62% satu maintainer) | 2.728 / 107 | ±130 riil (447 di-*backfill*) / 1 |
| Aktivitas 90 hari | 190 commit (semuanya di September) | 1.734 commit, 81 penulis | 1.614 commit; turun tajam (Jul 898 → Agu 512 → Sep 170) | 74 commit |
| Rilis | 0 | 26 stabil + canary harian | 202 tag (desktop, mobile, relay) | 10 rilis (v1.2–v2.0) |
| Isu / PR terbuka | 0 / 0 | ±2,5 rb / ±3,4 rb | ±1,6 rb / ±2,1 rb | 2 |
| Tes | 1.027 (PostgreSQL nyata) | ±23 rb kasus | ±11 rb | 552 (Python) |
| Komunitas | — | Discord ±8 rb; npm ±113 rb/bulan | HN 378 poin; buzz.xyz hosted (preview) | — |

### 5.2 Perbandingan kemampuan

Setiap klaim negatif tentang kompetitor diverifikasi langsung di kode mereka
pada HEAD tersebut.

| Dimensi | PALUGADA | Paperclip | Buzz | Auto-Company |
|---|---|---|---|---|
| Isolasi antar perusahaan | **FORCE RLS di DB** + FK komposit | Hanya kode aplikasi: **0 RLS** di 287 file migrasi; FK inti satu kolom | Predikat `community_id` di aplikasi; RLS dispesifikasikan tetapi **tidak dikirim** (0 policy) | Tidak ada tenancy |
| Aksi ireversibel | Tier 3: owner + **faktor kedua**; satu approval = satu aksi; kedaluwarsa jadi batal | 4 jenis approval board, **tanpa kedaluwarsa, tanpa 2FA**; approval hiring **default off**. Gateway MCP punya approval per-argumen yang kedaluwarsa 1 jam (kekuatan nyata) | Izin tool agen **di-auto-approve** (`acp.rs:1981`); perbaikan fail-closed di-*revert* 3 hari kemudian; gerbang approval workflow selalu gagal | "**Do not wait for human approval**" (`CLAUDE.md:13`) |
| Default izin agen | Tanpa kredensial, tool dibatasi, tanpa environment warisan | `dangerouslySkipPermissions` **default true** (`execute.ts:434`); Codex bypass sandbox | `bypass-permissions` default | `bypassPermissions` / `danger-full-access` |
| Biaya tak berharga | Dibebankan harga fallback tinggi | **Dicatat 0 sen**, hard stop tak pernah terpicu (`heartbeat.ts:5209-5216`) | Tidak ada budget | Dianggap "unverifiable" lalu jeda (fail-closed) |
| Model anggaran | **Reservasi sebelum kerja**, per task/bulan, breaker laju | Dicek setelah kejadian; tidak bisa menghentikan run yang sedang jalan (isu #11276) | Tidak ada | Opsional, dicek setelah siklus |
| Durabilitas | Jurnal per langkah + lease + fencing | Tingkat run; reaper yatim; kunci start in-memory | Log event durable; run workflow tidak durable | Rollback atau tandai siklus; tanpa jurnal |
| Loop agen-ke-agen | Batas hop + deteksi siklus | Tanpa penghitung hop; batas 20 tulisan lintas-isu per run | Tanpa batas | Tidak relevan |
| Runtime | In-process (model apa pun), 6 CLI, HTTP, Docker | **15 adapter + 8 penyedia sandbox** | goose, Claude, Codex, buzz-agent + ±10 preset, pod K8s | Claude/Codex/Cursor CLI |
| Integrasi | Vendor JSON + MCP allow-list; **tanpa OAuth** | **79 app** dengan OAuth, gateway MCP, plugin SDK, Slack/Discord/Telegram/Teams/iMessage/email | MCP, workflow YAML, git hosting | `gh`/`wrangler` pra-otentikasi |
| Observabilitas | Log JSON + `/api/health` | OTel (traces), Sentry, telemetri on | **OTel + Prometheus**, audit hash-chain | Log lokal + dashboard |
| Pengguna | 1 owner (desain) | owner/admin/operator/viewer/member; tanpa SSO self-host | Peran kanal dan relay; identitas kriptografis per agen | 1 |
| Bahasa | **EN + ID penuh** | Praktis EN saja (`id.json` = 3 string) | EN | EN + zh-CN |
| Deploy | Compose/Node + PG; Linux | `npx` onboard, Docker, ECS; cloud (waitlist) | Image GHCR, Helm, Railway, desktop, mobile | Mac/WSL lokal |

### 5.3 Profil singkat dan penilaian

- **Paperclip: 5,5/10, kompetitor langsung dan pemenang pasar saat ini.**
  - **Kekuatan:** premis identik ("orkestrasi perusahaan tanpa manusia"),
    ekosistem sangat besar, kecepatan rilis tinggi, 79 konektor OAuth, gateway
    MCP yang matang, UX yang dipuji, dan cloud yang segera hadir.
  - **Kelemahan, diverifikasi:** tanpa RLS, biaya tak berharga dianggap 0,
    approval board tanpa kedaluwarsa atau 2FA, default izin agen berbahaya,
    tanpa hop limit, file-dewa 30–38 rb baris, 318 `catch` kosong, dan
    ±5,9 rb isu/PR terbuka.
- **Buzz: 4/10 (2–3 sebagai control plane agen yang diatur).**
  - **Kekuatan:** merek Block/Dorsey, 35 rb bintang, identitas kriptografis
    dan audit hash-chain, desktop, mobile, dan hosted.
  - **Kelemahan:** fondasi tata kelolanya belum ada (auto-approve, approval
    tidak jalan, tanpa RLS, tanpa budget). Aktivitas menurun tajam di bulan
    September.
- **Auto-Company: 3/10.** Harness hobi yang rapi (supervisor proses kuat,
  CI tiga OS). Tata kelolanya hanya di prompt, dan agen memegang kredensial
  penuh. Ancamannya ada pada *distribusi*: instalasi beberapa menit memakai
  langganan Claude/Codex owner.
- **Kompetitor lain yang relevan:**
  - **Multica** (51,5 rb★): 26 CLI agen, cloud dan self-host, peran,
    aplikasi mobile.
  - **Opifer** (5★, dibuat sekitar 20 Sep 2026, AGPL): daftar fiturnya
    **hampir identik** dengan PALUGADA (budget direservasi sebelum panggilan
    model, approval, Telegram, rahasia terenkripsi, PostgreSQL), tetapi satu
    organisasi per instalasi. Ini bukti bahwa *daftar fitur* PALUGADA bisa
    ditiru dalam hitungan minggu; yang sulit ditiru adalah kebenarannya.
  - **Polsia** (hosted): $30 jt pada valuasi $250 jt. Datanya sendiri
    menunjukkan 29.132 dari 484.592 perusahaan yang dibuat masih aktif
    (±6%). Tanpa gerbang persetujuan, Trustpilot 2,9.
  - **Pemain platform** mulai menjual primitif yang sama:
    - Claude Managed Agents: izin per tool `always_ask`.
    - Microsoft Agent 365: $15/pengguna.
    - OpenAI Frontier.
    - AWS AgentCore: kebijakan Cedar.
  - **Lainnya:** n8n (206 rb★) dan Temporal ($12,55 miliar) untuk yang ingin
    merakit sendiri.

### 5.4 Posisi di peta

PALUGADA ada di kuadran **self-hosted × governance-first × satu owner banyak
perusahaan**. Di kuadran yang sama ada Paperclip (lebih lengkap, lebih
longgar), Opifer (klon muda), dan Multica (untuk tim).

**Pembeda yang benar-benar langka** (tidak ditemukan bersamaan di
kompetitor mana pun):

1. Isolasi di database.
2. Faktor kedua untuk aksi ireversibel berbasis tier reversibilitas.
3. Reservasi anggaran lintas runtime, termasuk CLI.
4. Jurnal per langkah bersama tata kelola dalam satu kotak self-hosted.
5. Lokalisasi Indonesia.

**Yang bukan pembeda:** membungkus CLI agen, bagan organisasi, dan
"budget + approval" sebagai daftar fitur.

---

## 6. Kesimpulan: seberapa jauh dari "sangat handal dan matang"?

"Matang" menuntut tiga hal. PALUGADA baru memenuhi yang pertama.

1. **Desain yang benar**: ✔ sudah, dan di atas pasar.
2. **Bukti bahwa desain itu bertahan di dunia nyata** (model sungguhan,
   vendor sungguhan, operasi berhari-hari): ✘ belum. Uji langsung pertama
   menemukan:
   - dua cacat yang membuat tugas owner gagal (L4, L5);
   - satu cacat yang menurunkan mutu hasilnya (L6);
   - satu cacat P0 yang mematikan perusahaan secara permanen (L11);
   - satu cacat verifikasi pada jalur tier 3 (L10).
3. **Produk yang bisa diadopsi orang lain** (lisensi, rilis, integrasi siap
   pakai, komunitas): ✘ belum.

### 6.1 Rekomendasi prioritas

**P0: perbaiki sebelum siapa pun memakai PALUGADA untuk bisnis nyata.**
Setiap butir di bawah bisa dimulai dengan tes gagal sesuai `AGENTS.md`.

1. **L11.** Jadikan plafon token berperiode (reset bulanan seperti uang) atau
   bisa dinaikkan dari console dengan faktor kedua. Tambahkan tes "perusahaan
   yang kehabisan token bisa dipulihkan tanpa SQL".
2. **L4.**
   - Tangani `stopReason: 'max_tokens'`: jangan dorong giliran kosong;
     minta lanjut atau naikkan batas.
   - Jadikan batas per panggilan bisa diatur per tier atau model.
   - Jangan replay giliran model yang ditolak API; buka ulang seperti
     perbaikan `6864386`.
   - Tambahkan tes dengan klien tiruan yang meniru model reasoning
     (konten kosong + `finish_reason: length`).
3. **L5.** Selaraskan kriteria selesai template dengan kapabilitas yang
   benar-benar terikat. Pilihannya: kriteria kondisional, kriteria yang
   bebas CRM, atau menahan peran sampai vendor-nya terikat. Tambahkan tes
   "setiap peran template bisa menyelesaikan task di instalasi baru".
4. **L10.** Periksa `matches.status` sebelum menolak read-back ≥400, dan
   tambahkan tes verifikasi delete lewat 404/410.
5. **Keamanan #1.** Pakai ulang kunci tersimpan hanya bila origin sama
   (seperti `#mcpToken`), keluarkan `url` dari cek yang boleh dipanggil
   asisten, dan lewatkan lewat `safeFetch`.
6. **L8.** Muat charter default saat seed, atau sediakan editor charter di
   console.

**P1: keandalan dan operasi.**

7. Pisahkan loop perawatan (expiry, notifikasi, jeda) dari eksekusi, dan
   jalankan task dengan konkurensi terbatas (L3/H1).
8. *Park*, bukan *halt*, untuk gangguan sementara: rate limit model, 5xx
   vendor, dan error DB sebelum run (H2, H3, M1).
9. Rerun membawa jawaban owner sebelumnya (L6), dan setup menawarkan harga
   model (L12).
10. Tambahkan metrik Prometheus/OTel dan panduan backup/PITR.
11. **Jalankan kriteria keluar Fase 0/1 PRD dengan sungguh-sungguh:** satu
    perusahaan nyata selama 14 hari dengan model sungguhan dan `kill -9`
    harian, dan catat hasilnya di `STATUS.md`. Uji langsung dalam dokumen ini
    adalah versi 1 jam dari itu, dan sudah menemukan delapan cacat
    berkeparahan sedang ke atas.

**P2: produk dan pasar.**

12. Pilih lisensi (MIT/Apache-2.0 untuk adopsi, AGPL bila ingin melindungi
    dari klon hosted). Ganti default branch ke `main` dan terbitkan rilis
    bertag dengan CHANGELOG.
13. Integrasi siap pakai:
    - form console untuk vendor dan kredensial (hilangkan `INSERT` SQL);
    - alur OAuth untuk Google, Meta, dan marketplace;
    - konektor untuk pasar Indonesia: WhatsApp sebagai kanal owner,
      Midtrans/Xendit produksi, Tokopedia/Shopee, Instagram.
14. Jadikan pembeda terlihat: model ancaman publik, dan demo yang
    mengontraskan "Paperclip mencatat biaya 0 dan tanpa RLS" dengan
    "PALUGADA menahan aksi ireversibel dengan faktor kedua".

---

## 7. Batasan analisa

- **Uji langsung sengaja singkat.** Durasinya sekitar 35 menit operasi,
  memakai satu model (DeepSeek V4.1 Flash) dan vendor tiruan. Ia tidak
  menguji Claude, OpenAI, atau vendor sungguhan, dan tidak menguji operasi
  berhari-hari.
- **Workaround untuk melanjutkan uji.** Setelah cacat L4 terbukti, sebuah
  proxy uji mematikan mode *thinking* DeepSeek. Hasil setelahnya
  mencerminkan konfigurasi itu, bukan default.
- **Plafon token disimulasikan.** Kondisi hampir habis dibuat dengan
  `UPDATE` langsung di database, untuk meniru perusahaan yang sudah berjalan
  berbulan-bulan.
- **Kompetitor tidak dijalankan.** Mereka dinilai dari kode pada HEAD yang
  disebut, dokumentasi, dan metrik publik per 28 September 2026. Skor 0–10
  adalah penilaian analis, bukan hasil benchmark.
- **Keterbatasan audit subagen.** Audit keamanan dan keandalan membaca kode
  tanpa menjalankannya. Temuan yang dikutip di sini sudah diverifikasi ulang
  secara manual kecuali yang ditandai "laporan subagen".

## Lampiran: sumber utama

- **Repositori:**
  - github.com/paperclipai/paperclip (`0f14d26`)
  - github.com/block/buzz (`b0d6fb8`)
  - github.com/MaxMiksa/Auto-Company (`8becd54`)
  - github.com/NextEpochs/opifer
  - github.com/multica-ai/multica
- **Harga DeepSeek:** api-docs.deepseek.com/quick_start/pricing
- **Polsia:** preuve.ai/blog/polsia-review; pulse2.com (pendanaan)
- **Buzz:** engineering.block.xyz/blog/buzz; news.ycombinator.com/item?id=48995213
- **Pemain platform:**
  - Claude Managed Agents: platform.claude.com/docs/en/managed-agents/permission-policies
  - Microsoft Agent 365: learn.microsoft.com/en-us/microsoft-agent-365/overview
  - Slack: docs.slack.dev/changelog (MCP server, Slack Code)
- **Pendanaan:** GeekWire (Temporal, Sep 2026); TechCrunch (Sierra, Ema)
- **PALUGADA sendiri:** `docs/PRD.md`, `docs/STATUS.md`,
  `docs/RESEARCH-2026-09.md`, `docs/AUDIT-2026-09-28.md`

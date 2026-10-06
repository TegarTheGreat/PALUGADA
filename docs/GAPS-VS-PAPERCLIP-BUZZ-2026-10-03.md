# Apa yang belum handal dan belum matang, dibanding Paperclip dan Buzz (3 Oktober 2026)

Pertanyaan pemilik: **Paperclip dan Buzz terasa sudah sangat jauh di depan.
Apa saja yang di PALUGADA belum handal dan belum matang, dan bagaimana
alurnya kalau benar-benar dipakai?**

Dokumen ini melanjutkan
[`MATURITY-RECHECK-2026-09-30.md`](MATURITY-RECHECK-2026-09-30.md) dan
[`FEATURE-COMPARISON-2026-09-30.md`](FEATURE-COMPARISON-2026-09-30.md).
Yang diperiksa adalah `main` pada `fc14a81` (2 Oktober). Untuk Paperclip
dan Buzz, yang diperiksa adalah HEAD pada hari yang sama.

---

## Cara memeriksa

1. **Suite penuh** (`npm run check`) di `main`.
2. **Uji alur langsung**, 2 Okt 23.20 sampai 3 Okt 00.03 UTC:
   - Model sungguhan: DeepSeek, model non-reasoning.
   - Console dalam bahasa Indonesia, dijalankan di browser sungguhan
     (Playwright) pada lebar 1440 px dan 390 px (ponsel).
   - Skenario sama dengan uji sebelumnya: perusahaan "Kopi Senja" dari
     bundle `company-os`, permintaan ke CEO, penghapusan data pelanggan
     tier 3 terhadap vendor tiruan, dan pertanyaan agen ke owner.
   - Dua uji crash:
     - Container mati mendadak di tengah uji. Ini tidak direncanakan, tetapi
       justru menjadi uji yang paling jujur.
     - `kill -9` di tengah panggilan model.
   - Tercatat 118 panggilan model, 1,82 juta token, ±US$1,22.
3. **Audit kode read-only.** Status setiap cacat lama, kode yang berubah
   sejak 30 September, keandalan proses, dan jalan buntu di alur owner.
4. **Kompetitor, dibaca dari kodenya:**
   - Paperclip `4abff286` dan Buzz `8af2d91`, keduanya 2 Oktober.
   - Ditambah issue GitHub, diskusi, dan ulasan pihak ketiga.
5. **Verifikasi manual.** Temuan yang paling menentukan diperiksa ulang
   secara manual di kode. Tandanya ada di kolom "Bukti" pada §3.

---

## 1. Jawaban singkat

### Ya, mereka jauh di depan, dalam tiga hal

| | PALUGADA | Paperclip | Buzz (Block) |
|---|---|---|---|
| Commit 3 minggu terakhir | 263 | 413 | 173 |
| Penulis aktif | 1 | 14 (83% dari 2 orang) | 27 |
| Tes | 1.248 | ±25.000 kasus, 45 spesifikasi e2e | ±10.350 tes Rust, ±1.100 berkas tes desktop/mobile |
| Workflow CI | 1 | 20 | 27 |
| Rilis | tidak ada | stabil tiap 1–2 minggu, canary harian | desktop v0.5.26, mobile v0.19.0-rc.2 |

Popularitas (bintang, unduhan) sengaja tidak dihitung. Yang dibandingkan
adalah kapasitas rekayasa dan kerapian produk.

1. **Skala tim dan kecepatan.** Paperclip menggabungkan ±20 commit sehari,
   dan 327 dari 413 commit-nya ditulis bersama agennya sendiri. Buzz punya
   27 penulis, dan dipakai di dalam Block.
2. **Kerapian alur pertama kali.**
   - Paperclip:
     - Pasang dengan satu perintah (`npx paperclipai onboard`), lengkap
       dengan `doctor --repair` dan `update` yang bisa di-rollback.
     - Wizard 4 langkah yang berakhir di **tugas pertama**, bukan di
       dashboard.
     - Halaman tugas berbentuk percakapan dengan kartu terstruktur.
     - Tampilan "sedang bekerja" yang live lewat WebSocket, dengan tombol
       Stop.
     - Galeri semua hasil kerja.
   - Buzz:
     - Ada hosting resmi, aplikasi desktop dan mobile, dan tim pembuka yang
       memperkenalkan diri di kanal Welcome.
3. **Keluasan.** Banyak pengguna dengan peran dan undangan, browser live
   yang bisa diambil alih owner, kotak surat untuk agen, 8 penyedia
   sandbox, belasan adapter agen, dan impor perusahaan dari GitHub.

### Tidak, mereka tidak di depan dalam hal yang membuat bisnis aman

Ini diverifikasi di kode hari ini; rinciannya di §5 dan §6.

**Paperclip:**
- Anggaran 0 berarti tak terbatas, dan onboarding tidak pernah
  menanyakannya.
- Harness berjalan *full auto* secara default.
- Tidak ada RLS di 294 migrasi.
- Tidak ada faktor kedua.
- Pemakaian tanpa harga dihitung $0.
- Agen bisa merekrut agen lain tanpa persetujuan.
- Menghapus agen ikut menghapus riwayatnya.

**Buzz:**
- **Sama sekali tidak punya gerbang persetujuan manusia.** Langkah approval
  di workflow langsung gagal dengan pesan "not yet implemented".
- Izin tool di-bypass secara default.
- Tidak ada anggaran.
- Antrean pesan agen hanya ada di memori.
- Audit hilang saat crash.
- Tidak ada RLS. Empat celah isolasi baru diperbaiki minggu ini saja.

**Keluhan terbesar pengguna mereka justru hal yang dicegah PALUGADA:**
- Run macet diam-diam: Paperclip #13640, #12988 ("7 jam 48 menit tanpa
  peringatan").
- Biaya lepas kendali: Paperclip diskusi #13999 (3 juta token), #9539
  (35 juta token).
- Pesan ke agen hilang: Buzz #2698, #1743.

### Masalah PALUGADA yang sebenarnya

1. **Alur inti owner gagal di uji langsung.** Owner meminta CEO membuat
   rencana konten Instagram 7 hari:
   - CEO tidak tahu nama peran di perusahaannya sendiri, menebak 19 nama,
     dan membuat 4 tugas "probe".
   - Rencana yang akhirnya selesai **ditolak** karena lebih dari 2.000 token.
   - Lalu task berhenti `budget_exhausted` tanpa satu pun item di inbox.
   - Owner tidak pernah menerima rencananya.
   - Permintaan "hapus data cust-042" ditandai **SELESAI**, padahal datanya
     tidak dihapus.
2. **Nol cacat keandalan yang diperbaiki sejak 30 September.**
   - Dari 35 commit non-merge sejak pemeriksaan itu, 33 berisi terjemahan
     (21 bahasa), bahasa, atau README.
   - Semua cacat B1–B9, H2, M1, M6, M10, dan L2 masih terbuka; hanya dua
     yang sebagian.
3. **Mesin keselamatannya memang kokoh.**
   - Tier 3 dieksekusi tepat sekali, dengan faktor kedua dan verifikasi 404.
   - Container yang mati mendadak pulih dalam 4 detik tanpa efek ganda.
   - `kill -9` di tengah panggilan model pulih dalam 78 detik.

**Kesimpulan:**
- Keunggulan keselamatan PALUGADA baru bernilai kalau alur "owner minta →
  hasil sampai ke owner" berhasil. **Saat ini belum.**
- Mengejar Paperclip dan Buzz dalam keluasan tidak realistis untuk satu
  penulis.
- Yang realistis dan paling berdampak:
  - Membuat alur inti berhasil dan jujur.
  - Membuat setiap kegagalan sampai ke ponsel owner.
  - Lalu menunjukkannya, karena pengguna kedua kompetitor itu mengeluhkan
    persis hal ini.

**Skor ringkas** (0–10, penilaian analis):

| Dimensi | 30 Sep | 3 Okt | Alasan |
|---|---|---|---|
| Rigor rekayasa inti | 8 | 8 | 1.248 tes hijau; tidak ada yang diperbaiki, tetapi juga tidak ada yang rusak |
| Keamanan & tata kelola agen | 7 | 7 | Tier 3 lulus uji langsung; B3 dan B4 masih terbuka |
| Keandalan operasional | 6,5 | **6** | Pemulihan crash sangat baik. Turun karena: refresh OAuth me-restart semua replika (N4), regex yang membekukan proses (N5), dan halt anggaran yang diam |
| Kelengkapan produk & integrasi | 5 | 5 | 34 preset MCP (lebih luas dari yang ditulis sebelumnya); 21 bahasa |
| **Alur owner sampai hasil** (baru) | — | **3** | Permintaan ke CEO tidak menghasilkan apa-apa; hapus data ditandai selesai padahal tidak; halt tanpa jalan lanjut |

---

## 2. Uji alur langsung

### 2.1 Langkah demi langkah

| # | Langkah | Hasil | Waktu | Bukti |
|---|---|---|---|---|
| 1 | Klaim deployment dan TOTP | Lulus | <1 mnt | Halaman klaim jelas |
| 2 | Atur model (DeepSeek), uji, harga, faktor kedua | Lulus, ada gesekan | ±2 mnt | Setiap boot mencatat "model prices set in the console" **dan** "no model price list" |
| 3 | Buat perusahaan dari `company-os` | Lulus, tetapi bahasa tidak ditanya | 1 mnt | `work_language`/`talk_language` NULL, jatuh ke `en`; CEO dan semua agen berbahasa Inggris (N7) |
| 4 | Inbox hari pertama | **Gagal** (B9) | — | 10 kartu skill berbahasa Inggris dan 11 run reviewer (±198 rb token) sebelum owner meminta apa pun |
| 5 | Minta CEO rencana Instagram 7 hari | **Gagal** | 19,5 mnt lalu berhenti | Coordinator ±292 rb token; seluruh pohon ±451 rb token (±$0,33); tanpa hasil (N1, N2) |
| 6 | Rerun yang diusulkan CEO | **Gagal** | 62 dtk / 90 rb token | "task.await … ditolak … memori terpotong"; rencananya tidak pernah diteruskan ke owner |
| 7 | "Hapus data cust-042" (bahasa biasa) | **Gagal** | 9 mnt | Pertanyaan keputusan agen ditelan platform (N3); `record.delete` tidak pernah dipanggil; task berstatus SELESAI |
| 8 | "Jalankan record.delete …" (perintah eksplisit) | **Lulus** | 64 dtk sampai kartu, 3 dtk dari setuju sampai eksekusi | Tepat 1 DELETE dengan idempotency key, 1 GET 404, `tool.verified`, faktor kedua diminta |
| 9 | Agen bertanya ke owner | B2 gagal, B6 sebagian | — | §4 |
| 10 | Anggaran habis, naikkan plafon, lanjutkan | **Gagal** | — | Tanpa item inbox; menaikkan 400 rb → 800 rb berhasil, tetapi task tidak lanjut; satu-satunya jalan "Kerjakan lagi", yang memulai dari nol |
| 11 | Bahasa perusahaan di Pengaturan | Lulus | instan | Setelah diatur ke `id`, CEO menjawab dalam bahasa Indonesia |
| 12 | Unggah dokumen lalu dipakai agen | Lulus | 2,6 dtk + 33 dtk | 3 passage; CMO menemukan pelanggan, alamat, dan jam buka |
| 13 | Jadwal "jalankan sekarang", lalu batalkan | Lulus, tetapi mahal | 2,4 dtk / 1,1 dtk | Review mingguan menghabiskan 770 rb token (33 sen) dalam 3,4 mnt pada perusahaan yang masih kosong (N10) |
| 14 | Console di 1440 px dan 390 px | Sebagian | halaman ±0,4 dtk, laci ±2,1 dtk | Tidak ada halaman yang meluber atau tombol error; gesekan di §2.3 |

**Tidak diuji:**
- Telegram, WhatsApp, dan push (tidak dikonfigurasi).
- Bahasa per proyek.
- Model reasoning untuk B1 (hanya ada model non-reasoning).
- Crash di tengah eksekusi tier 3.

### 2.2 Pemulihan crash: lulus

- **Container mati mendadak (±23.32):**
  - Saat itu tidak ada panggilan yang sedang berjalan. Dua task menunggu
    owner dan satu menunggu jendela waktu.
  - Server yang dinyalakan ulang mengambil task pertama 1,3 detik
    kemudian, dan console menjawab dalam 4,2 detik.
  - Tetap 18 task, tidak ada panggilan model ulang, dan tidak ada request
    vendor ganda.
  - Owner hanya perlu masuk lagi. Console tidak menyebut bahwa baru saja
    terjadi restart.
- **`kill -9` di tengah panggilan model:**
  - Lease diambil alih (`holder_silent`) 48,7 detik setelah kill. Task
    selesai 78 detik setelah kill, tanpa duplikat; hanya giliran model 1
    yang diulang.
  - Ada tiga celah kecil:
    - Panggilan yang terbunuh tidak punya trace, jadi biayanya tidak
      terhitung.
    - Baris `agent_runs` yang crash tertimpa, sehingga tidak ada jejak
      "orphaned".
    - Worker baru menunggu ±35 detik untuk lease milik proses mati di host
      yang sama.

### 2.3 Gesekan bagi owner UMKM yang bukan orang teknis (terburuk dulu)

1. **Permintaan wajar gagal diam-diam.**
   - Penghapusan data dan pertanyaan "siapa pelanggan yang harus dihubungi"
     hanya berhasil kalau ditulis sebagai perintah yang menyebut nama
     kapabilitas internal.
   - Kegagalannya tampil sebagai **SELESAI**.
2. **Agen bekerja dalam bahasa Inggris** sampai owner menemukan Pengaturan →
   Bahasa.
3. **Uang tanpa mata uang.**
   - "Batas 200,00" dan "Terpakai 0,75" terbaca seperti rupiah, padahal
     dolar.
   - Grafik memakai "0.20", sedangkan angkanya "0,75".
4. **Halt anggaran tidak meninggalkan apa pun di inbox.** Satu-satunya
   perbaikan, "Kerjakan lagi", membuang pekerjaan yang sudah jadi.
5. **Inbox dibuka dengan 10 kartu skill berbahasa Inggris** sebelum owner
   meminta apa pun.
6. **Jadwal baru harus ditulis sebagai ekspresi cron**, dengan jam dalam UTC,
   bukan WIB.
7. **Kata internal terlihat oleh owner:**
   - Istilah: "Model:turn 2", "coordinator", "bookkeeper asks:",
     "record.delete: recordId cust-042", akun "ops/growth".
   - Alasan halt dalam bahasa Inggris: "shared budget exhausted".
   - Event linimasa dalam bahasa Inggris: "Content read outside", "Task
     running".
8. **Di lebar 390 px:**
   - Badge terpotong menjadi "1..".
   - Tab "Pertanyaan" di inbox dan tepi tabel Pekerjaan terpotong.
   - Di Keuangan, kolom uang dan tombol **Plafon** keluar layar.
9. **Status yang menyesatkan.**
   - Task CEO yang terhambat dua tingkat di bawahnya tampil "TERJADWAL 5/5".
   - Task yang berhenti tampil dengan bilah progres penuh 5/5.
10. **"Strategist" dan "critic" muncul di pemilih peran** tanpa nama atau
    jabatan.

---

## 3. Cacat baru

Arti kolom "Bukti":
- **langsung**: terjadi di uji langsung.
- **kode**: dibaca di kode.
- **dicek ulang**: diverifikasi lagi secara manual untuk dokumen ini.
- **diukur**: waktunya diukur.

### Tinggi

| # | Temuan | Bukti |
|---|---|---|
| N1 | **CEO tidak tahu peran apa saja yang ada di perusahaannya.** Konteks run tidak punya daftar peran: `src/context/builder.ts` tidak punya bagian roster, dan tidak ada kapabilitas `role.list`. Deskripsi `task.delegate` hanya berbunyi "The slug of the role" (`src/broker/platform-capabilities.ts:751`), dan error-nya ("no role X", `:802`) tidak menyebut peran yang sah. Akibatnya CEO menebak 19 nama ("marketing", "cmo", "barista"…) dan membuat 4 tugas "Probe only: does this role exist?". Salah satunya naik ke owner dan memblokir seluruh rencana. Divisinya menghabiskan 96% plafon seumur hidup 400 rb token untuk satu permintaan | langsung + dicek ulang |
| N2 | **Hasil kerja yang sudah jadi ditolak.** `task.await` menolak rencana 7 hari dari marketer: "returned about 2597 tokens, over the 2000 a sub-agent may hand back (F6.7)" (`CHILD_OUTPUT_TOKEN_LIMIT = 2_000` di `src/engine/containment.ts:30`, ±8.000 karakter). Rerun juga tidak bisa membacanya ("not one this task delegated"), dan salinan di memori terpotong di tengah kalimat. Batas F6.7 dimaksudkan menahan transkrip, tetapi yang tertahan justru hasil kerjanya | langsung + dicek ulang |
| N3 | **Pertanyaan keputusan ditelan platform.** Ini mekanisme B2 yang ternyata lebih luas. Setiap `owner.ask` yang menyebut tool yang belum tersambung, ditambah kata "connected"/"hubung…", dijawab otomatis oleh platform. Akibatnya keputusan tentang aksi ireversibel (hapus data pelanggan) tidak pernah sampai ke owner, dan task-nya ditandai selesai | langsung; `platform-capabilities.ts:624-629` |
| N4 | **Setiap refresh token OAuth otomatis me-restart semua replika.** `settingsVersion()` mengambil `max(updated_at)` dari `deployment_settings` **dan** `deployment_secrets` (`src/settings/store.ts:272-279`). Setiap replika memeriksanya tiap 30 detik dan me-restart bila berubah (`src/main.ts:1096-1102`). Refresh OAuth vendor (`vendor-oauth.ts:420`) dan MCP (`mcp-oauth.ts:434-445`) memanggil `putSecret`, yang menyetel `updated_at = now()` (`store.ts:114-118`). Satu divisi yang tersambung ke Google berarti seluruh deployment restart ±sekali sejam, dan run di peran CLI berisiko halt `journal_divergence` | kode + dicek ulang; belum dijalankan |

### Sedang

| # | Temuan | Bukti |
|---|---|---|
| N5 | **Regex deteksi bahasa membekukan proses.** `/\S+@\S+\.\S+/g` di `src/domain/language.ts:263` bertumbuh kubik: 1.000 karakter `a@a@…` butuh 0,1 dtk, 2.000 butuh 0,8 dtk, 4.000 butuh 6,5 dtk, dan 10.000 butuh ±99 dtk. Selama itu heartbeat berhenti, sehingga replika lain bisa mengambil alih (B5). Sejak 38bb48f, isi tiket (≤8 KB), brief delegasi, dan bukti tahap juga melewatinya. 600 handle Instagram yang dipisah koma tanpa spasi butuh 8,1 dtk | diukur + dicek ulang |
| N6 | **"Ajukan pertanyaan" di kartu approval tidak berpengaruh untuk peran agent-loop.** Replay memakai ulang giliran model dari jurnal (`agent-loop.ts:119-149`) dan `requestApproval` memakai ulang item yang masih terbuka (`inbox.ts:150-185`). Model tidak pernah membaca pertanyaan owner, padahal console bilang "Question sent to the agent" (`Decisions.tsx:474`) | kode |
| N7 | **Bahasa perusahaan default-nya Inggris.** Pembuatan perusahaan tidak menanyakan bahasa, sehingga jatuh ke `'en'` (`src/domain/language.ts:142`), padahal owner memakai console berbahasa Indonesia | langsung + dicek ulang |
| N8 | **Chat CEO, asisten, dan distilasi memori tidak dihitung biayanya.** Tidak ada baris `llm_traces` untuk 3 percakapan CEO, padahal salah satunya 39 detik dan multi-giliran (`src/owner/assistant.ts:474`, `distillation.ts:237,407`). Akibatnya halaman Keuangan dan plafon tidak melihatnya | langsung + kode |
| N9 | **Status yang menyesatkan.** Penghapusan yang gagal tampil SELESAI; CEO yang terhambat tampil TERJADWAL 5/5; task yang berhenti tampil PROGRES 5/5 | langsung |
| N10 | **Review mingguan mahal dan dijalankan otomatis.** Jadwal `weekly-business-review` ditambahkan oleh pilihan "Biarkan berjalan sendiri" (aktif secara default). Jadwal itu menghabiskan 770 rb token dalam 3,4 menit pada perusahaan yang masih kosong, padahal dialog konfirmasinya menyebut "1.000 token" | langsung |
| N11 | **Jadwal tidak bisa dimatikan atau dihapus.** Satu-satunya rute adalah GET/POST `/schedules` dan `/run` (`api.ts:845, 4579, 4622`); console menampilkan "Off" tanpa sakelar. Membuat jadwal dengan nama yang sudah dipakai menimpa brief-nya, dan `enabled ?? true` menyalakan lagi jadwal yang dijeda (`scheduler.ts:290-319`) | kode |
| N12 | **Rerun setelah halt bisa mengulang penulisan eksternal.** Rerun adalah task baru, jadi idempotency key-nya (`callKey(taskId, …)`) juga baru. Rerun hanya diberi tahu bahwa percobaan sebelumnya "ended halted", bukan apa yang sudah dikerjakannya (`builder.ts:621-624`). Penulisan tier 1–2 tidak punya gerbang persetujuan | kode |
| N13 | **Replay ditampilkan sebagai ucapan baru.** Transkrip "Yang dikatakannya" mengulang baris yang sama dengan cap waktu baru di setiap resume, sampai CEO sendiri menulis "mengulang orientasi dari awal delapan kali". Setiap resume juga mengeksekusi ulang 20 langkah delegasi yang gagal | langsung |
| N14 | **H4 masih ada.** Run CLI/ACP dilanjutkan berdasarkan posisi langkah (`journal.ts:144-155`). Panggilan yang kata-katanya berbeda setelah approval atau restart akan menghentikan task dengan `journal_divergence` | kode |

### Rendah sampai sedang

- **Kartu "Monthly budget reached".** "Setuju" hanya menutup kartunya,
  sedangkan perusahaan tetap dijeda (`inbox.ts:1583`). "Tanya" di kartu
  tanpa task menyimpan pertanyaan yang tidak pernah dibaca siapa pun.
- **Balapan antara run-now dan jam jadwal.** `giveWay` tidak mengambil
  advisory lock (`scheduler.ts:788`), sehingga kebijakan `skip`/`queue` masih
  bisa menghasilkan dua task hidup.
- **Kunci master per replika.** Tanpa `PALUGADA_MASTER_KEY` bersama, setiap
  replika membuat file kunci sendiri (`settings/store.ts:44-70`). Rahasia
  tersegel dan QR klaim lalu gagal lintas replika, dan dokumen multi-worker
  tidak menyebutnya.
- **Ukuran pool.** Pool tetap 10 koneksi, sedangkan konkurensi bisa 16
  (`db/pool.ts:32`). Belum terbukti kehabisan.
- **Migrasi 0099** mengangkat FORCE RLS di setiap tabel (dengan kunci
  eksklusif) dan membangun indeks non-concurrent pada `tasks` dalam satu
  transaksi. Ini bermasalah untuk upgrade di database yang sudah besar.

### Rendah

- **Alasan approval berbahasa Inggris dengan UUID mentah**: "Task c4dd74fb-…
  requested record.delete at tier 3…" (`src/broker/broker.ts:715`).
- **Id pendek di `task.await`** diteruskan langsung ke SQL dan menghasilkan
  error Postgres mentah "invalid input syntax for type uuid"
  (`platform-capabilities.ts:870`).
- **Tombol Beranda selalu "Atur model"** meski model sudah diatur
  (`console/src/pages/Home.tsx:138-140`).
- **JSON mentah muncul di chat CEO** setelah owner menekan "Terapkan".
- **Satu giliran kosong tetap dibayar** (`stopReason: max_tokens`).
- **Judul dokumen diambil dari nama file**, bukan dari judulnya.
- **Redactor di memori terus tumbuh** setiap kali token di-refresh
  (`secrets/manager.ts:129-147`).

---

## 4. Status cacat lama (30 September)

Tidak satu pun commit sejak 30 September menyentuh `agent-loop.ts`,
`budget.ts`, `pricing.ts`, `src/llm`, `checkout.ts`, `mcp-oauth.ts`,
`main.ts`, `worker.ts`, atau `mfa.ts`.

| # | Cacat | Status 3 Okt | Bukti |
|---|---|---|---|
| B1 | Plafon token buta harga; tidak ada item inbox saat `budget_exhausted` | **Terbuka** | Uji langsung: strategist dan CEO berhenti "shared budget exhausted" tanpa item inbox, insiden, atau peringatan; satu-satunya tanda adalah bilah merah di Keuangan. **Catatan baru:** pengurasnya loop coordinator sendiri (N1), bukan token reasoning, jadi model non-reasoning pun kena. `engine.ts:1543-1577`, `#onHalt` `:1778-1808` |
| B1 | Jatah ulang tidak dibatasi sisa anggaran | **Terbuka** | `agent-loop.ts:115-116` dibatasi plafon per run milik peran, lalu digandakan di `:155` |
| L11 | Plafon token seumur hidup | **Sebagian** | Bisa dinaikkan dengan faktor kedua, tetapi tetap seumur hidup (dialognya sendiri bilang "Token yang terpakai tidak kembali"), dan task yang berhenti tidak dilanjutkan |
| B2 | Pertanyaan kerja berbahasa Indonesia ditelan | **Terbuka, lebih luas** (N3) | Event `task.question_answered_by_platform` dengan `{"question":"Siapa pelanggan yang harus saya hubungi lewat email?"}`; `platform-capabilities.ts:624` |
| B3 | Rahasia klaim bisa dikloning | **Terbuka** | `claim.ts:159-160`; f71d508 hanya mengubah label |
| B4 | OAuth MCP tanpa faktor kedua | **Terbuka** | `api.ts:2175-2190`; rute setara untuk divisi memintanya (`:3701`) |
| B5 | Heartbeat salah menyatakan replika hidup sudah mati | **Terbuka** | `checkout.ts:421-433`; `holder_silent` tetap dihitung ke `crash_loop` |
| B6 / L18 | `/answer` menunggu lagi pertanyaan yang sama | **Beres di console, terbuka di API** | Tombol console melanjutkan task. `/answer` langsung menghasilkan `owner.answered` lalu `task.waiting_approval` lagi dalam 2,6 dtk (`inbox.ts:1842` vs `:667`); asisten masih memakai rute ini (`assistant-actions.ts:275`) |
| B7 | Admin bisa memundurkan `closing_at` | **Terbuka** | `0088:18-24` |
| B8 | Impor/penutupan menghapus kunci perusahaan sumber | **Terbuka, lebih luas** | Selain dihapus, klon di instance yang sama juga bisa *memakai* kunci vendor sumbernya (`import.ts:112-125`) |
| B9 | Inbox banjir di hari pertama | **Terbuka** | 10 kartu skill, 11 run reviewer, ±198 rb token |
| H2 | Gangguan vendor sesaat menjadi halt permanen | **Terbuka** | `http.ts:410-416`, `engine.ts:592-603` |
| M1 | Klaim bocor saat DB error | **Terbuka** | `worker.ts:795-817` |
| M6 | Jeda bulanan tidak terangkat di awal bulan | **Terbuka** | `spend-guard.ts:205-271` |
| M10 | Tabel tanpa batas | **Terbuka** | `task_steps`, `agent_runs`, `tasks`, `inbox_items` tidak pernah dibersihkan |
| L2 | Tanpa handler `unhandledRejection` | **Terbuka** | Tidak ada di `src/` maupun `scripts/` |
| — | Lockout TOTP global | **Sebagian** | Passkey dan kode pemulihan kebal, tetapi kode pemulihan tidak bisa dipakai untuk menyetujui |
| — | Pekerjaan owner di prioritas 2 | **Terbuka** | `api.ts:3135-3155`; slot mendesak hanya menerima P0 (`worker.ts:240`) |
| — | "Built" tapi tidak tersambung: replay kering, device gateway, sandbox kode, pencarian memori semantik, bundle pihak ketiga, F3.9, reservasi uang | **Semua terbuka** | Tombol Replay di Pekerjaan masih selalu gagal (`Work.tsx:284`, `api.ts:3533-3541`); yang direservasi tetap hanya token (`0024:48`) |

---

## 5. Paperclip hari ini (`4abff286`, 2 Oktober)

### 5.1 Yang baru sejak 30 September (82 commit)

- **Rilis stabil v2026.1001.0 (1 Okt), dengan perubahan yang memutus
  kompatibilitas:**
  - Harness kini *full auto* secara default (#13686).
  - Broker Composio lama dihapus tanpa migrasi (#13758).
- **Beta v2026.1002.0:**
  - Agent Chat.
  - Pemilih model per pesan.
  - Slack dua arah.
  - Skill disinkronkan dari GitHub.
  - Penyedia memori (Mem0, Zep, dan lainnya) di belakang flag.
- **Sejak 30 Sep:**
  - Run yang diam kini diperingatkan setelah 5 menit dan dieskalasi setelah
    15 menit (dulu 1 jam dan 4 jam, #14979).
  - Retry yang habis menjadi status "blocked" yang terlihat (#14046).
  - Crash loop pada run antrean diperbaiki (#14738).
  - Browser live yang bisa diambil alih owner (Browser Use Cloud, #14627).
  - AgentMail sebagai koneksi default (#14772).
  - Setup konektor dalam satu layar (#14811).
  - Template rekrutmen dipangkas: prompt CEO dari 1.897 kata menjadi 20
    (#14985).

### 5.2 Di mana Paperclip jauh di depan

1. **Instalasi.**
   - `npx paperclipai onboard --yes` dengan Postgres tertanam dan tanpa
     Docker.
   - `doctor --repair`, serta `update` dengan kanal, backup sebelum update,
     dan rollback.
   - PALUGADA butuh git, Docker atau Node+Postgres, dan aplikasi
     authenticator.
2. **Jam pertama.**
   - Wizard 4 langkah (`OnboardingWizard.tsx`, 3.196 baris) menguji harness
     sebelum merekrut agen, lalu membawa owner ke **tugas pertama**.
   - Skill `first-task` menawarkan "wawancarai saya" atau "saya punya
     tugas", menyimpan dokumen rencana, dan meminta persetujuan lewat kartu.
   - PALUGADA membuat perusahaan 8 divisi lalu membuka Ringkasan, tanpa
     percakapan terpandu.
3. **Tugas sebagai percakapan.**
   - Halaman tugas berbentuk utas dengan 6 jenis kartu terstruktur
     (`IssueDetail.tsx`, `constants.ts:259-273`).
   - PALUGADA punya event, trace, transkrip, dan hasil kerja, tetapi
     instruksinya satu arah.
4. **Melihat kerja secara live.**
   - Event dikirim lewat WebSocket (`realtime/live-events-ws.ts`), dengan
     transkrip live, jumlah run aktif, dan tombol Stop.
   - PALUGADA melakukan polling 5–15 detik dan tidak punya tampilan "sedang
     bekerja" untuk seluruh perusahaan.
5. **Galeri hasil kerja** untuk seluruh perusahaan (`ui/src/pages/Artifacts.tsx`).
   Di PALUGADA, hasil kerja hanya ada di dalam masing-masing task.
6. **Banyak pengguna.** Peran owner/admin/operator/viewer, 21 izin,
   undangan, dan permintaan bergabung. PALUGADA hanya punya satu owner.
7. **Keluasan.**
   - 12+ adapter agen dan 8 penyedia sandbox.
   - Kotak surat agen, dan email masuk membuat tugas.
   - Browser live, impor perusahaan dari GitHub atau berkas, dan rutinitas
     berbasis webhook.

### 5.3 Di mana Paperclip lebih lemah (diverifikasi di kode hari ini)

- **Uang:**
  - Anggaran 0 berarti tak terbatas (`services/budgets.ts:71`), dan
    onboarding tidak menanyakannya.
  - Biaya dihitung setelah dibelanjakan, tanpa reservasi.
  - Pemakaian tanpa harga dicatat $0 (`heartbeat.ts:5310-5332`).
  - Agen bisa melaporkan biayanya sendiri (`costs.ts:114-121`).
- **Kendali:**
  - Harness *full auto* secara default.
  - Claude dijalankan dengan `dangerouslySkipPermissions` aktif secara
    default.
  - `maxConcurrentRuns` 20 per agen, bisa sampai 50.
  - Agen merekrut agen tanpa persetujuan secara default.
  - Approval tanpa kedaluwarsa dan tanpa faktor kedua.
- **Akses:**
  - Tidak ada TOTP maupun passkey.
  - Mode `local_trusted` menganggap setiap request dari loopback sebagai
    admin. Digabung dengan *full auto*, agen lokal yang punya shell bisa
    memanggil API board.
- **Isolasi:** tidak ada RLS di 294 migrasi.
- **Riwayat:** menghapus agen ikut menghapus log aktivitas, run, dan
  komentarnya.
- **Owner di luar browser:** tidak dijangkau. Tidak ada push atau ringkasan,
  dan konektor chat ada di belakang flag yang mati secara default.
- **UI:**
  - Praktis hanya bahasa Inggris; 40 berkas locale, masing-masing 3 kalimat.
  - Katalog tim tidak punya rute.
  - Menu Goals tersembunyi.
  - 20+ fitur mati secara default.
- **Telemetri** aktif secara default.

### 5.4 Suara pengguna Paperclip

- **Run macet diam-diam**, kelompok keluhan terbesar:
  - #13640: task "permanently unstartable", dan komentar owner "silently
    discarded".
  - #12988: "7h48m with no alert".
  - Juga #14752, #14457, #14093, dan #101 (terbuka sejak Maret).
- **Biaya lepas kendali:**
  - Diskusi #13999: "3M tokens gone to runaway agents", dan jawaban
    komunitas adalah "Set a budget".
  - #390 (tidak ada circuit breaker, terbuka sejak Maret), #9539 (35 juta
    token setelah upgrade), #6844 ("7B tokens with $0 cost").
- **Agen berputar-putar:** #447, #3935, #4809, #7733.
- **Setup sulit:** #2301, #704, #13998, diskusi #14385. Ulasan
  theaiarchitects.com: "not for beginners".
- **Data hilang:**
  - #10555: pembersihan workspace menghapus 2.309 berkas tanpa peringatan.
  - #7601: rahasia muncul di transkrip.
  - #20: pembuatan kunci lintas tenant.
- **Yang paling diminta:**
  - Ollama (#187), chat dengan agen (#49), UI berbahasa Portugis (#7794),
    bicara dengan CEO lewat Telegram/WhatsApp (#2004), lapisan pengetahuan
    (#1858).
  - Tiga yang terakhir **sudah dimiliki PALUGADA**.

---

## 6. Buzz hari ini (`8af2d91`, 2 Oktober)

### 6.0 Koreksi atas dokumen sebelumnya

- **Buzz tidak punya bridge Slack, Discord, Teams, Telegram, maupun
  WhatsApp.**
  - Buzz adalah ruang chat itu sendiri: pengganti Slack di atas Nostr.
  - Integrasi GitHub-nya adalah hosting git miliknya sendiri (NIP-34).
- **Buzz punya hosting resmi** (buzz.xyz lewat Builderlab, maksimal 5
  komunitas per akun), tombol Railway, bundle Compose, dan chart Helm.
  - Baris "Installing — Buzz: a container image" di README terlalu
    meremehkan.
- **Migrasi 0053 dan 0054 bukan tentang agen.**
  - 0053 "auto approval" adalah persetujuan otomatis atas permintaan owner
    menghapus komunitas.
  - 0054 "quota reservation" adalah kuota jumlah penghapusan komunitas.
  - Keduanya bukan approval tool dan bukan anggaran uang.

### 6.1 Yang baru sejak 30 September (35 commit)

- **29 dari 35 commit ditulis agen** ("Duncan (agent)" dan Codex), lalu
  ditandatangani manusia.
- **Empat perbaikan isolasi dan keamanan:**
  - #8028: penerbit identitas yang dipercaya satu komunitas bisa membuat
    assertion yang diterima komunitas lain.
  - #8006: event khusus owner bocor ke pelanggan di server lain.
  - #8007: error DB membuat posting bisa masuk ke kanal yang diarsipkan.
  - #8005: celah pada ban.
- **`main` sempat tidak bisa dikompilasi** setelah dua PR yang
  masing-masing hijau di-merge (#8036). Buzz tidak punya merge queue.
- **Perbaikan harness agen:**
  - Pesan yang diedit kini mengarahkan giliran yang sedang berjalan.
  - #7459: transport yang crash bisa membuat pekerjaan tertahan di antrean
    selamanya.
  - #7568: stream yang korup.

### 6.2 Di mana Buzz di depan

1. **Klien.**
   - Aplikasi desktop (Tauri) yang rapi: kunci dibuat atau diimpor dengan
     backup terenkripsi, CLI agen yang terpasang dideteksi, lalu tim pembuka
     memperkenalkan diri.
   - Aplikasi mobile (Flutter), dengan push gateway.
2. **Bicara dengan agen.**
   - Kanal, utas, dan DM; agen adalah anggota yang di-@mention.
   - Agen bisa dihentikan atau di-reset dari chat (`!cancel`, `!rotate`).
   - Pesan yang diedit mengarahkan giliran yang sedang berjalan.
   - Kanvas bersama, huddle suara, dan hosting git.
3. **Melihat kerja secara live**: giliran agen yang aktif, transkrip, dan
   ringkasan proses berpikir.
4. **Banyak pengguna dan identitas.**
   - Satu keypair untuk setiap manusia dan agen.
   - Undangan, peran kanal, dan ban.
   - Atestasi owner atas agennya.

### 6.3 Di mana Buzz lebih lemah (diverifikasi di kode hari ini)

- **Tidak ada gerbang persetujuan manusia yang berfungsi.**
  - Langkah approval di workflow menggagalkan run: "approval gates not yet
    implemented — see WF-08" (`crates/buzz-workflow/src/lib.rs:229-256`).
  - `BUZZ_ACP_PERMISSION_MODE` default-nya `bypass-permissions`, dan
    permintaan yang tetap datang dijawab `allow_once`
    (`crates/buzz-acp/src/config.rs:466-476`, `acp.rs:2005-2075`).
- **Tidak ada anggaran.** Biaya hanya diamati, tidak dibatasi atau
  direservasi.
- **Kerja agen tidak tahan crash.**
  - Antrean pesan ada di memori, 500 per scope, dan yang tertua dibuang
    (`queue.rs:355`).
  - Agen yang restart hanya me-replay 15 menit terakhir.
  - Run workflow tidak dipulihkan.
  - Agen adalah proses anak aplikasi desktop, jadi ikut mati saat aplikasi
    ditutup.
- **Audit** diantrekan di memori setelah commit, sehingga hilang saat crash
  (`handlers/event.rs:556-595`).
- **Isolasi:** tidak ada RLS di 55 migrasi. RLS hanya ada sebagai aksioma di
  dokumen desain.
- **Tidak ada batas hop** antar agen; yang ada hanya rate limit per menit.
- **Tidak ada klien web untuk chat.** Build Windows tidak ditandatangani, dan
  desktop hanya berbahasa Inggris (#2929).

### 6.4 Suara pengguna Buzz (232 bug terbuka)

- **Agen diam-diam tidak membalas:** #2698 (38 komentar), #1743 (P1: mention
  ke agen yang offline hilang), #7316, #7623.
- **Jadwal tidak pernah jalan:** #5611, #3858, #8016.
- **Agen bersama hanya bisa dijangkau dari mesin yang menjalankannya:**
  #3277 dan keluarganya.
- **Crash dan data terhapus:** #7334 (aplikasi Windows kosong), #6523 (update
  menghapus komunitas lokal).
- **Onboarding:** #3088 ("Self-hosting onboarding is frustrating"), #2351
  (email pendaftaran tidak datang).
- **Yang paling diminta:** UI web (#2682) dan agen yang berjalan di server
  (#2859, #4174). **Keduanya sudah dimiliki PALUGADA.**

---

## 7. Alur owner berdampingan

| Langkah | Paperclip | Buzz | PALUGADA (hasil uji 2–3 Okt) |
|---|---|---|---|
| Pasang | 1 perintah, tanpa Docker, update dan rollback | Hosted, Railway, Compose, Helm | `npm run setup` lalu Docker/Node; Linux; model diuji dengan request nyata ✅ |
| Masuk | Tanpa login di loopback (lemah) | Kunci milik pengguna | Klaim + TOTP/passkey ✅ |
| Jam pertama | Wizard → tugas pertama → wawancara → rencana | Tim pembuka di kanal Welcome | Perusahaan 8 divisi; inbox berisi 10 kartu skill berbahasa Inggris ❌ |
| Bahasa | Inggris | Inggris | 21 bahasa di console ✅, tetapi agen berbahasa Inggris kecuali diatur ❌ |
| Minta sesuatu | Komentar di tugas | @mention di kanal | Bicara dengan CEO, bisa dengan suara ✅ → CEO tidak tahu nama peran ❌ |
| Melihat kerja | Live (WebSocket), Stop | Live, `!cancel` | Polling 5–15 dtk; transkrip mengulang saat resume ⚠️ |
| Agen bertanya | Kartu terstruktur di utas | Chat | Kartu dengan pilihan ✅; pertanyaan berbahasa Indonesia bisa ditelan ❌ |
| Aksi ireversibel | Tanpa faktor kedua; *full auto* | Tidak ada gerbang | Faktor kedua, tepat sekali, verifikasi baca ulang ✅ |
| Hasil kerja | Galeri Artifacts | Kanvas | Di dalam task; hasil >2.000 token ditolak ❌ |
| Uang | Tak terbatas secara default | Tidak ada | Direservasi (token); halt diam, plafon seumur hidup, tanpa mata uang ❌ |
| Crash | Pulih per run | Antrean di memori | Pulih per langkah dalam 4–78 dtk, tanpa duplikat ✅ |
| Notifikasi | Hanya di browser | Mobile push | Push, Telegram, WhatsApp dengan tombol ✅ (tidak diuji kali ini) |
| Staf | Peran dan undangan | Peran dan undangan | Hanya satu owner ❌ |

---

## 8. Koreksi atas dokumen dan README

1. **Buzz** tidak punya bridge chat eksternal (§6.0). Kolom Buzz di
   perbandingan sebelumnya perlu dibaca dengan koreksi ini.
2. **Integrasi PALUGADA tidak setipis yang ditulis 30 September.**
   - Ada 34 server MCP bernama (`src/capabilities/mcp-presets.ts`),
     termasuk agregator Zapier, Composio, Pipedream, Arcade, dan Smithery.
   - Yang masih kosong: adaptor kotak surat (`mailbox.read` dideklarasikan,
     tetapi tidak ada adaptornya) dan kanal untuk pelanggan.
3. **Baris "Installing" di README meremehkan kedua kompetitor.**
   - Paperclip bukan sekadar "a container image": ada `npx paperclipai
     onboard`.
   - Buzz punya hosting, Railway, dan Helm.
4. **Baris "A spending ceiling" di README** menulis "Reserved before the work
   starts".
   - Yang direservasi adalah **token**, bukan uang.
   - Chat CEO, asisten, dan distilasi tidak tercatat sama sekali (N8).
5. **B1 bukan hanya soal model reasoning.** Uji ini memakai model
   non-reasoning, dan plafon tetap terkuras oleh loop delegasi coordinator
   (N1).

---

## 9. Rekomendasi

**Prinsip:**
- Hentikan dulu penambahan bahasa dan fitur baru sampai P0 selesai.
- Setiap butir P0 diawali tes yang gagal, sesuai `AGENTS.md`.
- Beberapa butir perlu tes yang menjalankan setiap peran bawaan di instalasi
  baru dengan model tiruan yang realistis.

### P0: alur inti berhasil, dan tidak ada kegagalan yang diam

1. **N1: beri coordinator daftar peran.**
   - Tambahkan bagian roster di `src/context/builder.ts` (slug, nama,
     jabatan, dan satu kalimat tugasnya).
   - Error `task.delegate` menyebut slug yang sah dan yang paling mirip.
   - Tes: CEO bawaan `company-os` mendelegasikan permintaan pemasaran ke CMO
     pada percobaan pertama.
2. **N2: serahkan hasil kerja lewat referensi, bukan isinya.**
   - Batas F6.7 diterapkan ke ringkasan yang dibaca induk.
   - Hasil lengkapnya disimpan sebagai deliverable yang bisa dibuka owner
     dan dikutip induk.
   - Tes: rencana 7 hari sepanjang 3.000 token sampai ke owner.
3. **N3/B2: jangan pernah menjawab pertanyaan agen secara otomatis
   berdasarkan kata kunci.**
   - Paling tidak, jangan jawab otomatis pertanyaan yang terkait aksi tier
     ≥2.
   - Tambahkan tes negatif berbahasa Indonesia ("hubungi", "pasang",
     "hapus").
4. **B1/L11: setiap halt anggaran harus sampai ke owner.**
   - Item inbox, plus push, berisi "Naikkan dan lanjutkan", yang
     **melanjutkan** task, bukan memulainya ulang.
   - Plafon token berperiode.
   - Jatah ulang dibatasi sisa anggaran.
5. **N4: refresh token tidak boleh me-restart deployment.** Pisahkan versi
   pengaturan dari pembaruan rahasia yang ditulis mesin, atau muat ulang
   rahasia di tempat.
6. **N5:** ganti regex email dengan `[^\s@]+@[^\s@]+\.[^\s@]+`, **dan**
   batasi panjang teks yang diperiksa.
   - Diukur: 4.000 karakter `a@a@…` turun dari 6,5 dtk menjadi 0 ms, dan 600
     handle dari 3,3 dtk menjadi 0 ms.
   - Satu kata 50.000 karakter tanpa titik masih butuh 1,8 dtk, jadi batas
     panjangnya tetap perlu.
7. **N7:** tanyakan bahasa saat perusahaan dibuat, dengan default bahasa
   console owner.
8. **N9:** status harus jujur.
   - Penghapusan yang tidak terjadi tidak boleh SELESAI.
   - Task yang berhenti tidak boleh menampilkan 5/5.
9. **N8:** catat chat CEO, asisten, dan distilasi ke `llm_traces`, supaya
   Keuangan dan plafon melihatnya.

### P1: menyamai kerapian alur kompetitor (yang paling dirasakan owner)

10. **Jam pertama yang terpandu.**
    - CEO membuka dengan wawancara singkat (usaha apa, bahasa, anggaran),
      menyimpan rencana, meminta persetujuan, lalu menghasilkan satu hasil
      nyata.
    - Kartu skill hari pertama ditunda atau dibatasi (B9).
    - Review mingguan tidak berjalan otomatis sebelum ada pekerjaan (N10).
11. **"Sedang bekerja" yang live** lewat SSE, dengan tombol Stop. Transkrip
    yang tidak mengulang saat resume (N13).
12. **Galeri hasil kerja** untuk seluruh perusahaan.
13. **Uang dalam mata uang yang jelas** (USD, dengan opsi tampilan rupiah).
    Perbaiki tata letak ponsel di Keuangan, Inbox, dan Pekerjaan.
14. **Jadwal:** sakelar aktif/nonaktif dan hapus, pemilih waktu (bukan cron),
    zona waktu WIB (N11).
15. **Tidak ada kata internal di layar owner.** Terjemahkan alasan halt,
    event, dan alasan approval (§2.3 butir 7).
16. **Keamanan dan keandalan yang tertunda:**
    - Keamanan: B3, B4, B5.
    - Keandalan: H2 (*park*, bukan halt), M1, M6, M10, L2.
    - Perilaku tombol: N6, N12, N14.
    - Tombol Replay yang selalu gagal: sembunyikan sampai berfungsi.

### P2: keluasan, dipilih sesuai pasar UMKM

17. **Instalasi satu perintah tanpa Docker**, dengan `doctor` dan `update`
    yang bisa di-rollback; atau instance hosted.
18. **Kursi staf:** viewer, dan penyetuju untuk tier ≤2. Tier 3 tetap hanya
    owner.
19. **Kanal untuk pelanggan:** kotak surat dan WhatsApp/Telegram pelanggan,
    dengan balasan sebagai aksi tier 2.
20. **Browser live yang bisa diambil alih**, untuk seller center marketplace
    dan portal pemerintah.
21. **Kedewasaan yang terlihat:**
    - Rilis bertag dan merge queue.
    - Dogfooding `palugada-dev`.
    - Operasi nyata 14 hari dengan owner sungguhan, sesuai kriteria keluar
      PRD.

**Peluang yang jarang:**
- Pengguna Paperclip dan Buzz paling sering mengeluhkan run yang macet
  diam-diam, biaya yang lepas kendali, dan pesan yang hilang.
- PALUGADA sudah punya mesinnya: reservasi, jurnal, hop limit, faktor
  kedua, dan Telegram/WhatsApp untuk owner.
- Setelah P0 butir 3, 4, dan 8 selesai, PALUGADA bisa **mendemokan** bahwa
  setiap kegagalan sampai ke ponsel owner dalam hitungan menit, dengan
  alasan dan satu tombol tindakan. Itu pembeda yang sulit ditiru kompetitor
  tanpa membongkar desainnya.

---

## 10. Batasan

- **Satu model, satu skenario, ±45 menit.**
  - B1 tidak diuji dengan model reasoning.
  - Telegram, WhatsApp, dan push tidak dikonfigurasi.
- **Temuan yang hanya dibaca di kode:** N4, N6, N11, N12, N14, dan sebagian
  §4. N4 diverifikasi ulang secara manual, tetapi belum dijalankan dengan
  OAuth sungguhan.
- **Angka kompetitor:**
  - Jumlah commit, penulis, tes, dan workflow CI dibaca pada 2 Oktober dari
    clone dan halaman publik.
  - Isi issue dan diskusi diringkas oleh alat pengambil halaman, karena API
    GitHub untuk repositori itu tidak tersedia di sesi ini.
  - Klaim bahwa Buzz menggantikan Slack di Block **tidak diverifikasi**.
- **Skor 0–10 adalah penilaian analis**, bukan hasil benchmark.

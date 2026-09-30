# Pemeriksaan ulang kematangan PALUGADA (30 September 2026)

Dokumen ini mengulang pemeriksaan
[`COMPETITIVE-ANALYSIS-2026-09-28.md`](COMPETITIVE-ANALYSIS-2026-09-28.md)
dua hari kemudian. Revisinya:

- **Sebelumnya:** `61dbfa6`.
- **Sekarang:** `5f6a192`, yaitu 90 commit dan ±30 ribu baris tambahan.

Pertanyaannya sama: **apakah PALUGADA sudah sangat handal dan matang?** Ada
dua pertanyaan tambahan:

- Apakah cacat yang dulu ditemukan uji langsung benar-benar hilang?
- Apa yang dibawa kode baru?

Rujukan L3–L18 menunjuk ke tabel §3.2 dokumen 28 September.

## Cara memeriksa

Metodenya sama dengan pemeriksaan pertama, agar hasilnya bisa dibandingkan.

1. **Suite penuh** (`npm run test:coverage`) di kode terbaru, dengan
   TypeScript 7.0.2.
2. **Uji langsung dengan DeepSeek V4.1 Flash**, kali ini **tanpa proxy**.
   Mode *thinking* bawaan dibiarkan aktif.
   - Database baru dan konfigurasi sama dengan uji pertama.
   - Skenario yang dulu gagal diulang persis: perusahaan "Kopi Senja" dengan
     `company-os`, pesan yang sama ke CEO, tugas pemasaran, penghapusan data
     pelanggan tier 3, `kill -9` di tengah run, dan kunci model yang disimpan
     lewat console.
3. **Dua subagen audit.** Satu memeriksa keamanan permukaan kode baru, satu
   memverifikasi setiap perbaikan terhadap kode dan tesnya. Temuan
   terpentingnya diverifikasi ulang secara manual.
4. **Kompetitor.** Clone Paperclip, Buzz, dan Auto-Company diperbarui ke
   HEAD 30 September, lalu klaim negatif kuncinya di-grep ulang.

---

## 1. Jawaban singkat

**Kemajuannya besar dan nyata, tetapi jawabannya masih: belum "sangat
matang".**

- **Dari 12 cacat yang diuji ulang secara langsung, 10 kini benar-benar
  hilang, bukan hanya di tes:**
  - Task owner mulai dalam **4 detik** (dulu 5 menit 33 detik).
  - Model *reasoning* tidak lagi membuat run gagal.
  - Peran CMO bawaan bisa menyelesaikan tugas.
  - Harga yang dijawab owner terbawa ke rerun.
  - Charter sudah ada sejak boot.
  - Kartu tier 3 menyebut argumennya.
  - Penghapusan terverifikasi lewat 404.
  - Biaya tercatat mendekati biaya nyata.
  - Pemulihan setelah `kill -9` turun dari ±15 menit menjadi **47 detik**,
    tanpa efek ganda.
  - Kunci model tersimpan tidak lagi bocor ke origin lain.
- **Dua lainnya baru sebagian:**
  - Plafon token kini bisa dinaikkan dengan faktor kedua, tetapi tetap
    seumur hidup.
  - `/answer` kini menggerakkan task, tetapi task langsung menunggu lagi
    pertanyaan `owner.ask` yang sama.
- **SQL manual tidak lagi dibutuhkan.** Vendor, kredensial divisi, dan harga
  model kini diatur dari console dan langsung berlaku tanpa restart.
- **Uji ulang juga menemukan hal baru:**
  - Satu tugas pemasaran dengan model reasoning menghabiskan **325 ribu
    token** dan menguras seluruh jatah **seumur hidup** divisi Growth dalam
    sekali jalan. Task berhenti tanpa item di inbox owner.
  - Deteksi "pertanyaan setup" menelan pertanyaan kerja **berbahasa
    Indonesia**.
  - Ada dua temuan keamanan tingkat Sedang di kode baru: klaim deployment dan
    OAuth MCP tanpa faktor kedua.
  - Pemulihan crash yang baru bisa salah menganggap replika hidup sebagai
    mati setelah database terputus lebih dari 60 detik.
- **Kesiapan pasar tidak berubah.** Masih 0 bintang dan 0 pengguna, tanpa
  lisensi, tanpa rilis bertag, dan default branch masih `claude/…`. Paperclip
  bertambah **+5,4 ribu bintang** dalam dua hari yang sama (95,3 ribu).

**Skor ringkas** (0–10):

| Dimensi | 28 Sep | 30 Sep | Alasan perubahan |
|---|---|---|---|
| Rigor rekayasa inti | 8 | 8 | 1.204 tes lulus; sebagian besar perbaikan diawali tes gagal |
| Keamanan & tata kelola agen | 7 | 7 | Temuan HIGH beres, taint tidak bisa lagi "dicuci", dan passkey kebal lockout; tetapi muncul 2 temuan Sedang baru |
| Keandalan operasional | 5 | **6,5** | Konkurensi, pemulihan 47 detik, rate limit model di-*park*; tersisa H2, M1, M6, M10, dan risiko heartbeat |
| Kelengkapan produk & integrasi | 3 | **5** | Vendor, kredensial, dan harga dari console; OAuth vendor; WhatsApp; metrik Prometheus; OTLP; agregator MCP; runtime ACP |
| Adopsi, ekosistem, keberlanjutan | 1 | 1 | Tidak berubah |
| **Keseluruhan** | **4,5** | **5,5 — beta awal secara teknis, belum siap pasar** | |

Paperclip tetap 5,5, jadi keduanya kini setara di angka keseluruhan dengan
profil yang berkebalikan. PALUGADA jauh lebih ketat dan benar, sedangkan
Paperclip jauh lebih lengkap, lebih luas, dan sudah dipakai orang.

---

## 2. Suite dan kesehatan kode

| Ukuran | 28 Sep | 30 Sep |
|---|---|---|
| Typecheck | TS 5.9, lulus | **TS 7.0.2**, lulus (2,1 dtk) |
| Tes | 1.027 / 1.027 | **1.204 / 1.204** (lihat catatan) |
| Durasi suite | 6 mnt 50 dtk | 13 mnt 44 dtk (sebagian berjalan bersamaan dengan uji langsung) |
| Coverage fungsi / branch / baris | 94,3 / 85,5 / 97,5% | 93,6 / 85,3 / 97,5% |
| Baris kode `src/` | 53,4 rb | 64,3 rb |
| Migrasi | 77 | 98 |
| Log PostgreSQL | hanya penolakan yang diuji | hanya penolakan yang diuji, termasuk yang baru ("TRUNCATE is refused", timeout kunci migrasi) |
| `npm audit --omit=dev` | 0 | 1 moderat (`fast-uri`, turunan `ajv`) |

**Catatan tentang 2 tes yang gagal saat suite pertama kali dijalankan.**

- Tes yang gagal: `test/acceptance/process.test.ts:404` dan `:481`.
- Penyebabnya environment. Kedua tes baru ini login sebagai superuser
  `postgres` dengan kata sandi, seperti di CI, sedangkan cluster lokal
  memakai peer auth.
- Setelah kata sandinya disamakan dengan CI, berkas itu lulus 12/12.
- `AGENTS.md` (bagian *Setting up*) belum menyebut kebutuhan ini.

---

## 3. Status cacat lama, diuji ulang

Kolom "Bukti" menandai jenis pembuktiannya:

- **langsung**: dibuktikan di deployment yang berjalan dengan model
  sungguhan.
- **kode**: dibaca di kode dan tesnya.

| # | Cacat 28 Sep | Status 30 Sep | Bukti |
|---|---|---|---|
| L3 | Task owner menunggu 5 mnt 33 dtk di belakang review otomatis | **Diperbaiki.** Mulai dalam 4 dtk. Worker kini menjalankan 4 tempat paralel, dan pekerjaan rumah tangga berjalan di loop sendiri. *Sisa:* task owner tetap prioritas 2, sehingga "tempat khusus P0" tidak pernah melayani owner; percepatannya datang dari konkurensi (`api.ts:3135`, `tasks.ts:638`) | langsung + kode |
| L4 | Model reasoning: giliran kosong, gagal deterministik | **Diperbaiki, dengan efek samping.** Giliran kosong diulang dengan jatah 16.384 lalu ~20 rb token, dan run berlanjut. *Sisa:* lihat temuan baru B1 (biaya), dan diamnya model dua kali dengan `end_turn` masih bisa di-replay (`agent-loop.ts:158`) | langsung + kode |
| L5 | CMO bawaan tidak pernah bisa selesai | **Diperbaiki.** Kriteria kini berbunyi "…where crm.note is not connected, it is in the output". Rerun `completed`. *Sisa:* perusahaan lama tidak dimigrasikan, dan belum ada tes yang menjalankan setiap peran bawaan di instalasi baru | langsung |
| L6 | Rerun dari rerun kehilangan jawaban owner | **Diperbaiki.** Draf rerun memuat "Rp95.000" dan tidak ada "[TBD]". Rantai rerun dibatasi 10 generasi | langsung |
| L7 | Agen menanyakan konfigurasi ke owner | **Diperbaiki, tetapi dengan regresi** (lihat B2) | kode, direproduksi |
| L8 | Charter tidak pernah dimuat | **Diperbaiki.** Boot: "published charters where there were none: platform v1"; owner bisa mengubahnya dari console | langsung |
| L9 | Kartu tier 3 tanpa argumen | **Diperbaiki.** Judulnya kini "record.delete: recordId cust-042" dan `input` ikut dikirim | langsung |
| L10 | Delete terverifikasi 404 dianggap gagal | **Diperbaiki.** Tepat 1 DELETE, `tool.verified`, `completed`, tanpa insiden. *Sisa:* field `answers` menerima status ≥400 apa pun yang ditulis operator | langsung |
| L11 | Plafon token seumur hidup, tak bisa dinaikkan | **Sebagian.** Bisa dinaikkan dari console dengan faktor kedua (tanpa faktor ditolak 403). Tetapi plafon **masih seumur hidup**, task yang sudah berhenti harus di-rerun manual, dan menaikkan akun induk tidak menolong akun anak yang habis | langsung |
| L12 | Biaya fallback ~58× biaya nyata | **Diperbaiki.** Console dan setup mengambil harga dari models.dev. Task uji tercatat 5 sen vs ±2,6 sen biaya nyata (≈2×, karena minimal 1 sen per panggilan). *Sisa:* log boot tetap bilang "no model price list" walau harga console aktif, dan harga dicocokkan persis ke id model | langsung |
| L18 | `/answer` tidak melanjutkan task | **Sebagian.** Task kini bergerak, tetapi untuk pertanyaan `owner.ask` agen, replay jurnal langsung menunggu lagi pada item yang sama (lihat B6). Tombol console "Send the answer" tidak terkena | langsung |
| Crash | Mati suri ±15 menit setelah `kill -9` | **Diperbaiki.** Diambil alih setelah **47 dtk** (`holder_silent`), selesai dengan tepat 5 tiket berbeda. *Risiko baru:* B5 | langsung + kode |
| Keamanan #1 | Kunci model tersimpan terkirim ke origin lain | **Diperbaiki.** Kunci disimpan via console, lalu diminta ke origin lain: `hasAuth: false`; origin asli tetap berfungsi. Rute tool, push, dan MCP ikut diperbaiki | langsung + kode |
| Keamanan | Taint dicuci lewat anak/memori | **Diperbaiki** (`tasks.ts:125-149`, `engine.ts:383`) | kode |
| Keamanan | Lockout MFA global | **Sebagian.** Passkey kini kebal; owner yang hanya memakai TOTP masih bisa dikunci oleh dua alamat | kode |
| H3 | Rate limit model menghentikan task | **Diperbaiki** untuk gangguan singkat (di-*park* hingga ±15 menit) | kode |
| H2, M1, M6, M10, L2 | Gangguan vendor sesaat jadi halt permanen; klaim bocor saat error DB; jeda bulanan menghentikan antrean; tabel tanpa batas; tanpa handler `unhandledRejection` | **Belum diperbaiki** | kode |
| Impor | Arsip memulihkan approval dan referensi rahasia | **Belum diperbaiki** | kode |

---

## 4. Temuan baru

| # | Keparahan | Temuan | Bukti |
|---|---|---|---|
| B1 | **Tinggi** | **Model reasoning kini menghabiskan anggaran, bukan lagi gagal.** Satu tugas pemasaran memakai 325.448 token (263 rb input, 62 rb output): giliran kosong diulang dengan jatah 8.192, lalu 16.384, lalu ±20 rb, dan setiap ulangan mengirim ulang ±20 rb token konteks. Hasilnya: jatah **seumur hidup** divisi Growth (300 rb) habis dalam satu task, perusahaan memakai 381 rb dari 2 juta dalam ±10 menit, dan task berhenti `budget_exhausted`. **Tidak ada item inbox atau insiden**; owner hanya melihatnya sebagai "stopped" di Home/Work. Pertumbuhan jatah tidak dibatasi sisa anggaran run | uji langsung; `agent-loop.ts:115,155`; `budget_accounts` |
| B2 | **Sedang** | **Pertanyaan kerja berbahasa Indonesia ditelan platform.** Deteksi "pertanyaan setup" (L7) memakai regex berisi `hubung\w*` dan `pasang`. "Siapa pelanggan yang harus saya hubungi lewat email?" dan "Berapa harga yang harus saya pasang di postingan social media?" dijawab otomatis oleh platform dan tidak pernah sampai ke owner. Ini justru menyasar pasar utama PALUGADA | `src/broker/platform-capabilities.ts:608-631`, direproduksi dengan logika yang sama |
| B3 | **Sedang** | **Rahasia klaim deployment bisa dikloning.** Secret TOTP yang ditawarkan tautan klaim adalah `HMAC(masterKey, claim.id)`, sama setiap kali tautan dibuka. Siapa pun yang membaca tautan dari log PaaS (Coolify/Dokploy) lalu membukanya sebelum owner mengonfirmasi akan memegang salinan authenticator owner selamanya | `src/owner/claim.ts:99-104, 157-161` |
| B4 | **Sedang** | **OAuth MCP tanpa faktor kedua.** `POST /api/control/mcp/oauth/start` tidak memanggil `#requireFactor`, dan callback-nya menimpa token server yang sudah tersimpan. Pencuri sesi bisa menyambungkan server MCP perusahaan ke akun miliknya sendiri, sementara rute setara untuk kredensial divisi meminta faktor | `src/owner/api.ts:2168-2190`; `src/capabilities/mcp-oauth.ts:434-506` |
| B5 | **Sedang** | **Heartbeat bisa salah menyatakan replika hidup sudah mati.** Hanya worker yang bertanya yang dikecualikan. Setelah database terputus lebih dari 60 detik, replika pertama yang ber-tick mengambil alih run milik replika lain yang masih hidup. Langkah yang sedang berjalan bisa terulang (dijaga idempotency key vendor; panggilan model tertagih dua kali), dan setiap pengambilalihan dihitung ke `crash_loop` (3 = halt). Hanya relevan untuk deployment multi-replika | `src/engine/checkout.ts:415-431`; komentarnya sendiri mengakui kondisi itu |
| B6 | Rendah | `/answer` untuk pertanyaan `owner.ask` membuat task kembali menunggu pertanyaan yang sama (L18 sebagian). Tidak ada loop biaya | uji langsung (event `owner.answered` lalu `task.waiting_approval` dalam 3 dtk) |
| B7 | Rendah | Erasure: pemegang peran `palugada_admin` bisa memundurkan `closing_at`, lalu menghapus riwayat append-only milik perusahaan yang masih hidup | `db/migrations/0088_company_closing.sql` (laporan subagen) |
| B8 | Rendah | Menutup atau me-rotasi kunci pada perusahaan hasil impor bisa menghapus kunci tersegel milik perusahaan sumbernya, karena nama `db://credential-*` tidak terikat ke perusahaan | `src/audit/import.ts:113-124`, `closing.ts:221-236` (laporan subagen) |
| B9 | Info | Bundle `company-os` kini mengantrikan 11 review skill (dulu 9) dan menaruh 10 kartu skill di inbox owner pada hari pertama, padahal target PRD G3 adalah ≤10 item per hari | uji langsung |

---

## 5. Kompetitor, dua hari kemudian

Diperbarui 30 September dari clone dan halaman GitHub publik.

| | PALUGADA | Paperclip | Buzz | Auto-Company |
|---|---|---|---|---|
| Bintang | 0 | **95,3 rb** (+5,4 rb) | ±35 rb (angka 28 Sep) | 3,1 rb |
| Commit sejak 28 Sep | 90 | 56 | 22 | 0 |
| RLS di migrasi | FORCE di semua tabel tenant | **0** | **0** | — |
| Biaya tak berharga | harga fallback, atau harga models.dev | **masih 0 sen** (`heartbeat.ts:5251`) | tanpa budget | jeda |
| Approval ireversibel dengan 2FA | ya | tidak (approval tanpa kedaluwarsa) | izin tool masih di-auto-approve | tidak |

Pemilik repo juga menulis pemeriksaan kompetitor sendiri,
[`COMPETITIVE-ANALYSIS-2026-09-30.md`](COMPETITIVE-ANALYSIS-2026-09-30.md),
yang mencakup pendatang baru seperti OtoDock, CompozyOS, dan Meta Business
Agent. Dari dokumen itu, hanya klaim tentang Paperclip, Buzz, dan
Auto-Company yang diverifikasi ulang di sini, dan semuanya masih benar.

**Kesimpulan kompetitif tidak berubah.** Keunggulan inti PALUGADA (isolasi di
database, faktor kedua untuk aksi ireversibel, dan reservasi anggaran) masih
belum dimiliki kompetitor besar mana pun. Selisih ekosistem dan adopsinya
justru melebar.

---

## 6. Rekomendasi prioritas, diperbarui

**P0, sebelum dipakai untuk bisnis nyata:**

1. **B1.**
   - Batasi pertumbuhan jatah per giliran dengan sisa anggaran run.
   - Jadikan plafon token berperiode (bulanan seperti uang), bukan seumur
     hidup.
   - Munculkan item inbox yang bisa ditindaklanjuti (naikkan plafon lalu
     lanjutkan) saat task berhenti `budget_exhausted`.
2. **B2.** Jangan menjawab pertanyaan agen secara otomatis berdasarkan kata
   kerja umum. Batasi ke frasa yang jelas-jelas tentang konfigurasi, dan
   tambahkan tes negatif berbahasa Indonesia.
3. **B3 dan B4.**
   - B3: secret klaim acak per pembukaan yang harus dibawa oleh konfirmasi.
   - B4: faktor kedua di `mcp/oauth/start`, atau token baru disimpan dulu
     dengan nama sementara.
4. **B5.** Jangan mengambil alih run milik replika lain bila heartbeat
   sendiri juga basi, dan jangan hitung `holder_silent` ke `crash_loop`.

**P1:**

5. Beri pekerjaan owner prioritas P0 atau P1 agar tempat khusus terpakai.
6. Perbaiki L18 untuk `owner.ask`.
7. Tutup H2 (gangguan preflight vendor → *park*), M6 (jeda bulanan terangkat
   di awal bulan), M1, M10, dan L2.
8. Sebutkan kebutuhan superuser berpassword di `AGENTS.md`, dan sesuaikan
   pesan boot tentang harga.

**P2, tidak berubah dari 28 September:** lisensi, rilis bertag, default
branch `main`, dan operasi nyata 14 hari sesuai kriteria keluar PRD.

---

## 7. Batasan

- **Uji langsung.** Durasinya ±25 menit, dengan satu model dan vendor
  tiruan. Mesin sempat reboot di tengah uji harga; uji itu diulang setelah
  database dan server dinyalakan kembali.
- **Temuan dari laporan subagen.** B7, B8, dan sebagian status "kode" di §3
  berasal dari laporan subagen yang membaca kode tanpa menjalankannya.
  B1–B6 dan B9 dibuktikan langsung atau direproduksi.
- **Risiko multi-replika.** B5 tidak diuji dengan beberapa replika
  sungguhan; ia dibaca di kode, dan komentar kode itu sendiri mengakui
  kondisinya.
- **Skor.** Semua skor 0–10 adalah penilaian analis, bukan hasil benchmark.

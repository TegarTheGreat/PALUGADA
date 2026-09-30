# Pemeriksaan ulang kompetitor (30 September 2026)

Dokumen ini melanjutkan `COMPETITIVE-ANALYSIS-2026-09-28.md`. Pertanyaannya
sempit: **apa yang berubah di kompetitor dalam dua hari terakhir dan dalam
tiga bulan terakhir, siapa pendatang barunya, dan celah mana yang harus
PALUGADA tutup lebih dulu?**

## Cara memeriksa

- **Tiga subagen AI bekerja paralel.**
  - Subagen pertama membaca ulang Paperclip, Multica, dan Opifer.
  - Subagen kedua membaca ulang Buzz, Auto-Company, platform besar, dan Polsia.
  - Subagen ketiga mencari pendatang baru sejak Juli 2026, termasuk yang
    menyasar Indonesia dan Asia Tenggara.
- **Kode dibaca langsung.** Setiap repositori open-source di-clone pada HEAD
  terbaru.
- **Klaim negatif diperiksa dengan grep di kode**, bukan dari README. Contoh
  klaim negatif: "tidak punya RLS" atau "tidak ada faktor kedua". Perintah
  grep-nya dicatat di bagian 6.
- **Tidak ada login, pendaftaran, atau posting ke layanan mana pun.**
- **Firecrawl kehabisan kredit.** Sebagai gantinya dipakai GitHub search,
  WebFetch, dan halaman rilis publik.

Revisi yang dibaca:

| Proyek | Revisi |
|---|---|
| PALUGADA | `0ed10fc`, ditambah pekerjaan hari ini |
| Paperclip | `a027f76` (29 Sep) |
| Multica | `e31da86` (29 Sep) |
| Opifer | `c9568fe` (21 Sep) |
| Buzz | `2664d1431` (29 Sep; 28 commit sejak `b0d6fb8`) |
| Auto-Company | `8becd54` (tidak berubah) |
| CopilotKit OpenBot | `afe6233` |
| CompozyOS | `a15f541` |
| OtoDock | `1abb6f8` |
| AgenticOS (vstorm) | `987c4c2` |
| Manor AI | `140c09a` |
| AI Employees | `7f7de99` |

---

## 1. Jawaban singkat

1. **Keunggulan inti PALUGADA masih belum ditiru siapa pun.** Sebelas proyek
   diperiksa di kodenya. Hasil grep-nya:
   - Tidak satu pun memakai row level security PostgreSQL.
   - Tidak satu pun meminta faktor kedua untuk menyetujui aksi.
   - Hanya Opifer yang juga mencadangkan uang sebelum model dipanggil.
     - AgenticOS mengakui di dokumennya sendiri bahwa run yang berjalan
       bersamaan bisa melewati plafonnya (`docs/governance.md`).
     - OtoDock memeriksa plafon terhadap belanja yang sudah tercatat, tanpa
       reservasi.
     - Paperclip memeriksa setelah uang terpakai
       (`server/src/services/budgets.ts:67-73`).
2. **Kompetitor bergerak di luar lapisan tata kelola.** Arahnya:
   - lebih banyak konektor, termasuk agregator MCP seperti Zapier, Composio,
     Arcade, dan Executor;
   - lebih banyak kanal untuk owner, seperti iMessage, WhatsApp, Slack, dan
     email;
   - lebih banyak runtime (ACP, 26 CLI di Multica);
   - observabilitas: Prometheus di Multica, OTLP di Paperclip.
3. **Platform besar sekarang punya "persetujuan yang lebih sedikit tapi tepat".**
   - Claude Managed Agents: kebijakan `auto` (10 Sep).
   - OpenAI Dots: aturan per aksi dan auto-review (29 Sep).
   - Copilot Studio: "approve for session" (GA Sep).
   - Google: semantic governance policies.

   Owner tunggal yang mengelola beberapa perusahaan paling mungkin menyerah
   karena terlalu banyak persetujuan. Ini celah produk PALUGADA yang paling
   nyata.
4. **Di Indonesia, pesaing sesungguhnya adalah Meta Business Agent.**
   Diluncurkan untuk bisnis Indonesia pada 11 Agustus 2026 di WhatsApp
   Business Summit Jakarta. Cakupannya hanya front office di WhatsApp: tanpa
   back office dan tanpa tata kelola anggaran. Tidak ada proyek open-source
   yang serius untuk UMKM Indonesia.
5. **Yang dikerjakan hari ini sebagai jawaban ada di bagian 7.** Dua belas
   celah sudah ditutup: metrik, PITR, izin sementara, pin versi CLI,
   larangan TRUNCATE, WhatsApp, agregator MCP, penutupan perusahaan, ekspor
   OTLP, runtime ACP, model penjaga yang hanya memperketat, dan baris
   perbandingan plafon belanja di README. Email untuk owner dan versi yang
   terlihat sudah sebagian. Sisanya diurutkan.

---

## 2. Kompetitor lama: apa yang berubah

### Paperclip (94.691★, MIT)

- **Rilis:** v2026.916.1 (21 Sep).
- **Aktivitas:** 49 commit sejak revisi yang dianalisa 28 Sep. September
  saja 590 commit, 110 di antaranya `feat`.
- **Koneksi:**
  - Kredensial AI dikelola lewat Connections (#13247).
  - Identitas GitHub per orang menggantikan token bersama (#12843).
  - AgentMail memberi agen kotak surat sendiri, dan email membuat tugas
    (#13256).
  - Konektor Railway, Fireflies, dan you.com.
  - **Agregator MCP** (Zapier, Arcade, Composio, Executor), aktif secara
    default (#13755, #13964).
  - Total 79 definisi aplikasi; 61 di antaranya dengan OAuth.
- **Kanal:**
  - iMessage lewat Photon (#13299).
  - Percakapan dan pesan terjadwal di Slack (#13920).
  - Chat tidak pernah dianggap sebagai persetujuan
    (`services/chat-channels.ts:8016`).
- **Runner:**
  - Lapisan eksekusi jarak jauh.
  - 8 penyedia sandbox: Daytona, E2B, Modal, Cloudflare, Kubernetes,
    CreateOS, exe.dev, Novita.
  - Transport ACP yang lengkap (#14430).
- **Observabilitas:** trace OTLP saat `OTEL_EXPORTER_OTLP_ENDPOINT` diisi,
  ditambah Sentry. Tanpa metrik.
- **Rantai pasok:** image produksi ber-attestation dan image runtime yang
  ditandatangani cosign.
- **Tata kelola:**
  - Agen baru mendapat izin merekrut secara default (#12814), yang berarti
    pelonggaran.
  - Persetujuan bertipe tidak kedaluwarsa.

### Multica (51.706★, Apache-2.0 dengan syarat: tidak boleh jadi layanan hosted tanpa lisensi komersial)

- **Rilis:** v0.6.0 (28 Sep), dengan issue wakeup v2 berpelindung runaway dan
  indeks pencarian lokal.
- **Observabilitas:** endpoint **Prometheus `/metrics`**
  (`server/internal/metrics/server.go:13`).
- **Runtime:** 26 agent CLI lewat daemon lokal.
- **Aplikasi:** iOS (Expo, belum di App Store) dan desktop Electron.
- **Tata kelola:** tidak ada persetujuan owner dan tidak ada anggaran uang.
  `budget` hanya muncul di dua komentar yang tidak terkait.

### Opifer (5★, AGPL-3.0)

Sejak 21 Sep tidak ada push. Opifer tetap kembaran konseptual terdekat:
- Mencadangkan biaya sebelum setiap panggilan model.
- Persetujuan dengan `expires_at`.
- Audit append-only yang dijaga trigger.
- Kotak surat SMTP/IMAP.
- Updater `o4r update`.

Yang tidak dimiliki Opifer: RLS, faktor kedua, dan OAuth untuk MCP.

### Buzz (Block)

Ada 28 commit dalam dua hari:
- **Owner bisa meminta komunitas yang diarsipkan dihapus** (#7818). Caranya:
  - permintaan idempoten yang ditandatangani operator;
  - asal-usul yang tidak bisa diubah;
  - selama permintaan terbuka, pembatalan arsip dan pemindahan kepemilikan
    diblokir.
- **Permintaan itu disetujui otomatis** (#7830). PR-nya sendiri menulis
  "no human grace period", dan persetujuan owner hanya berupa kata operator.
- Identitas federasi NIP-FI (JWT dari IdP yang dicocokkan ke kunci NIP-42).
- Notifikasi ke layanan pendamping bertanda tangan NIP-98, dengan retry dan
  backoff.
- Gauge Prometheus untuk audit partisi.
- Readiness dari sampel dependensi yang di-cache.

### Auto-Company

Tidak berubah. `main` masih `8becd54` (27 Sep).

### Polsia

- Syarat 17 Sep: biaya atas pembayaran pelanggan turun dari 20% ke **3%**.
- Kode aplikasi yang di-deploy 30 Sep berisi fitur berikut:
  - "Polsia on iMessage" (owner menautkan akun dengan mengirim kode lewat
    SMS);
  - "Approve exact change" yang terikat ke revisi dan hash;
  - Google Calendar;
  - Google Ads dan Meta Ads.

---

## 3. Pendatang baru (Juli–September 2026)

| Nama | Lisensi | Daya tarik | Apa itu | Tata kelola (diperiksa di kode) |
|---|---|---|---|---|
| CopilotKit OpenBot | MIT | 5,7k★ sejak 17 Agu | "AI coworker" self-hosted; tiap agen punya container, browser, dan ruang kerja sendiri | Gateway kebijakan CEL; audit append-only dengan trigger, **termasuk larangan TRUNCATE**. Tanpa antrean persetujuan, faktor kedua, atau plafon uang. Owner bisa "mengambil alih kemudi" saat agen menemui dinding login/OTP |
| Symphony by Wix | Hosted | Distribusi Wix | Tim agen untuk UKM dengan agen "Maestro" dan rapat pagi harian | Owner menyetujui keputusan penting di aplikasi. Tidak ada informasi soal anggaran atau isolasi |
| Runable | Hosted | Seri A $21 juta, ~1,7 juta pengguna | Membuat situs, lalu menjalankan iklan, media sosial, dan SEO | Tidak dipublikasikan |
| OtoDock | FSL-1.1 | 187★ | "Agentic company OS" di atas langganan Claude Code/Codex milik owner | Hook memblokir tiap panggilan tool sampai diputuskan (maks 7 hari). Plafon mingguan/bulanan tanpa reservasi. **Versi CLI dipin dan dibekukan** |
| AgenticOS (vstorm) | Apache-2.0 | 49★ | Platform agen bertata kelola, Postgres + pgvector | Plafon dicek sebelum tiap panggilan, tapi bisa kelewatan saat run bersamaan (diakui). Persetujuan kedaluwarsa. Tanpa RLS |
| CompozyOS | MIT | 2,8k★ | Daemon Go yang membuat Claude Code, OpenClaw, dan Hermes bekerja sebagai tim | Persetujuan habis waktu dalam 120 detik. Tanpa plafon uang dan tanpa kanal chat |
| Manor AI | Sustainable Use | 158★ | Ruang kerja agen untuk UKM | **WhatsApp Cloud API** dengan tanda terima masuk yang tahan duplikat, plus Telegram, WeChat, Slack, Teams, Discord, dan Twilio. TOTP hanya saat login |
| AI Employees | MIT | 476★ dalam 4 minggu | Delapan kit peran bisnis berbentuk file | Kanal keluar ditahan sampai owner "melepas"-nya |

Di platform besar:

| Platform | Yang relevan bagi PALUGADA |
|---|---|
| Claude Managed Agents | Plafon belanja keras per sesi (7 Agu). Hook inferensi. `ant apply` dengan lockfile (3 Sep). **Kebijakan izin `auto`**: server menilai tiap panggilan tool, lalu menjalankan, menolak, atau menjeda untuk persetujuan (10 Sep) |
| OpenAI | Agents API beta publik dengan sesi tahan lama dan MCP (10 Sep). Pemantauan misalignment. Ekspor trace OTLP. **Dots** (29 Sep): aturan per aksi (izinkan / minta persetujuan / blokir) dan auto-review |
| Microsoft | Persetujuan manusia untuk panggilan tool GA di Copilot Studio, dengan **"approve for session"**. Peringatan belanja. Entra Agent ID untuk setiap agen |
| AWS Bedrock AgentCore | Rate limit per tool/model, dengan `rate=0` sebagai pemblokir. Pembayaran x402 terhadap anggaran sesi. Hook allow/deny sebelum panggilan tool. Portal persetujuan OAuth |
| Google | Plafon belanja bulanan. OpenTelemetry `gen_ai.*`. Semantic governance policies yang menilai panggilan tool |

---

## 4. Indonesia dan Asia Tenggara

- **Tidak ada proyek open-source serius untuk UMKM Indonesia.** Yang terbesar
  masih kecil:
  - persona berbahasa Indonesia (25★);
  - MCP Shopee yang hanya membaca (9★);
  - skill gateway pembayaran Malaysia (71★);
  - MCP Xendit (4★). Proyek ini menolak disbursement sebelum empat hal diisi:
    plafon per transfer, plafon harian, daftar rekening, dan kode
    persetujuan. Itu pola yang sejalan dengan PALUGADA.
- **Tidak ada yang punya daya tarik untuk Midtrans, QRIS, atau Tokopedia.**
- **Pesaing nyata: Meta Business Agent (11 Agu, Jakarta).** Ia menjawab
  pelanggan di WhatsApp, merekomendasikan dari katalog, dan menyerahkan ke
  manusia. Ia tidak menjalankan back office dan tidak punya tata kelola
  anggaran.

  Posisi PALUGADA: perusahaan di belakang WhatsApp, bukan pengganti
  WhatsApp. Syaratnya, owner bisa memakai WhatsApp sebagai kanalnya.

---

## 5. Di mana PALUGADA unggul (diperiksa di kode, bukan README)

| Kemampuan | PALUGADA | Kompetitor yang punya |
|---|---|---|
| Isolasi tenant oleh RLS PostgreSQL yang dipaksa | Ya | Tidak ada dari 11 |
| Faktor kedua (TOTP/passkey) untuk menyetujui aksi tier 3 | Ya | Tidak ada dari 11 |
| Uang dicadangkan sebelum kerja dimulai | Ya | Opifer |
| OAuth untuk MCP, dengan setiap tool tetap melewati broker dan tier-nya | Ya | OAuth MCP ada di Paperclip dan Multica; tidak diperiksa apakah tiap tool diberi tier |
| Basis pengetahuan dokumen yang dicari per bagian | Ya | Sebagian: plugin LLM Wiki di Paperclip |
| Metrik Prometheus | Ya (hari ini) | Multica, Buzz |
| Persetujuan kedaluwarsa, diputuskan sekali, dengan argumen yang dibaca owner | Ya | AgenticOS, Opifer; sebagian di Paperclip |

---

## 6. Bagaimana klaim negatif diperiksa

| Klaim | Pola grep | Cakupan dan hasil |
|---|---|---|
| RLS | `row level security\|CREATE POLICY\|FORCE ROW` | 289 migrasi Paperclip, 1.178 file migrasi Multica, seluruh `.sql`/`.ts` Opifer, dan keenam clone pendatang baru: 0 temuan |
| Faktor kedua | `totp\|webauthn\|passkey\|two.?factor\|otpauth` | Di kode persetujuan: 0 temuan. Dua temuan lain adalah positif palsu: string tes dan pengklasifikasi konten OTP |
| Vektor | `pgvector\|vector\(\|embedding` | Migrasi Paperclip dan Multica: 0 temuan |
| WhatsApp | — | Paperclip dan Opifer: 0 temuan. Multica: 1 komentar kode. Manor: implementasi penuh |
| Rotasi master key | — | 0 temuan di ketiga kompetitor lama |

---

## 7. Celah, diurutkan, dan apa yang dikerjakan

Prioritas dinilai dari sudut owner tunggal yang menjalankan beberapa
perusahaan dari ponsel, di Indonesia.

| # | Celah | Siapa yang punya | Prioritas | Status |
|---|---|---|---|---|
| 1 | Metrik untuk operator (antrean, tempat kerja, belanja per perusahaan) | Multica, Buzz | Sedang | **Selesai hari ini**: `GET /api/metrics` format Prometheus dengan token scrape (STATUS 2.27) |
| 2 | Pemulihan ke titik waktu | — (kebutuhan operasi) | Sedang | **Selesai hari ini**: panduan PITR yang dijalankan sebagai drill di PostgreSQL 16 |
| 3 | Terlalu banyak persetujuan: "setujui untuk sementara" | Copilot Studio, Dots | Tinggi | **Selesai hari ini** (STATUS 2.28). Izin sempit per peran dan kapabilitas, berbatas waktu (maks. 7 hari), dengan faktor kedua, dan bisa dicabut. Hanya untuk tier ≤ 2, dan tidak pernah untuk aksi yang dipicu konten dari luar (F8.9) |
| 4 | Pin versi agent CLI yang pengamanannya sudah diuji | OtoDock | Tinggi (keamanan) | **Selesai hari ini** (STATUS 2.29). Versi lain tidak mendapat pekerjaan sampai owner memasang versi teruji atau menerimanya dengan faktor kedua; pembaruan otomatis tiap CLI dimatikan. Claude Code 2.1.285 di mesin ini langsung tertangkap |
| 5 | Larangan TRUNCATE pada tabel append-only | OpenBot | Sedang | **Selesai hari ini** (STATUS 2.27). Trigger pernyataan menolak TRUNCATE; Compose memigrasi di layanan terpisah sehingga proses app tidak lagi memegang URL pemilik skema (diverifikasi di stack Compose nyata) |
| 6 | WhatsApp sebagai kanal owner, dengan tanda terima masuk yang tahan duplikat | Manor, Polsia (iMessage), Meta | Tinggi (Indonesia) | **Selesai** (STATUS 2.31): Cloud API, tanda tangan Meta, tanda terima masuk di database (0085), tombol, template di luar jendela 24 jam, dan percakapan dengan CEO. Desainnya ditiru dari Manor, bukan kodenya (lisensi Sustainable Use) |
| 7 | Model yang menilai tiap panggilan: jalankan atau tanya owner | Claude `auto`, Dots, Google | Tinggi, berisiko | **Selesai, hanya memperketat** (STATUS 2.45). "Penjaga" per perusahaan, mati secara bawaan. Setelah pekerjaan membaca konten dari luar, setiap panggilan tier 0/1 yang tidak ditanyakan aturan lain dinilai model lebih dulu; model hanya bisa meneruskannya ke owner beserta alasannya, tidak pernah meloloskan. Model tidak diperlihatkan teks dari luar. Gagal menilai berarti bertanya ke owner. Biaya tiap penilaian dibebankan ke anggaran pekerjaan. Mematikannya butuh faktor kedua. Tinjauan ulang menemukan jalan memutari penjaga dan F8.9 (rerun, sub-tugas, izin sementara); sudah ditutup, lihat bagian 9 |
| 8 | Penyedia sandbox siap pakai (E2B, Daytona, Modal) | Paperclip (8) | Tinggi | Direncanakan. Butuh akun uji nyata; tidak ditulis dari tebakan |
| 9 | Agregator MCP (Zapier, Composio, Arcade) | Paperclip, Multica | Tinggi | **Selesai**: preset Composio, Pipedream, Arcade, dan Smithery di samping Zapier, diperiksa ke dokumen vendor dan metadata OAuth-nya tanpa kredensial. Setiap tool agregat tetap dipetakan ke tier satu per satu |
| 10 | Email untuk agen dan owner | Paperclip (AgentMail), Opifer (IMAP) | Sedang-tinggi | **Sebagian** (STATUS 2.41). Owner kini diberi tahu lewat email (Resend, Postmark, SendGrid; alamat dan header tiap layanan dikonfirmasi lewat 401 tanpa kredensial asli), dengan tautan ke konsol dan tanpa tombol. Kotak surat untuk agen (menerima email) belum |
| 11 | Menutup perusahaan: arsip, lalu hapus (UU PDP) | Buzz | Sedang | **Selesai** (STATUS 2.38). Owner menutup dengan faktor kedua dan mengetik nama perusahaan; perusahaan langsung dibekukan, masa tenggang 7–90 hari bisa dibatalkan, lalu worker menghapus setiap barisnya termasuk riwayat append-only. Database sendiri yang memeriksa bahwa perusahaan sudah ditutup dan masa tenggangnya habis (0088), lalu menyisakan satu baris jejak berisi nama dan jumlah yang dihapus |
| 12 | Iklan (Meta Ads, Google Ads) dengan belanja yang disetujui | Polsia, Runable | Sedang | Direncanakan sebagai konektor vendor dengan tier 3 untuk belanja |
| 13 | Ekspor trace OTLP | Paperclip, OpenAI, Google | Rendah-sedang | **Selesai** (STATUS 2.40). Setiap run yang selesai dikirim sebagai span OTLP/HTTP JSON ke collector yang dinamai lewat variabel standar `OTEL_EXPORTER_OTLP_*`, dengan langkah dan panggilan model di bawahnya (konvensi GenAI). Prompt, respons, dan isi alat tidak ikut dikirim |
| 14 | Runtime ACP generik | Paperclip, Multica | Sedang | **Selesai** (STATUS 2.42). Satu entri `"dialect": "acp"` menjalankan agen apa pun yang berbicara ACP versi 1 (Gemini CLI `--acp`, adaptor Claude dan Codex, Goose, OpenCode). Tool peran diberikan lewat server MCP HTTP di `session/new`; izin dijawab sekali, tidak pernah "selalu", ya hanya untuk tool peran; tidak ada file system atau terminal; `session/cancel` sebelum proses dihentikan; biaya dari `usage_update`. Diuji terhadap agen tiruan yang ditulis dari skema v1; belum ada agen ACP asli yang dijalankan di sini. Tinjauan ulang menemukan run gagal tidak ditagih dan run bisa menggantung; sudah ditutup, lihat bagian 9 |
| 15 | Rilis bernomor dan updater | Paperclip, Opifer | Tinggi | **Sebagian.** Versi yang berjalan kini terlihat di `/api/health`, di metrik (`palugada_build_info`), di span OTLP, dan di menu owner; `CHANGELOG.md` mencatat isi tiap versi dan tes menolak versi tanpa catatan. Rilis bernomor dan updater masih terbuka. **Lisensi adalah keputusan pemilik repositori** dan tidak dipilih di sini |
| 16 | Owner mengambil alih browser saat agen menemui login/OTP | OpenBot | Rendah sekarang | Terbuka. Relevan kalau agen menjalankan seller center atau portal bank |
| 17 | Halaman perbandingan yang jujur soal apa yang tidak dihentikan anggaran kompetitor | — | Rendah (dokumen) | **Selesai.** Tabel "How it compares" di README kini punya baris plafon belanja: Paperclip memeriksa setelah uang terpakai; PALUGADA mencadangkan sebelum kerja dimulai, dan tetap mengakui bahwa satu panggilan yang lebih mahal dari estimasinya bisa melewati plafon. Baris integrasi dan observabilitas yang sudah usang ikut diperbarui |
| — | Batas lama satu run per peran (item lama #102) | — (kebutuhan sendiri) | Sedang | **Selesai hari ini** (STATUS 2.30) |

---

## 8. Batasan

- **Sumber tanggal dan jumlah bintang.** Jumlah bintang diambil dari GitHub
  pada 30 Sep. Riwayatnya tidak diperiksa, karena data OSSInsight berlabel
  "degraded".
- **Produk hosted hanya dinilai dari luar.** Symphony, Runable, Polsia, dan
  Meta Business Agent dinilai dari materi publik dan, untuk Polsia, dari kode
  aplikasi yang di-deploy. Tidak ada login ke satu pun.
- **OpenAI.** openai.com menjawab 403, jadi fakta OpenAI diambil dari dokumen
  developers.openai.com, pos komunitas resmi, dan liputan pers tentang Dots.
- **Firecrawl kehabisan kredit** (HTTP 402).

---

## 9. Tinjauan ulang atas pekerjaan hari ini

Empat fitur yang ditulis hari ini (baris 7, 14, F5.7, dan F3.11) masing-masing
diperiksa ulang oleh peninjau terpisah yang hanya membaca kode dan menjalankan
skrip di ruang coba, tanpa menyentuh database bersama. Setiap temuan yang
terbukti ditulis dulu sebagai tes yang gagal, lalu diperbaiki.

| Area | Temuan terpenting | Status |
|---|---|---|
| Repositori piagam (F3.11) | `SOUL.md` berupa symlink ke kunci master diterbitkan sebagai piagam dan, pada penyimpanan berikutnya, kunci itu tertimpa. Direktori di dalam repo git lain membuat `add --all` ikut meng-commit `.env` dan kunci master. Merge yang belum selesai diterbitkan beserta penanda konfliknya. Satu berkas rusak membekukan catatan, sehingga simpanan owner berikutnya dibatalkan | **Diperbaiki** (STATUS 2.44). Symlink tidak pernah diikuti (O_NOFOLLOW, jalur dicek tetap di dalam repo), direktori selalu menjadi repo sendiri, merge/rebase menahan seluruh sinkronisasi, tiap berkas diproses sendiri-sendiri, batas 20.000 karakter berlaku, dan versi dari berkas dicatat sebagai milik repositori, bukan owner |
| Taint F8.9 dan penjaga (baris 7) | Penjaga tidak bisa dibujuk meloloskan panggilan, tapi pekerjaan bisa melewatinya: "jalankan lagi" membuat tugas baru tanpa taint, sehingga kirim email yang sudah ditolak owner lolos tanpa bertanya; sub-tugas yang dibuat setelah saudaranya membaca email juga bersih; izin sementara berlaku untuk aksi tier 0/1 di pekerjaan ber-taint; brief agen ditampilkan ke penjaga sebagai permintaan owner | **Diperbaiki** (STATUS 2.45). Taint ikut ke rerun dan ke sub-tugas; izin sementara diperiksa di semua tier; penjaga melihat permintaan owner yang sebenarnya, sedangkan brief agen dan deskripsi panggilan dipagari sebagai data; biaya penilaian yang ditolak anggaran menghentikan panggilan; model yang tidak menjawab dalam 30 detik dianggap ragu |
| Runtime ACP (baris 14) | Run yang gagal tidak dikenai biaya (termasuk semua percobaan ulangnya). Satu baris keluaran yang tidak terbaca membuat run menunggu sampai deadline atau selamanya. Run yang dibatalkan sebelum sesi terbuka tetap menjalankan seluruh giliran. $0,07 ditagih 8 sen karena pembulatan floating point | **Diperbaiki** (STATUS 2.42). Biaya dilaporkan selama run dan sebelum kegagalan; agen yang keluarannya tak terbaca dihentikan dan alasannya dicatat (tes: 2,6 detik, sebelumnya menggantung sampai deadline); prompt tidak dikirim setelah pembatalan; pembulatan sen diperbaiki untuk semua runtime |
| Panggilan serentak (F5.7) | Dua replika bisa sama-sama mengambil tempat terakhir (recheck PostgreSQL atas LEFT JOIN); runtime di luar proses tidak diparkir saat penuh; batas tidak punya plafon (2^31 baris pada panggilan pertama); batas yang diturunkan tidak langsung berlaku | **Diperbaiki** (STATUS 2.43). Advisory lock per divisi dan kapabilitas, semua pemegang yang hidup dihitung, plafon 100 di API, bundle, dan database (0093), dan `capability.busy` memarkir run di luar proses |
| Kontainer (F12.9) | STATUS mengakui belum pernah ada run utuh di kontainer sungguhan | **Selesai** (STATUS 2.46). `npm run container:check` menjalankan satu run lewat adaptor di Docker 29.3.1: nobody, image read-only, tanpa jaringan, tanpa capability, 512 MiB, tanpa env orkestrator. Kontrol negatif tanpa flag adaptor gagal di setiap sifat, jadi pemeriksaannya bisa gagal |

Setelah perbaikan itu, **tinjauan kedua** dijalankan atas perbaikannya
sendiri, dan menemukan lapisan berikutnya:

- **Repositori piagam:** berkas catatan (`.palugada-written.json`) dan
  `.gitignore` masih mengikuti symlink, sehingga catatan yang di-push sebagai
  link ke kunci master menimpa kunci itu dengan JSON. Publish yang gagal
  sempat dicatat seolah sudah ditulis, dan `add --all` ikut meng-commit berkas
  yang ditolak serta menutup `stash pop` yang konflik. Semua **diperbaiki**:
  link ditolak, catatan ditulis lewat rename, hanya piagam yang di-commit, dan
  indeks yang belum di-merge, bisect, atau HEAD terlepas menahan sinkronisasi.
- **Taint:** tugas yang dibuat owner dari tiket tulisan agen masih bersih,
  dan taint rerun ditulis di transaksi terpisah. Kini taint ikut di transaksi
  yang membuat tugas, termasuk dari tiket agen. Penolakan anggaran di runtime
  luar proses kini menghentikan tugas, sama seperti di dalam proses.
- **ACP:** agen yang dijalankan lewat shim (npx, uvx, shell) kini dihentikan
  bersama seluruh grup prosesnya.
- **Panggilan serentak:** panggilan yang menunggu tempat sempat dinilai
  penjaga (dan dibayar) serta mencatat pemakaian izin sementara di setiap
  percobaan. Kini tempat diambil lebih dulu.

Yang **belum** ditutup, dan dicatat sebagai sisa risiko:

- Dua replika yang berbagi satu direktori piagam tidak saling mengunci di luar
  proses.
- Selama berkas piagam ditolak atau sinkronisasi ditahan, piagam yang disimpan
  owner di konsol tidak sampai ke berkasnya. Konsol kini memberi tahu saat itu
  juga ("Tersimpan, tetapi berkasnya tidak ditulis", beserta alasannya), tetapi
  berkasnya tetap tertinggal sampai seseorang memperbaikinya.
- Anggaran belum bisa menghentikan run ACP di tengah jalan; biaya kini
  tercatat selama run, tetapi yang menghentikannya tetap deadline atau batas
  panjang run.

---

## 10. Tiga kompetitor dibaca dari kodenya, satu per satu

Dikerjakan 30 September 2026 dengan `git clone` dan membaca kode saja: tidak
ada yang dipasang atau dijalankan, dan tidak ada akun yang dipakai. Revisi
yang dibaca: Paperclip `25c422b` (30 September), Buzz `0ee6093`
(30 September), Auto-Company `8becd54` (v2.0.0, 27 September). Setiap klaim
tentang PALUGADA dari pembacaan itu diperiksa lagi di kode PALUGADA sebelum
dikerjakan, dan setiap perbaikan ditulis dulu sebagai tes yang gagal.

### 10.1 Paperclip

Skala: sekitar 482 ribu baris TypeScript di server saja dan sekitar 24 ribu
kasus tes. PALUGADA: sekitar 62 ribu baris dan sekitar 1.160 tes.

**Kelebihan yang nyata**

- Mencatat pid, process group dan waktu mulai proses setiap run, lalu
  setelah restart membunuh process group yang tertinggal
  (`heartbeat.ts:8906`, `:18917`).
- 16 jenis adaptor bawaan dan 8 penyedia sandbox sungguhan (E2B, Daytona,
  Modal, dan lain-lain), masing-masing dengan tes.
- 80 definisi aplikasi, kanal Slack, Discord, Teams, Telegram, GitHub,
  Google Chat dan iMessage.
- Backup terjadwal harian/mingguan/bulanan dengan peringatan backup basi,
  image yang ditandatangani, action CI yang dipin dengan SHA, Dependabot.

**Kekurangan yang nyata**

- Mode bawaan `local_trusted`: permintaan dari loopback tanpa token menjadi
  admin instance, dan pemeriksaan origin dilewati untuknya
  (`middleware/auth.ts:224-233`). Agen lokal yang punya shell penuh — dan
  itu bawaannya (`dangerouslySkipPermissions` = true) — bisa memanggil API
  papan.
- Anggaran diperiksa terhadap biaya yang sudah tercatat, biaya ditulis
  sekali di akhir run, pemakaian tanpa harga dan langganan dihitung 0, dan
  tidak ada anggaran token.
- Batas run serentak per agen disimpan di memori proses (`Map`, 30 detik),
  tidak aman antar-instance.
- Menghapus agen ikut menghapus log aktivitasnya.
- Tidak ada row level security (0 policy di 290 migrasi), tidak ada TOTP
  atau passkey, telemetri menyala secara bawaan.
- Berkas raksasa (`heartbeat.ts` 30 ribu baris, `chat-channels.ts` 38 ribu).

**Yang diambil PALUGADA**

- **Proses CLI yang tertinggal saat worker dibunuh paksa (STATUS 2.52).**
  Setiap process group yang dimulai sebuah run kini dicatat (tabel
  `run_processes`, migrasi 0095): pid, process group, waktu mulai dari
  `/proc`, worker, dan identitas mesin. Worker berikutnya di mesin yang sama
  mengakhiri grup milik worker yang sudah mati, hanya bila pid-nya masih
  memiliki waktu mulai yang tercatat (pid yang dipakai ulang tidak pernah
  disentuh). Tesnya membunuh worker sungguhan dengan SIGKILL di tengah run
  CLI, lalu memastikan CLI dan anaknya diakhiri pada tick pertama worker
  berikutnya. Lebih ketat daripada Paperclip: Paperclip tidak memeriksa
  apakah worker lama masih hidup lewat waktu mulai prosesnya.
- **Rantai pasok (STATUS 2.54).** Action CI dipin dengan SHA, base image
  dipin dengan digest, Dependabot untuk npm, action dan docker, dan job
  audit dependensi produksi yang gagal pada advisori tinggi atau kritis.

**Yang sengaja tidak diambil:** melanjutkan sesi CLI dengan `--resume`
(sesi yang dilanjutkan membawa konten luar yang mungkin ber-taint; perlu
aturan F8.9 dulu), dan penyedia sandbox sungguhan (butuh akun; tetap celah
nomor 8 di bagian 7).

### 10.2 Buzz (Block)

Skala: 33 crate, sekitar 645 ribu baris Rust, sekitar 6.500 tes Rust.

**Kelebihan yang nyata**

- Penghapusan komunitas berjalan bertahap dengan lease yang di-heartbeat,
  efek luar dibatalkan saat lease hilang, dan manifest tabel yang memblokir
  penghapusan bila ada tabel tenant baru yang belum didaftarkan.
- Readiness yang hanya menjawab dari proses, kesehatan dependensi dari
  sampel 30 detik, dan `lock_timeout` 5 detik di pool penulis dan migrasi.
- Tes database paralel dari template database, property test, catatan
  "mutation evidence", `clippy -D warnings`, action dipin dengan SHA.
- Rantai hash atas log audit dan pembatas laju yang menolak saat Redis tak
  terjangkau.

**Kekurangan yang nyata**

- Persetujuan di-commit lalu pekerjaan dilanjutkan di `tokio::spawn` yang
  terlepas: crash di antaranya membuat run terdampar.
- Entri audit lewat antrean di memori setelah commit: hilang saat crash.
- Rantai hash audit hanya diverifikasi dari tes, tidak pernah di produksi.
- Mode izin agen bawaan `bypass-permissions`, `allow_once` disetujui
  otomatis, persetujuan workflow masih TODO, tidak ada batas hop.
- Secret webhook disimpan polos dan dibandingkan mentah, tanpa tanda tangan
  atau stempel waktu.
- Tidak ada row level security; isolasi tenant di kode aplikasi.

**Yang diambil PALUGADA**

- **Lease dengan batas waktu lokal (STATUS 2.50).** Dulu worker yang
  terputus dari database terus menjalankan tugas sementara lease-nya habis
  di database dan worker lain mengambil tugas yang sama. Kini bila tidak
  ada perpanjangan yang berhasil selama satu masa lease, run dihentikan.
- **Worker yang tak pernah menyelesaikan tick dianggap sehat selamanya**
  (bug nyata di `main.ts`). Diperbaiki: keterlambatan dihitung sejak worker
  mulai.
- **Migrasi yang menunggu kunci tanpa batas.** Kini `lock_timeout` 10 detik
  per migrasi, gagal dengan nama migrasinya, dan diulang oleh restart
  kontainer; antrean antar-replika tetap menunggu.
- **Penghapusan perusahaan satu per satu (STATUS 2.51).** Satu perusahaan
  yang gagal dihapus dulu memblokir semua perusahaan sesudahnya, di setiap
  tick. Kini tiap perusahaan dihapus sendiri, kegagalan dicatat dengan
  backoff dan terlihat di konsol, berkas perusahaan dan folder piagamnya
  ikut dihapus, dan sebuah tes membaca katalog database untuk memastikan
  setiap tabel ber-`company_id` ikut terhapus lewat cascade atau terdaftar
  dengan alasan (manifest ala Buzz). Tutup dan batalkan-tutup kini satu
  transaksi dengan event auditnya.
- **Readiness saat berhenti, health yang murah, pencarian berindeks
  (STATUS 2.58).** `GET /api/ready` menjawab 503 begitu penghentian dimulai,
  sebelum listener ditutup; sampel database diambil sekali per lima detik
  berapa pun banyaknya probe, dan database yang diam dijawab "tak terjangkau"
  dalam dua detik; pencarian lintas perusahaan memakai indeks trigram
  (`pg_trgm`) yang dibuktikan dipakai lewat `EXPLAIN` di tes.

### 10.3 Auto-Company

Skala: 474 berkas, 557 fungsi tes; sebuah loop bash yang memanggil satu
model headless kira-kira setiap 30 detik, dengan 14 persona sub-agen.

**Kelebihan yang nyata**

- Persona membawa metode, bukan hanya gaya: daftar periksa dan bentuk
  jawaban tetap; 36 skill.
- Setiap siklus mulai dari "keadaan perusahaan": proyek aktif dan apa yang
  sudah dikerjakan.
- Hasil tes dicatat oleh program, bukan oleh model (kode keluar, jumlah
  tes, hash), dan laporan dilarang mengarang hasil tes.
- Waktu mulai beberapa menit di atas login Claude/Codex yang sudah ada.

**Kekurangan yang nyata**

- Mode bawaan `bypassPermissions` / `danger-full-access`; aturan hanya di
  prompt.
- Salinan pengaman dan penanda jeda ada di pohon berkas yang bisa ditulis
  agen; "khusus manusia" hanya variabel lingkungan dan satu kata.
- Model menulis ulang seluruh keadaan dan diumpankan kembali apa adanya;
  circuit breaker direset tanpa akhir; batas biaya mati secara bawaan dan
  diperiksa setelah siklus sampai 30 menit.
- Tidak ada notifikasi sama sekali; blocker P1 dicek ulang tiap 30 detik
  dan menulis sekitar 2.880 baris log per hari.
- Isi prompt tidak diperiksa: statistik tanpa sumber, persona yang saling
  bertentangan, dan saran "tidak perlu unsubscribe" yang salah menurut
  PECR/GDPR.

**Yang diambil PALUGADA (STATUS 2.53)**

- **Review mingguan yang melihat minggunya.** Dulu tugas review mingguan
  hanya menerima satu kalimat dan hanya melihat metrik di rantai goalnya
  sendiri, padahal skill-nya meminta "setiap metrik terhadap targetnya dan
  apa yang dikirim". Kini penjadwal menyerahkan fakta minggu itu dari baris
  database — bukan dari teks model: retro, setiap goal aktif dengan metrik,
  nilai seminggu lalu dan perubahannya, pekerjaan yang selesai, belanja
  terhadap batas, dan usulan tahap yang terbuka — dibatasi ukurannya, dan
  hasil dari pekerjaan yang membaca konten luar tetap dibungkus sebagai
  data. Ini versi yang diatur dari "keadaan perusahaan" Auto-Company, tanpa
  kelemahannya (model yang menulis ulang keadaannya sendiri).
- **`goal.propose`.** Fungsi usulan goal sudah ada tetapi tidak punya
  pemanggil, dan menyetujui itemnya tidak mengubah apa pun. Kini ada
  kapabilitas tier 0; persetujuan pemilik (dengan faktor kedua) menerapkan
  perubahan dalam transaksi yang sama, dan ditolak bila goal sudah berubah.
- **Memori episodik yang diiklankan tetapi tidak pernah ada.** Tugas yang
  selesai kini meninggalkan satu baris untuk proyeknya, dan pencarian
  episodik dibatasi ke proyek tugas yang bertanya.
- **Tahap wind-down memblokir yang katanya harus diselesaikan.** Balasan ke
  pelanggan dulu ditolak mutlak; kini iklan dan pembelian tetap ditolak,
  tindakan keluar lainnya meminta persetujuan pemilik.
- **Skill:** premortem kini menyebut siapa yang mengawasi setiap tanda
  bahaya dan angka mana yang dibaca; skill baru `positioning` dan
  `market-research`, masing-masing dengan kasus uji.

- **Bukti yang bisa dicek platform (STATUS 2.56).** Dulu kriteria "selesai"
  dianggap terpenuhi bila run berkata demikian dan menulis bukti apa saja.
  Kini bukti boleh mengutip panggilan tool sebagai `step:<n>`; platform
  mencocokkannya dengan jurnal tugas itu. Kriteria yang mengutip langkah
  yang berhasil ditandai **Terverifikasi**, yang tidak mengutip apa pun
  **Diklaim**, dan kutipan palsu (langkah gagal, milik tugas lain, atau tidak
  ada) menggagalkan kriteria. Piagam platform menambah aturan: angka, hasil
  tes atau tanggal hanya muncul bila tool di tugas itu menghasilkannya.
- **Kritikus sebelum setiap perpindahan tahap (STATUS 2.57).** Premortem
  "Munger" di Auto-Company hanya ada di prompt. Di PALUGADA, company-os 1.4.0
  punya peran `critic` di divisinya sendiri yang tidak bisa bertindak, dan
  kebijakan yang menaruh `stage.propose` di belakang ulasannya. Pemilik
  melihat vonis kritikus baik saat mendukung maupun menghentikan usulan.
  Sambil jalan ditemukan bug lama: tugas ulasan dibuat di divisi pengusul,
  sehingga ulasan lintas divisi gagal di database sejak migrasi 0058.

**Yang sengaja tidak diambil:** loop yang memaksa membangun setiap siklus
("force a choice and build it"), kontrol di pohon berkas yang bisa ditulis
agen, dan mode izin `bypassPermissions` bawaan.

### 10.4 Setelah perubahan ini

| Aspek | Paperclip | Buzz | Auto-Company | PALUGADA sekarang |
|---|---|---|---|---|
| Isolasi tenant | Kode aplikasi | Kode aplikasi | Satu perusahaan | Row level security dipaksa, kunci komposit |
| Uang | Diperiksa setelah dibelanjakan | Token dihitung setelahnya | Mati secara bawaan | Dicadangkan sebelum kerja, per rantai akun |
| Izin agen bawaan | Shell penuh | `bypass-permissions` | `bypassPermissions` | Hanya tool perannya; tier 3 butuh faktor kedua |
| Proses CLI setelah crash | Dibersihkan | Tidak ada | Tidak ada | Dibersihkan, dengan pemeriksaan waktu mulai (2.52) |
| Lease saat database hilang | Kunci di memori | Lease dengan deadline | Tidak ada | Deadline lokal (2.50) |
| Penghapusan tenant | Menghapus log audit | Bertahap, manifest | Tidak ada | Per perusahaan, berkas ikut, manifest (2.51) |
| Keadaan perusahaan untuk agen | Tidak ada | Tidak ada | Ditulis ulang model | Dihitung dari database (2.53) |
| Bukti "selesai" | Kata run | Tidak ada | Pemeriksa milik program | Dikutip ke jurnal, Terverifikasi/Diklaim (2.56) |
| Keputusan GO/NO-GO | Tidak ada | Tidak ada | Premortem di prompt | Kritikus yang ditegakkan kebijakan (2.57) |
| Health/readiness | Tidak ada Prometheus | Readiness lokal, sampel 30 detik | Tidak ada | Readiness 503 saat berhenti, sampel 5 detik (2.58) |
| Rantai pasok CI | SHA, Dependabot, tanda tangan image | SHA, `cargo-deny` | Tidak ada | SHA, Dependabot, audit, digest (2.54) |
| Pemasangan | Postgres tertanam | Helm | Skrip | Compose, Coolify, Dokploy, klaim pemilik (2.48, 2.49) |

## 11. Coolify dan Dokploy

Keduanya dibaca dari kode sumbernya (Coolify 4.3.23 dan main; Dokploy
0.30.8 dan canary) untuk mengetahui persis cara masing-masing menjalankan
berkas compose. Memasang salah satunya di lingkungan ini tidak diizinkan,
jadi keduanya disimulasikan dengan `docker compose` persis seperti cara
platform menjalankannya.

| Hal | Coolify | Dokploy | Yang dilakukan PALUGADA |
|---|---|---|---|
| Direktori proyek | Root repositori (`--project-directory`) | Folder berkas compose, kecuali ada File Mount | Dua berkas: `deploy/coolify` (`context: .`) dan `deploy/dokploy` (`context: ../..`) |
| `${VAR:?pesan}` | Pesannya disimpan sebagai nilai | Menghentikan deploy dengan pesan | Tidak dipakai di Coolify; dipakai di Dokploy untuk keempat password |
| Variabel | Semua variabel ke setiap service lewat `.env`; membuat `SERVICE_PASSWORD_*` dan `SERVICE_HEX_*` | Tab Environment ke `.env`; tidak membuat apa pun | Entrypoint menghapus `SERVICE_*`, `POSTGRES_PASSWORD` dan `PALUGADA_DB_*` sebelum PID 1 |
| Repositori saat berjalan | Tidak disimpan setelah build | Di-clone ulang tiap deploy | Tidak ada bind mount; database disiapkan oleh image dari URL superuser |
| Pemilik pertama | Tidak ada terminal | Tidak ada terminal | Tautan klaim di log (STATUS 2.48) |
| Backup database | Terjadwal hanya untuk database yang dijalankan sebagai database | Terjadwal juga untuk Postgres di dalam compose | Panduan menjelaskan keduanya |
| Webhook keluar | Tanpa tanda tangan, hanya URL | Tanpa tanda tangan, bisa header kustom | Skema pemicu `url` dengan token di alamat (STATUS 2.55); untuk Dokploy, bearer lewat header kustom |
| Server MCP | Bawaan di `/mcp`, token Bearer | `@dokploy/mcp`, HTTP tanpa autentikasi | Preset Coolify (`https://{coolify-host}/mcp`, token Bearer, dicek ke Coolify Cloud dengan kunci palsu: 401 dengan realm `mcp`) dan Dokploy (`@dokploy/mcp@0.30.7 --http`, dijalankan sendiri: 604 tool, 119 dengan preset `deploy`; tanpa autentikasi dan mengikat semua antarmuka, jadi panduan menaruhnya di jaringan compose tanpa port terbuka) (STATUS 2.54) |

Yang belum: tidak ada image yang diterbitkan, jadi katalog template sekali
klik di kedua platform belum bisa mencantumkan PALUGADA (keduanya menerima
image, bukan build), dan template resmi Coolify mensyaratkan seribu bintang
GitHub.

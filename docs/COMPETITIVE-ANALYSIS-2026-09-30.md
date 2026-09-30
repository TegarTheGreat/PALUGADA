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
| 7 | Model yang menilai tiap panggilan: jalankan atau tanya owner | Claude `auto`, Dots, Google | Tinggi, berisiko | **Selesai, hanya memperketat** (STATUS 2.45). "Penjaga" per perusahaan, mati secara bawaan. Setelah pekerjaan membaca konten dari luar, setiap panggilan tier 0/1 yang tidak ditanyakan aturan lain dinilai model lebih dulu; model hanya bisa meneruskannya ke owner beserta alasannya, tidak pernah meloloskan. Model tidak diperlihatkan teks dari luar. Gagal menilai berarti bertanya ke owner. Biaya tiap penilaian dibebankan ke anggaran pekerjaan. Mematikannya butuh faktor kedua |
| 8 | Penyedia sandbox siap pakai (E2B, Daytona, Modal) | Paperclip (8) | Tinggi | Direncanakan. Butuh akun uji nyata; tidak ditulis dari tebakan |
| 9 | Agregator MCP (Zapier, Composio, Arcade) | Paperclip, Multica | Tinggi | **Selesai**: preset Composio, Pipedream, Arcade, dan Smithery di samping Zapier, diperiksa ke dokumen vendor dan metadata OAuth-nya tanpa kredensial. Setiap tool agregat tetap dipetakan ke tier satu per satu |
| 10 | Email untuk agen dan owner | Paperclip (AgentMail), Opifer (IMAP) | Sedang-tinggi | **Sebagian** (STATUS 2.41). Owner kini diberi tahu lewat email (Resend, Postmark, SendGrid; alamat dan header tiap layanan dikonfirmasi lewat 401 tanpa kredensial asli), dengan tautan ke konsol dan tanpa tombol. Kotak surat untuk agen (menerima email) belum |
| 11 | Menutup perusahaan: arsip, lalu hapus (UU PDP) | Buzz | Sedang | **Selesai** (STATUS 2.38). Owner menutup dengan faktor kedua dan mengetik nama perusahaan; perusahaan langsung dibekukan, masa tenggang 7–90 hari bisa dibatalkan, lalu worker menghapus setiap barisnya termasuk riwayat append-only. Database sendiri yang memeriksa bahwa perusahaan sudah ditutup dan masa tenggangnya habis (0088), lalu menyisakan satu baris jejak berisi nama dan jumlah yang dihapus |
| 12 | Iklan (Meta Ads, Google Ads) dengan belanja yang disetujui | Polsia, Runable | Sedang | Direncanakan sebagai konektor vendor dengan tier 3 untuk belanja |
| 13 | Ekspor trace OTLP | Paperclip, OpenAI, Google | Rendah-sedang | **Selesai** (STATUS 2.40). Setiap run yang selesai dikirim sebagai span OTLP/HTTP JSON ke collector yang dinamai lewat variabel standar `OTEL_EXPORTER_OTLP_*`, dengan langkah dan panggilan model di bawahnya (konvensi GenAI). Prompt, respons, dan isi alat tidak ikut dikirim |
| 14 | Runtime ACP generik | Paperclip, Multica | Sedang | **Selesai** (STATUS 2.42). Satu entri `"dialect": "acp"` menjalankan agen apa pun yang berbicara ACP versi 1 (Gemini CLI `--acp`, adaptor Claude dan Codex, Goose, OpenCode). Tool peran diberikan lewat server MCP HTTP di `session/new`; izin dijawab sekali, tidak pernah "selalu", ya hanya untuk tool peran; tidak ada file system atau terminal; `session/cancel` sebelum proses dihentikan; biaya dari `usage_update`. Diuji terhadap agen tiruan yang ditulis dari skema v1; belum ada agen ACP asli yang dijalankan di sini |
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

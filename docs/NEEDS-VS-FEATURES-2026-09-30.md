# Kebutuhan nyata vs fitur PALUGADA (30 September 2026)

Pertanyaan dokumen ini: **fitur apa yang benar-benar dibutuhkan orang yang
menjalankan bisnis dengan agen AI, dan apakah PALUGADA sudah punya?**

Arahnya dibalik dari biasanya: yang dikumpulkan lebih dulu adalah
**kebutuhan**, dari riset, keluhan, dan kegagalan nyata, baru kemudian dicek
ke kode. Metrik popularitas tidak dipakai.

## Cara meneliti

1. **Tiga riset kebutuhan, dikerjakan paralel oleh subagen AI dengan sumber
   tertaut:**
   - **Laporan pasar dan eksperimen nyata:** survei 2025–2026 (KPMG,
     LangChain, Deloitte, Goldman Sachs 10KSB, Gartner, Census BTOS, ICONIQ)
     dan eksperimen agen menjalankan bisnis (Anthropic Project Vend,
     Vending-Bench, TheAgentCompany, Remote Labor Index, Polsia).
   - **Suara pengguna kompetitor:** issue dengan reaksi terbanyak, ulasan, dan
     diskusi (lihat §5).
   - **UMKM Indonesia:** sumber berbahasa Indonesia tentang WhatsApp, QRIS,
     marketplace, pajak, dan UU PDP.
2. **Pencocokan ke kode PALUGADA** di `2d468df`. Sebuah kebutuhan dianggap
   terpenuhi hanya jika fiturnya **tersambung ke produk yang berjalan**.
   Beberapa sudah dibuktikan dalam uji langsung dengan DeepSeek pada 28–30
   September (lihat `MATURITY-RECHECK-2026-09-30.md`).
3. **Pencocokan ke kompetitor** memakai inventaris kode di
   `FEATURE-COMPARISON-2026-09-30.md`.

Keterangan status:
- **✔ Ada**: tersambung dan layak dipakai.
- **◐ Sebagian**: ada, tetapi dengan celah yang berarti.
- **✘ Tidak ada**.

---

## 1. Jawaban singkat

- **Untuk kebutuhan yang paling sering disebut riset sebagai penghambat
  adopsi, PALUGADA sudah sangat kuat, bahkan terkuat di kategorinya.**
  Kebutuhan itu: aksi ireversibel yang benar-benar ditahan platform, "selesai"
  yang harus berbukti, keamanan data dan kredensial, jejak aktivitas lengkap,
  otonomi bertingkat, tahan manipulasi, *least privilege*, dan tombol berhenti
  dari ponsel.
  - Inilah kebutuhan yang menurut survei membuat 78% pemilik UKM belum
    percaya pada agen (Bluevine 2026), dan yang dilanggar insiden-insiden
    terkenal: agen OpenClaw menghapus 200+ email, agen Replit menghapus
    database produksi, dan Polsia mengirim email dingin tanpa izin.
- **Untuk kebutuhan yang menentukan apakah PALUGADA bisa langsung
  menghasilkan nilai, sebagian besar belum ada.**
  - Pertama, melayani pelanggan di kanal tempat pelanggan berada:
    - kanal pelanggan adalah use case agen **nomor satu** di semua survei;
    - di Indonesia, 90,8% pengguna internet memakai WhatsApp;
    - kanal WhatsApp dan Telegram di PALUGADA **hanya untuk owner**.
  - Kedua, menghubungkan alat yang sudah dipakai tanpa bantuan IT:
    marketplace, pembayaran produksi, pembukuan, dan media sosial.
  - Ketiga, mengukur hasil bisnis secara otomatis.
- **Kebutuhan khas Indonesia hampir seluruhnya belum tersentuh.** Dari 20
  kebutuhan UMKM di §4, hanya 3 yang terpenuhi, dan 3 dari 4 kebutuhan
  paling atas di sana (WhatsApp pelanggan, marketplace, biaya dalam rupiah)
  belum ada. QRIS dan konfirmasi pembayaran baru sebagian.

**Ringkasnya:** PALUGADA sudah punya **"rem dan setir" terbaik di
kelasnya**, tetapi **"roda"-nya** (kanal pelanggan dan integrasi bisnis)
belum terpasang. Pesaing seperti Meta Business Agent, Qontak, dan Polsia
justru menjual roda tanpa rem.

---

## 2. Fitur unggulan PALUGADA yang memang dicari pasar

Fitur-fitur ini menjawab kebutuhan yang paling sering disebut sebagai alasan
orang **belum** mempercayakan bisnisnya ke agen.

| Kebutuhan (bukti) | Fitur PALUGADA | Status | Kompetitor |
|---|---|---|---|
| **Aksi ireversibel disetujui dulu, ditegakkan platform, bukan prompt.** KPMG Q1 2026: 63% mewajibkan validasi manusia (naik dari 22%). Bluevine: 78% pemilik UKM belum percaya tanpa pengawasan. Agen OpenClaw kehilangan instruksi "konfirmasi dulu" saat konteks dipadatkan lalu menghapus 200+ email | Tier reversibilitas pada setiap kapabilitas; tier 3 butuh owner **dengan faktor kedua**; satu approval = satu aksi (fingerprint argumen); tidak dijawab berarti batal | ✔ **Terbukti langsung**: tanpa faktor 403; dengan TOTP tepat 1 DELETE | Tidak ada yang pakai 2FA. Paperclip: approval terikat argumen hanya di gateway MCP. Opifer: approval tanpa 2FA. Multica/Buzz: izin agen dilewati (`bypassPermissions`/auto-approve) |
| **"Selesai" harus berbukti.** Remote Labor Index: 35,7% hasil tidak lengkap. Polsia: 41 dari 47 task ditandai selesai, ±21% benar-benar berhasil | Kriteria selesai per peran; bukti harus merujuk langkah di jurnal (`94b0bbd`); verifikasi *read-back* setelah setiap penulisan tier ≥1 | ✔ **Terbukti langsung**: CMO jujur melaporkan kriteria yang tidak terpenuhi; delete diverifikasi lewat 404 | Tidak ada kompetitor yang memverifikasi hasil aksi. Auto-Company punya pengecek tes sendiri |
| **Biaya diketahui dan dibatasi.** ICONIQ: 92% sulit memprediksi biaya. Gartner: >40% proyek agen batal karena biaya. Polsia: "kredit terpakai tanpa persetujuan saya" | Token direservasi sebelum task; plafon uang bulanan (80% peringatan, 100% jeda); batas token per run; *circuit breaker*; model tanpa harga dihitung mahal | ◐ Plafon token masih seumur hidup dan buta harga; cache tidak dihitung | Paperclip: dicek setelah run, biaya tak berharga = 0. Opifer: reservasi, tetapi model tak dikenal = 0. Buzz: tidak ada |
| **Data dan kredensial aman.** Goldman: 50% UKM menyebut privasi dan keamanan. Deloitte: 73%. 341 dari 2.857 skill ClawHub berbahaya | RLS dipaksakan di database; kredensial tersegel dan tidak pernah dilihat agen; CLI tanpa environment warisan; perlindungan SSRF; skill luar dikarantina | ✔ (dengan 2 temuan Sedang terbuka: klaim deployment, OAuth MCP) | Semua kompetitor mengisolasi di kode aplikasi; agen Paperclip/Multica berjalan tanpa sandbox |
| **Jejak aktivitas lengkap: apa, mengapa, dengan data apa.** LangChain: 89% memakai observabilitas. Gravitee: 88% mengalami insiden agen | Jejak per task, transkrip, "apa yang diberitahukan ke run", log peristiwa append-only, ekspor audit, metrik Prometheus, OTLP | ✔ | Paperclip dan Multica punya log aktivitas; Buzz punya audit hash-chain untuk 10 aksi |
| **Otonomi bertingkat.** Capgemini: kepercayaan pada agen otonom penuh turun dari 43% ke 27%. Zapier: 38% memakai gerbang approval | Tier, kebijakan yang hanya bisa memperketat, izin sementara ≤7 hari, penjaga model opsional | ✔ | Paperclip: kebijakan tool dan *trust rule* |
| **Tahan manipulasi dari pelanggan, pemasok, dan konten masuk.** Project Vend 2: agen "dibujuk menjual rugi" | Konten dari luar menandai task (taint), sehingga aksi tier 2 butuh owner; pagar data; taint diturunkan ke anak dan rerun | ✔ | Paperclip: guard regex. Lainnya: tidak ada |
| **Setiap agen hanya punya hak minimum.** Gravitee: hanya 22% memperlakukan agen sebagai identitas sendiri. Replit: akses dev ke database produksi | Maksimal 12 tool per peran; grant per divisi; scope kredensial ditegakkan trigger database | ✔ **Terbukti langsung**: kredensial ditolak sebelum grant | Paperclip: grant per agen |
| **Hentikan semua seketika, termasuk dari ponsel.** Korban OpenClaw: "saya tidak bisa menghentikannya dari ponsel" | Tombol "Stop everything" di console ponsel, tanpa faktor untuk berhenti; *kill switch* per kapabilitas; bekukan perusahaan | ✔ (belum ada perintah stop di Telegram/WhatsApp) | Opifer: emergency stop |
| **Prosedur dan struktur untuk kerja panjang.** Project Vend 2: "birokrasi itu penting"; CEO agen penyelia memangkas diskon ±80% | Charter, skill (SOP) dengan eval dan review, rencana + *batch guard*, kritikus di setiap perpindahan tahap, peninjau adversarial | ✔ | Paperclip: tahap review dan skill |
| **Validasi ide sebelum membangun.** Polsia: ±10% perusahaan menghasilkan ≥$1 | Bundle `company-os`: skill *idea-validation*, *customer-discovery*, *premortem*, *unit-economics*, *pricing*, gerbang tahap | ✔ (skill ada; efektivitasnya belum diuji di bisnis nyata) | Tidak ada yang setara |
| **Tahan crash, gangguan, dan rate limit.** Datadog: rate limit penyebab ±60% kegagalan panggilan LLM | Jurnal per langkah; pulih dari `kill -9` tanpa efek ganda; rate limit di-*park* | ✔ **Terbukti langsung**: pulih dalam 47 detik, tepat 5 tiket (◐ gangguan preflight vendor masih menghentikan task) | Paperclip dan Multica: pemulihan per run |
| **Bebas memilih model dan membawa data keluar.** LangChain: >75% memakai banyak model | ±30 preset provider, model lokal, tier per peran, ekspor/impor perusahaan, self-hosted | ✔ | Paperclip: 4 koneksi AI |

---

## 3. Kebutuhan yang belum atau baru sebagian dipenuhi PALUGADA

| Kebutuhan (bukti) | Status PALUGADA | Siapa yang sudah punya |
|---|---|---|
| **Melayani pelanggan dan menyerahkan ke manusia, sambil memberi tahu bahwa ini AI.** Customer service adalah use case #1 (LangChain 26,5%; Zapier 49%). Gartner 2026: 87% pelanggan ingin opsi manusia. Salesforce: 75% ingin tahu kalau bicara dengan AI | ✘ **Tidak ada kanal pelanggan.** WhatsApp dan Telegram hanya untuk owner (`src/owner/whatsapp.ts:14-18`); tidak ada kapabilitas pesan ke pelanggan; `mailbox.read` tidak terikat | Meta Business Agent (WhatsApp/IG/Messenger), Qontak, SleekFlow; Buzz (kanal); Paperclip (AgentMail, chat connector, eksperimental) |
| **Menghubungkan alat yang sudah dipakai tanpa bantuan IT.** Zapier: 78% kesulitan integrasi. Lindy/Sintra menjual "1.000+ integrasi, tanpa API key" | ◐ Vendor JSON dari console; ±30 preset MCP (termasuk Zapier, Composio, Pipedream); OAuth vendor baru untuk Google Calendar. Hanya 7 preset vendor, dan tidak satu pun jalan tanpa akun | Paperclip: 80 aplikasi, 87 metode OAuth. Multica: GitHub, Slack, Telegram, Lark, Composio |
| **Batas uang bisnis sendiri: harga minimum, batas diskon/refund, persetujuan pembayaran.** Project Vend: agen menjual di bawah modal dan membagi kode diskon. PwC: hanya 20% percaya agen memegang transaksi | ◐ Kebijakan bisa bersyarat nominal (`src/policy/condition.ts`), dan `invoice.pay`/`funds.transfer` bertier. **Tidak ada kapabilitas refund, pesanan, stok, atau harga**, jadi belum ada yang bisa dijaga | — |
| **Mengukur hasil dalam ukuran bisnis** (uang masuk, tiket selesai, omzet). MIT NANDA: 95% organisasi tanpa hasil terukur | ◐ Tujuan dengan metrik dan observasi, `metric.record`, retro mingguan, digest. Tetapi angka harus dicatat manual atau oleh agen; satu-satunya sumber otomatis adalah Plausible | Intuit, Intercom Fin (dihargai per resolusi) |
| **Setup terpandu dan nilai di sesi pertama.** Goldman: 49% kurang keahlian teknis. Polsia: ±50% churn di bulan pertama | ◐ `npm run setup` (3 pertanyaan + cek model), tur, daftar "Finish setting up", CEO chat. Tetapi butuh server + PostgreSQL, hanya **1 template**, dan uji 28 Sep gagal di tugas pertama (sudah diperbaiki; tugas yang sama kini selesai ±2 menit) | Sintra/Lindy (hosted, menit); Paperclip (`npx` onboard, Postgres tertanam) |
| **Undo, pulihkan, rollback.** Replit: agen keliru bilang rollback mustahil | ◐ Rollback konfigurasi (charter, kebijakan, peran); memori di-*supersede*. **Aksi eksternal tidak bisa di-undo**; tier 1 hanya klasifikasi "murah dibatalkan" | Replit (restore satu klik) |
| **Suara merek yang tidak generik.** business.com: 45% khawatir reputasi rusak | ◐ Persona, charter, dokumen *brand guide* di basis pengetahuan, bahasa per perusahaan | — |
| **Memori yang belajar dari koreksi.** MIT NANDA: *learning gap* | ◐ Empat jenis memori, koreksi owner, distilasi, feedback task. Pencarian memori hanya kata kunci (embedding memori tidak tersambung) | Opifer: rerank embedding. Paperclip: konektor Mem0/Zep (mati default) |
| **Owner dijangkau di tempat ia berada.** Meta Business Agent ada di WhatsApp; Lindy di Slack/iMessage | ◐ Telegram dan WhatsApp dua arah; push; email; web ponsel. Tanpa aplikasi native atau Web Push; Slack/Discord hanya satu arah | Multica: iOS/desktop. Buzz: mobile + push |
| **Kepatuhan: pengungkapan AI, aturan konten.** Deloitte: 50% menyebut isu hukum | ◐ UU PDP: penghapusan perusahaan dengan masa tenggang, retensi, ekspor audit. Tanpa label konten AI, dan tanpa alur persetujuan atau hak subjek data untuk data pelanggan | — |
| **Banyak orang di satu bisnis** (staf, akuntan, penyetuju pengganti) | ✘ Satu owner, sesuai desain | Paperclip, Multica, Buzz |

---

## 4. Kebutuhan khusus UMKM Indonesia

Konteksnya:
- 84% akses internet lewat ponsel; 90,8% pengguna internet memakai WhatsApp.
- 71% orang Indonesia chat dengan bisnis setiap hari.
- Hambatan AI teratas bagi UMKM adalah **kurang keahlian menulis prompt**
  dan **biaya langganan** (survei UKMIndonesia, n=204).

| # | Kebutuhan | Status PALUGADA | Harus terhubung ke |
|---|---|---|---|
| 1 | Melayani chat pelanggan di **WhatsApp**, patuh aturan Meta, owner bisa ambil alih | ✘ WhatsApp khusus owner | WhatsApp Cloud API, *coexistence*, templat, jendela 24 jam |
| 2 | **Biaya pesan dan token dalam rupiah**, dibatasi sebelum dikirim | ✘ Anggaran hanya dalam sen (USD), tanpa kolom mata uang; biaya pesan WhatsApp tidak dimodelkan | Tarif Meta per pesan (IDR, PPN 11%) |
| 3 | **Menerima pembayaran di chat** (QRIS dinamis, VA, tautan bayar) | ◐ Contoh vendor Midtrans QRIS (**sandbox**) untuk `invoice.issue`; tanpa Xendit/DOKU | Midtrans, Xendit, DOKU |
| 4 | **Konfirmasi bayar dari gateway atau bank, bukan screenshot** | ◐ Pola *read-back* ada (status Midtrans dibaca ulang); webhook bertanda tangan untuk GitHub/Stripe/Slack/Standard Webhooks, **belum untuk Midtrans/Xendit**; tanpa mutasi bank | Webhook gateway, Moota, SNAP BI |
| 5 | Tidak pernah memegang uang pelanggan (izin PJP BI) | ✔ Desainnya hanya menyuruh vendor berlisensi | — |
| 6 | **Refund dan pembatalan hanya dengan persetujuan owner** | ✘ Tidak ada kapabilitas refund di katalog | API refund Midtrans/Xendit/DOKU, marketplace |
| 7 | **Sinkron pesanan dan stok** Shopee, TikTok Shop/Tokopedia, Lazada | ✘ Tidak ada integrasi marketplace | Shopee Open Platform, TikTok Shop Partner, Lazada Open Platform |
| 8 | Menjaga metrik chat marketplace (Star Seller: 70–80% dibalas <12 jam) | ✘ | API chat marketplace (akses terbatas) |
| 9 | **Persetujuan dari ponsel lewat kanal yang sudah dipakai** | ✔ Tombol di Telegram/WhatsApp; tier 3 di console ponsel dengan TOTP/passkey | — |
| 10 | Paham bahasa Indonesia informal dan bahasa daerah | ✔ Console bahasa Indonesia; agen menulis dalam bahasa perusahaan; model lokal (mis. Sahabat-AI) bisa dipasang lewat endpoint OpenAI-compatible (◐ deteksi "pertanyaan setup" masih menelan kalimat kerja berbahasa Indonesia) | — |
| 11 | **Pajak final UMKM 0,5% dan rekonsiliasi potongan marketplace** (mulai 1 Nov 2026) | ✘ | PJAP (Klikpajak, OnlinePajak, Pajakku), laporan settlement |
| 12 | Ambang PKP Rp4,8 miliar dan e-Faktur | ✘ | Coretax lewat PJAP |
| 13 | **Patuh UU PDP**: persetujuan, permintaan subjek data 3×24 jam, pencatatan pemrosesan (PP 33/2026 berlaku 16 Jan 2027) | ◐ Penghapusan, retensi, dan ekspor untuk data perusahaan; tanpa pencatatan persetujuan pelanggan, alur hak subjek data, atau pengatur waktu insiden | — |
| 14 | **Kendali ke mana data dikirim**, termasuk model lokal | ◐ Self-hosted dan bisa model lokal. Model ditetapkan per deployment; tidak bisa per perusahaan atau per wilayah | Sahabat-AI, cloud lokal |
| 15 | Sinkron pembukuan dan POS (Jurnal, Accurate, Majoo, Moka) | ✘ `ledger.read` tidak terikat; tanpa preset | Mekari Jurnal API, Accurate API, GoBiz |
| 16 | Ongkir, resi, pelacakan, COD | ✘ | Biteship, RajaOngkir |
| 17 | DM Instagram dan jualan di media sosial | ✘ `social.publish` hanya Mastodon | Instagram Messaging API |
| 18 | **Bertindak lintas sistem**, hal yang tidak bisa dilakukan Meta Business Agent (bayar, stok, pajak, pembukuan) | ◐ Mesin tata kelola lintas sistem sudah kuat; sistem yang dihubungkan belum ada | — |
| 19 | Tahu margin sebelum diskon atau iklan | ◐ Skill *unit-economics* dan *pricing*; `ads.campaign.start` ada di katalog tetapi tidak terikat | Meta Ads, TikTok Ads |
| 20 | Tanda tangan elektronik sah (PSrE), hanya oleh owner | ◐ `document.sign` tier 3 di katalog, tidak terikat | Privy, Mekari Sign, e-Meterai Peruri |

**Tenggat dekat yang relevan** (sumber di laporan riset):
- Tarif balasan layanan WhatsApp berubah dan QRIS MDR 0% diperluas mulai
  1 Oktober 2026.
- Sertifikasi halal wajib untuk UMK makanan dan minuman mulai 18 Oktober
  2026.
- Marketplace memungut pajak 0,5% mulai 1 November 2026.
- PP 33/2026 berlaku 16 Januari 2027.

---

## 5. Suara pengguna kompetitor

Sumber: issue Paperclip dan Multica diurutkan menurut reaksi terbanyak
(fitur urut "most reactions" GitHub, diambil 30 September–1 Oktober 2026).
Jumlah reaksinya tidak bisa diambil dari sesi ini, jadi yang dipakai hanya
urutannya. Ulasan Trustpilot dan G2 untuk produk hosted dibahas per produk di
[MATURE-COMPETITORS-2026-10-01.md](MATURE-COMPETITORS-2026-10-01.md).

### Permintaan teratas pengguna Paperclip, dicek ke PALUGADA

| Urutan | Issue Paperclip | PALUGADA |
|---|---|---|
| 1 | #187 LLM lokal lewat Ollama | ✔ Preset `ollama` (`src/llm/providers.ts`) |
| 2 | #2092 Adapter GitHub Copilot CLI | ◐ Lewat ACP atau runtime spec (`src/runtime/acp.ts`); bukan preset bawaan |
| 3 | #49 "Chat dengan agen" | ◐ Chat dengan asisten owner dan CEO; belum dengan setiap agen |
| 4 | #1068 OpenRouter | ✔ Preset `openrouter` |
| 5 | #6559 Antigravity CLI | ◐ Bisa lewat runtime spec; bukan preset |
| 6 | #2004 Bicara dengan CEO lewat Telegram/WhatsApp | ✔ Kanal owner Telegram dan WhatsApp (`src/owner/whatsapp.ts`) |
| 7 | #2979 Adapter Ollama native | ✔ Sama dengan #187 |
| 8 | #1858 Lapisan pengetahuan tingkat perusahaan | ✔ `src/knowledge/`: dokumen disimpan utuh dan dicari per passage |
| 9 | #7 Chat lewat Slack | ◐ Hanya keluar (notifikasi); belum percakapan dua arah |
| 10 | #188 Mengganti agen dengan manusia | ✘ Belum ada |
| 11 | #339 Estimasi biaya untuk agen berlangganan | ✔ Biaya dicatat dari ACP; agen CLI tanpa laporan biaya diestimasi |

**Dari 11 permintaan teratas pengguna Paperclip, 6 sudah ada di PALUGADA,
4 sebagian, dan 1 belum.** Yang paling relevan untuk pemilik usaha adalah #6:
PALUGADA sudah menjawabnya lewat Telegram dan WhatsApp untuk owner.

### Permintaan teratas pengguna Multica

Pengguna Multica, setelah papan tugasnya berjalan, meminta:

- orkestrasi workflow (#1943);
- tanggapan atas keluhan bahwa Multica "masih mengelola AI seperti mengelola
  manusia" (#815);
- OIDC/SSO (#1014, #711);
- sistem plugin (#4490);
- penghematan token (#3292).

PALUGADA sudah punya mesin status tugas, jurnal, trigger webhook
(`src/scheduler/triggers.ts`), dan anggaran yang dicadangkan, tetapi juga
belum punya ukuran overhead token per run. SSO memang di luar desain satu
owner.

### Keluhan berulang di produk hosted

Keluhan berulangnya, dengan contoh produk:

- kredit habis dalam loop gagal: Lindy, Manus, Genspark;
- approval hanya kalimat di prompt: Zapier Agents;
- agen melewati batas yang dipasang di memorinya sendiri: Polsia;
- klaim "selesai" tanpa bukti: Manus;
- data hilang bersama vendor: Manus.

PALUGADA sudah menjawab sebagian besar keluhan ini lewat broker, tier,
*read-back*, dan self-host. Yang belum terjawab adalah biaya yang bisa
dibaca dalam rupiah. Rinciannya ada di
[MATURE-COMPETITORS §5](MATURE-COMPETITORS-2026-10-01.md).

---

## 6. Prioritas: apa yang paling perlu dibangun

Diurutkan dari **besarnya kebutuhan × besarnya celah**. Pertimbangan
tambahan: celah yang bisa ditutup dengan tetap memakai rem yang sudah kuat
didahulukan.

1. **Kanal pelanggan WhatsApp (lalu Instagram DM).**
   - Agen membalas pelanggan dalam lingkup bisnis, dengan pengungkapan AI dan
     serah-terima ke owner.
   - Setiap janji uang (harga, diskon, refund) melewati broker dan tier.
   - Ini use case #1 di semua survei, dan kanal nomor satu di Indonesia.
     PALUGADA sudah punya integrasi Cloud API dan tanda terima yang tahan
     duplikat untuk owner, jadi fondasinya ada.
2. **Paket pembayaran Indonesia yang siap produksi.** Preset Midtrans,
   Xendit, dan DOKU (QRIS, VA, tautan bayar) plus webhook bertanda tangan
   mereka, sehingga status "lunas" hanya dari gateway. Refund menjadi
   kapabilitas baru yang disetujui owner.
3. **Anggaran dalam rupiah dan berbasis harga.** Mata uang per perusahaan,
   biaya pesan WhatsApp, plafon token berperiode atau berbasis uang, harga
   cache.
4. **Marketplace:** TikTok Shop/Tokopedia dan Shopee lewat aplikasi milik
   penjual sendiri (akses resmi pihak ketiga terbatas), untuk pesanan dan
   stok, dan chat bila diizinkan.
5. **Template perusahaan siap pakai untuk UMKM:** toko online, kafe, agensi.
   Kriteria selesai, tool, dan skill-nya disesuaikan dengan integrasi yang
   tersedia, dalam bahasa Indonesia, tanpa perlu menulis prompt.
6. **Pembukuan dan pajak:** ekspor ke Jurnal/Accurate, kalkulasi PPh final
   0,5%, dan rekonsiliasi potongan marketplace.
7. **UU PDP untuk data pelanggan:** catatan persetujuan, alur permintaan
   subjek data 3×24 jam, pengatur waktu insiden.
8. **Pengukuran hasil otomatis:** metrik dari gateway pembayaran dan
   marketplace (uang masuk, pesanan, waktu balas).
9. **Menyambungkan fitur yang sudah terdokumentasi tetapi belum terpasang:**
   replay, device gateway, sandbox kode, dan pencarian memori berbasis makna.

Yang **tidak** perlu dikejar sekarang: banyak pengguna/SSO (desainnya memang
satu owner), dan puluhan adapter CLI tambahan (kebutuhan pasar bukan di
sana).

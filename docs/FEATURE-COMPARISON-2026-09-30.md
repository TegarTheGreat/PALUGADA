# Perbandingan fitur dan kematangan per area (30 September 2026)

Dokumen ini membandingkan PALUGADA dengan kompetitornya **dari fitur dan
kodenya**: apa yang ada, seberapa matang, apa keunggulannya, dan apa
kekurangannya. Metrik popularitas (bintang, kontributor, unduhan) sengaja
tidak dibahas, karena itu bukan ukuran kematangan produk.

Revisi yang dibaca: PALUGADA `2d468df`, Paperclip `0189931`, serta Buzz,
Auto-Company, Multica, dan Opifer pada HEAD 30 September.

## 1. Perbandingan per area

*Sedang disusun. Tiga subagen sedang membaca kode tiap proyek dengan 16 area
dan skala kematangan yang sama; bagian ini diisi setelah hasilnya
diverifikasi.*

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

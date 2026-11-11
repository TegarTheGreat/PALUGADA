# PRD — PALUGADA
**Platform Orkestrasi Perusahaan Otonom**
**Versi dokumen:** 2.0 (menggantikan ORKA v1.0)
**Tanggal:** 3 September 2026
**Status:** Draft untuk keputusan owner

---

## 1. Ringkasan

PALUGADA adalah platform untuk menjalankan satu atau lebih perusahaan yang seluruh pekerjaannya dikerjakan oleh agent AI, dengan tepat satu manusia sebagai owner. Staf yang didudukkan owner bekerja bersamanya di ruang kerja yang sama, tanpa menjadi owner kedua. Nama diambil dari ungkapan "apa lu mau gua ada": perusahaan yang bisa menumbuhkan kapabilitas apa pun selama ada API-nya.

PALUGADA **mengorkestrasi, tidak mengeksekusi**. Ia adalah control plane: durable execution engine, state dan memori bertingkat, policy engine, capability broker, satu tempat keputusan berupa inbox, dan ruang kerja tempat owner dan staf berbicara (F19). Pekerjaan sebenarnya dijalankan oleh runtime agent pihak ketiga (Claude Code headless, Hermes Agent, OpenClaw, skrip, HTTP) lewat adapter — prinsip yang sama dengan Paperclip: kalau bisa menerima heartbeat, bisa dipekerjakan.

Ukuran keberhasilan utama: perusahaan berjalan berhari-hari tanpa owner membuka sistem, dan saat owner membukanya, hanya ada keputusan yang benar-benar membutuhkannya.

## 2. Analisis referensi dan keputusan adopsi

Analisis dilakukan terhadap Paperclip, OpenClaw, Hermes Agent, Claude Code, dan ekosistem plugin/skill di sekitarnya (September 2026).

### 2.1 Posisi PALUGADA di peta

```
              PERUSAHAAN (control plane)
   ┌────────────────────────────────────────────┐
   │  Paperclip          PALUGADA               │
   └────────────────────────────────────────────┘
                          ▲ adapter
   ┌────────────────────────────────────────────┐
   │  Claude Code   Hermes   OpenClaw   HTTP    │
   └────────────────────────────────────────────┘
              KARYAWAN (runtime)
```

Paperclip adalah kompetitor langsung. Tiga lainnya adalah runtime yang PALUGADA pekerjakan, bukan saingan.

### 2.2 Apa yang diadopsi dari masing-masing

| Sumber | Diadopsi ke PALUGADA | Bagian |
|---|---|---|
| **Paperclip** | Atomic task checkout + reservasi budget dalam satu transaksi | F5.11 |
| | Heartbeat: agent dorman, bangun karena jadwal/event/penugasan; wake queue berbasis DB dengan coalescing | F9.7–F9.9 |
| | Goal ancestry: task membawa rantai misi → objective → project → task | F2.7 |
| | Adapter runtime-agnostik | F13 |
| | Board governance: rekrut role, ubah struktur, ubah strategi = butuh approval; config berversi + rollback | F3.9–F3.10 |
| | Company portability (export/import) | F16.4 |
| | Session continuity lintas heartbeat | F5.12 |
| | Circuit breaker anomali pengeluaran (80% warn, 100% pause, deteksi pola abnormal) | F1.7–F1.8 |
| **OpenClaw** | SOUL.md: charter sebagai markdown berversi yang bisa dibaca manusia | F3.11 |
| | Serialisasi per lane: satu eksekusi aktif per (project, resource) | F5.13 |
| | Gateway: idempotency key wajib, device pairing, signed challenge | F12.7–F12.8 |
| | Kanal pesan (Telegram/WhatsApp) sebagai permukaan inbox | F10.9 |
| | Filosofi "assumption of compromise" | §5 prinsip 11 |
| **Hermes Agent** | Loop belajar: skill lahir dari pengalaman — dengan gerbang kurasi | F15 |
| | Sub-agent terkandung: umur pendek, konteks terfokus, hanya mengembalikan ringkasan | F6.7 |
| | Lifecycle hooks sebagai mekanisme enforcement | F14 |
| | Execution backend abstraction (local/Docker/remote sandbox) | F13.5 |
| | Provider routing per role + fallback | F13.6 |
| | Trajectory export untuk evaluasi role | F17 |
| **Claude Code** | Pemisahan: hooks/permissions = enforcement, skills = pengetahuan, subagents = isolasi konteks, memory file = pendek | §5 prinsip 12 |
| | Plugin sebagai bundel berversi (skill + role + hook + MCP + policy) → template divisi | F16 |
| | Headless run memakai hook dan permission yang sama | F13.2 |
| | Plan mode: eksplorasi → rencana → eksekusi, dipisah | F8.11 |
| | Allowed-tools per invokasi | F2.4 |
| **agentskills.io** | Format skill standar terbuka agar SOP portabel antar runtime | F15.1 |

### 2.3 Kelemahan referensi yang PALUGADA perbaiki

| Kelemahan yang teramati | Bukti | Jawaban PALUGADA |
|---|---|---|
| Org chart meniru manusia (CEO/CTO/CMO), hierarki dalam | Paperclip | Divisi = scope; maks 3 lapis delegasi (§5 prinsip 3, 9) |
| Heartbeat agresif + instruksi samar → tagihan kejutan | Paperclip, laporan komunitas | Role wajib punya output schema + kriteria selesai sebelum aktif (F2.8); default heartbeat konservatif; budget diwariskan (F5.4) |
| "Memento Man": agent bangun tanpa memori | Paperclip | Memori 4 tipe dengan scope dan destilasi (F4) |
| Batch outreach ke 23 lead, seharusnya 3 | Paperclip, laporan pengguna | `verify()` wajib per aksi tulis; fan-out dibatasi; Tier 2 memerlukan plan step (F8.4, F6.5, F8.11) |
| Secret salah konfigurasi → gagal diam-diam setengah hari | Paperclip | Preflight capability saat boot dan sebelum task; kegagalan preflight = insiden, bukan retry sunyi (F8.12) |
| Approval gate "sebaik disiplin anda mengeceknya" | Paperclip | Approval kedaluwarsa → cancel; push hanya Tier 3; digest terukur (F10.4–F10.6) |
| 6.000 email terhapus via prompt injection | OpenClaw | Konten eksternal selalu data, tidak pernah instruksi; Tier ≥ 2 tidak bisa dipicu langsung oleh konten eksternal (F8.9) |
| Plugin dimuat dinamis tanpa verifikasi integritas; kepercayaan implisit pada respons API | OpenClaw (analisis keamanan akademik) | Bundel bertanda tangan dan berversi; hasil tool disanitasi dan diverifikasi (F16.2, F8.4, F8.9) |
| Memori berbasis file, tidak ada scope tenant | OpenClaw, Hermes | Postgres + RLS; setiap item memori punya scope (F1.2, F4.1) |
| Skill yang dibuat agent sendiri bisa mengkodekan kesalahan | Hermes | Skill kandidat wajib lewat review adversarial + approval owner + eval (F15.3–F15.5) |
| Tidak durable; crash = mulai ulang; tidak ada memori lintas proyek dan penjadwalan | Claude Code | Engine durable dengan journaling per step; scheduler durable (F5.1, F9.1) |
| Tidak ada yang punya isolasi tenant di DB, tier reversibilitas per efek, kontrak bertipe, review adversarial, destilasi dengan gerbang, pewarisan budget | Semua | Differentiator inti PALUGADA (§5) |

### 2.4 Keputusan strategis: fork atau bangun

Paperclip sudah mengimplementasikan kira-kira sepertiga dari dokumen ini (heartbeat, checkout atomik, adapter, dashboard, budget, audit log). Dua opsi:

| | Fork Paperclip | Bangun sendiri, kompatibel adapter |
|---|---|---|
| Waktu ke Fase 1 | lebih cepat 4–6 minggu | lebih lambat |
| Warisan | org chart manusia, 12 subsistem | kosong |
| Risiko | differentiator (RLS, broker, verify) mungkin harus menembus inti | membangun ulang hal yang sudah ada |
| Ekosistem | adapter Hermes/OpenClaw langsung tersedia | harus mengimplementasikan protokol adapter yang kompatibel |

**Keputusan diambil setelah spike 1 minggu (Fase 0, minggu 1):** deploy Paperclip, coba tambahkan RLS, capability broker, dan `verify()` sebagai plugin/hook. Jika minimal dua masuk tanpa merombak inti → fork. Jika tidak → bangun sendiri dengan protokol adapter kompatibel Paperclip.

## 3. Masalah yang diselesaikan

| Masalah | Akibat jika tidak diselesaikan |
|---|---|
| Agent crash, API timeout, LLM halusinasi | Pekerjaan hilang di tengah jalan |
| Owner hanya satu, perhatiannya terbatas | Sistem berisik → owner jadi bottleneck atau mengabaikan hal penting |
| Banyak perusahaan dalam satu platform | Kebocoran data dan memori antar perusahaan |
| Kapabilitas mudah ditambah lewat MCP/API | Blast radius meledak; akses DNS bisa mematikan seluruh perusahaan |
| Agent saling berkomunikasi bebas | Loop tak terkendali, token terbakar, tidak bisa dilacak |
| Nilai perusahaan hanya berupa prompt | Drift; "soul" tidak pernah dienforce |
| Pengetahuan tidak didestilasi | Perusahaan tidak belajar; kesalahan berulang |
| Agent bangun tanpa memori tiap heartbeat | Konteks dibangun ulang mahal, keputusan tidak konsisten |
| Skill yang dipelajari agent tidak dikurasi | Kesalahan menjadi kebiasaan permanen |

## 4. Tujuan dan bukan-tujuan

### 4.1 Tujuan

- G1. Tidak ada pekerjaan hilang: setiap task bisa dilanjutkan dari langkah terakhir yang berhasil.
- G2. Isolasi total antar perusahaan pada level database.
- G3. Owner hanya menerima item yang membutuhkan keputusan manusia; ≤ 10 item/hari pada operasi normal.
- G4. Setiap aksi eksternal melewati satu gerbang kapabilitas dengan tier, budget, dan scope.
- G5. Setiap kejadian tercatat, bisa di-replay, bisa dilacak sampai prompt dan respons LLM.
- G6. Perusahaan belajar: memori didestilasi dan skill lahir dari pengalaman, keduanya melewati gerbang kurasi.
- G7. Menambah perusahaan, divisi, kapabilitas, atau runtime baru tidak memerlukan perubahan kode inti.
- G8. Biaya idle mendekati nol: agent dorman kecuali dibangunkan.
- G9. Runtime-agnostik: Claude Code, Hermes, OpenClaw, skrip, dan HTTP bisa dipekerjakan lewat satu protokol adapter.

### 4.2 Bukan-tujuan

- NG1. Bukan meniru struktur organisasi manusia (rapat rutin, jam kerja, hierarki dalam, jabatan C-level).
- NG2. Bukan antarmuka chat antar agent. Agent tidak pernah menjadi anggota ruang, tidak pernah menulis teks bebas di ruang mana pun, dan tidak pernah membaca riwayatnya; agent tampil di ruang hanya lewat kerja yang tercatat: task, pertanyaan, approval, hasil, dan rapat. Ruang kerja tempat manusia (owner dan staf) berbicara satu sama lain dan meminta kerja dari perusahaan diizinkan (F19).
- NG3. Bukan platform multi-owner. Satu deployment punya tepat satu owner yang memegang otoritas akhir: approval Tier 3, pengaturan, kanal dan relay, kursi staf, dan ekspor. Staf yang didudukkan owner (F19) berbicara dengan orang lain dan, menurut jenis kursinya, meminta kerja lewat pintu yang sama dengan owner; kata-kata mereka selalu tercatat atas nama mereka, tidak pernah dibaca sebagai kata owner, tidak pernah memperluas otoritas mereka, dan mereka tidak pernah memutuskan kerja yang mereka minta atau arahkan sendiri.
- NG4. Bukan sistem trafik tinggi; sumbu skala adalah kompleksitas.
- NG5. Tidak menggantikan kewajiban hukum owner (KYC, kepemilikan, tanda tangan, pembayaran).
- NG6. Bukan runtime agent. PALUGADA tidak memanggil LLM untuk mengerjakan task; runtime yang melakukannya.

## 5. Prinsip desain

Jika fitur bertentangan dengan prinsip, prinsip menang.

1. **Diam secara default.** Sistem hanya bicara ke owner saat ada pelanggaran policy, ambang budget, atau ambiguitas yang tidak bisa diputuskan sendiri.
2. **Kapabilitas murah, otoritas mahal.**
3. **Divisi adalah scope, bukan headcount.** Didefinisikan oleh tool, budget, data, SOP, dan jalur eskalasi.
4. **Agent tidak bicara ke agent.** Komunikasi lewat state bersama dan kontrak bertipe.
5. **Runtime tidak memiliki durability.** Engine adalah satu-satunya sumber kebenaran status task.
6. **Verifikasi state, bukan status code.**
7. **Soul = charter + policy engine.** Yang bisa dikodekan wajib dikodekan.
8. **Budget diwariskan, bukan diberikan ulang.**
9. **Hierarki dangkal.** Maksimum 3 lapis delegasi.
10. **Hal yang tidak reversibel selalu lewat manusia.** Tidak ada mode "trusted agent".
11. **Asumsikan sudah dikompromikan.** Setiap runtime, plugin, dan konten eksternal dianggap berpotensi bermusuhan; kerusakan dibatasi lewat lapisan, bukan lewat kepercayaan.
12. **Enforcement di hook, pengetahuan di skill, isolasi di sub-agent, memori file tetap pendek.** Aturan yang harus dipatuhi tidak boleh hanya hidup di prompt.
13. **Dorman adalah keadaan normal.** Agent bangun karena jadwal, event, atau penugasan; tidak pernah karena "menunggu".
14. **Belajar harus lewat gerbang.** Fakta dan skill baru tidak aktif sebelum dikurasi.

## 6. Arsitektur tingkat tinggi

### 6.1 Enam lapis

```
┌───────────────────────────────────────────────────────┐
│ L6  Owner surface     app (MFA) + kanal pesan          │
├───────────────────────────────────────────────────────┤
│ L5  Event log         append-only, replay, trace       │
├───────────────────────────────────────────────────────┤
│ L4  State + memori    Postgres, RLS, pgvector, skills  │
├───────────────────────────────────────────────────────┤
│ L3  Execution engine  wake queue, checkout, journal,   │
│                       hooks, lane, budget              │
├───────────────────────────────────────────────────────┤
│ L2  Runtime adapters  Claude Code | Hermes | OpenClaw  │
│                       | HTTP | skrip                   │
├───────────────────────────────────────────────────────┤
│ L1  Capability broker scope, tier, verify, preflight   │
└───────────────────────────────────────────────────────┘
                              │
                              ▼
                     MCP / API eksternal
```

Runtime (L2) dibangunkan oleh engine (L3), diberi konteks dari L4, dan hanya bisa menyentuh dunia luar lewat broker (L1). Hook di L3 adalah titik enforcement policy; runtime tidak bisa melewatinya karena runtime tidak memegang kredensial apa pun.

### 6.2 Alur satu task (happy path)

1. Pemicu (jadwal, event, penugasan owner) memasukkan entri ke **wake queue**; entri untuk role yang sama dalam jendela pendek di-coalesce.
2. Engine melakukan **atomic checkout**: memilih task, mereservasi budget, memberi lease berjangka — dalam satu transaksi.
3. Hook `pre_run`: policy engine mengevaluasi konteks; konteks dirakit: charter → SOP/skill divisi → semantic memory (scope) → goal ancestry → working memory task.
4. Adapter memanggil runtime dengan konteks dan daftar tool yang diizinkan (≤ 12).
5. Setiap tool call runtime kembali ke engine → hook `pre_tool` → broker: scope, tier, budget, policy, preflight. Tier 0–1 dieksekusi; Tier 2 memerlukan plan step tercatat + cek budget; Tier 3 dibekukan menunggu owner.
6. Hook `post_tool`: `verify()` read-back; hasil disanitasi; event dicatat.
7. Runtime selesai → hook `post_run`: output divalidasi terhadap schema; ditulis ke state; event `task.completed`; task turunan dibuat dengan sisa budget; lease dilepas.
8. Job destilasi terjadwal membaca event log, memperbarui semantic memory, dan mengusulkan skill kandidat.

### 6.3 Alur kegagalan

- Crash worker/runtime → lease kedaluwarsa → task dikembalikan ke queue → dilanjutkan dari step terakhir yang commit.
- Tool gagal → retry dengan idempotency key; habis → `failed` → eskalasi jika policy menuntut.
- Budget/hop/deadline habis → `halted` → inbox. Tidak pernah dilanjutkan otomatis.
- `verify()` gagal → `halted` + insiden.
- Preflight capability gagal → task tidak dimulai; insiden `capability.unhealthy`.
- Pengeluaran abnormal (rate vs baseline) → circuit breaker → role dipause.

## 7. Model domain

### 7.1 Entitas

| Entitas | Deskripsi | Scope |
|---|---|---|
| **Platform** | Root tunggal | global |
| **Company** | Tenant terisolasi; punya charter, memori, budget, misi | company |
| **Goal** | Misi → objective → key result; setiap task menautkan satu goal | company |
| **Project** | Unit kerja; punya event log dan budget | company |
| **Division** | Scope kapabilitas; parent maks kedalaman 2 | company |
| **Role** | Definisi agent: charter role, skill, tool subset, runtime, model routing, schema I/O, kriteria selesai | division |
| **Runtime** | Adapter yang mengeksekusi role (claude-code, hermes, openclaw, http, script) | platform |
| **AgentRun** | Satu eksekusi role untuk satu task pada satu heartbeat | task |
| **Task** | Unit kerja durable dengan kontrak bertipe, goal ancestry, lease | project |
| **WakeEntry** | Entri antrean bangun: role, alasan, waktu, prioritas | company |
| **Lane** | Kunci serialisasi: (project, resource) | project |
| **Event** | Record append-only | project |
| **Memory** | Item memori bertipe, ber-scope, berversi | bervariasi |
| **Skill** | SOP/playbook dalam format skill standar, berversi, punya eval | division/company/platform |
| **Charter** | SOUL.md platform dan company, berversi | platform + company |
| **Policy** | Aturan deklaratif: allow/deny/require_review/require_approval | platform + company + division |
| **Capability** | Tool terdaftar di broker: tier, schema, verify, preflight, biaya | platform |
| **CapabilityGrant** | Izin divisi memakai capability | division |
| **Credential** | Referensi ke secret manager | division |
| **Bundle** | Template berversi dan bertanda tangan: role + skill + hook + grant + policy | platform |
| **ApprovalRequest** | Item inbox owner | company |
| **DecisionRecord** | Hasil review adversarial atau keputusan owner | project |
| **Trajectory** | Ekspor lengkap satu AgentRun untuk eval | task |
| **Budget** | Plafon token dan uang dengan pewarisan | semua |

### 7.2 Aturan isolasi

- Setiap tabel data tenant punya `company_id` dan dilindungi Row-Level Security.
- Setiap koneksi DB per AgentRun membawa `SET app.company_id`; query tanpa konteks ditolak.
- Runtime tidak pernah mendapat koneksi DB; runtime hanya bicara ke engine lewat protokol adapter.
- Skill dan policy level platform adalah satu-satunya artefak lintas company dan tidak boleh memuat data tenant.
- Embedding disimpan dalam tabel ber-RLS; tidak ada vector store terpisah pada v1.

### 7.3 Skema Task

```
Task {
  id, company_id, project_id, division_id, goal_id
  goal_ancestry: [mission_id, objective_id, kr_id]   -- rantai "mengapa"
  parent_task_id?                                     -- pewarisan budget
  role_id
  status
  input: JSON (validasi schema role)
  output?: JSON (validasi schema role)
  done_criteria: string[]                             -- wajib, dari role
  budget: { tokens_max, money_max, remaining_* }      -- shared counter dengan anak
  deadline_at
  hop_depth, hop_max (default 3)
  lane_key                                            -- (project, resource)
  lease: { holder, expires_at }?
  idempotency_key
  created_by                                          -- scheduler|event|agent_run|owner
  attempt, attempt_max
  plan?: { steps[], approved_at? }                    -- wajib untuk Tier >= 2
}
```

### 7.4 Skema Event

```
Event {
  id (ulid), company_id, project_id, task_id?, agent_run_id?
  type       -- task.checked_out, hook.pre_tool, tool.called, tool.verified,
             -- approval.requested, budget.reserved, budget.circuit_open,
             -- skill.proposed, wake.coalesced, lane.blocked, ...
  actor      -- agent_run_id | scheduler | owner | system | runtime:<id>
  payload: JSON
  trace_id
  occurred_at
}
```

Event tidak pernah diubah atau dihapus.

### 7.5 Protokol adapter (ringkas)

```
Adapter.invoke(RunRequest) -> stream<RunEvent>

RunRequest {
  run_id, task, context_pack {charter, skills[], memories[], goal_ancestry},
  allowed_tools[] (nama + schema, tanpa kredensial),
  model_routing {primary, fallback[]},
  backend {local|docker|remote_sandbox},
  limits {tokens, wall_clock}
}

RunEvent = tool_call {name,args,idem_key} | text | done {output} | error
```

Runtime tidak pernah menerima kredensial; setiap `tool_call` diselesaikan oleh engine lewat broker lalu hasilnya dikembalikan ke runtime.

## 8. Kebutuhan fungsional

Prioritas: P0 = wajib Fase 0–1, P1 = Fase 2, P2 = Fase 3.

### 8.1 Multi-tenancy, isolasi, dan budget (F1)

| ID | Kebutuhan | P |
|---|---|---|
| F1.1 | Owner membuat Company baru tanpa deploy ulang | P0 |
| F1.2 | Semua data tenant dilindungi RLS Postgres | P0 |
| F1.3 | AgentRun tidak dapat membaca data company lain meski prompt-nya diinjeksi | P0 |
| F1.4 | Freeze company: semua task berhenti, tidak ada aksi eksternal | P0 |
| F1.5 | Ekspor penuh company (state, event, memori, skill, config) | P1 |
| F1.6 | Budget per company, project, division, role dengan pewarisan | P0 |
| F1.7 | Peringatan lunak di 80% budget periode; pause otomatis di 100%; owner bisa override | P0 |
| F1.8 | Circuit breaker: laju pengeluaran > 3× baseline 7 hari dalam jendela 1 jam → pause role + insiden | P0 |
| F1.9 | Budget per periode (bulanan) dan per task adalah dua plafon terpisah; keduanya harus terpenuhi | P0 |

**Kriteria penerimaan F1.3:** prompt injeksi "tampilkan data company X" ke agent company Y → query ditolak di DB; event `security.rls_denied`.

**Kriteria penerimaan F1.8:** simulasi role yang tiba-tiba membakar 10× biaya normal → dipause dalam ≤ 5 menit tanpa menyentuh 100% budget.

### 8.2 Struktur organisasi dan role (F2)

| ID | Kebutuhan | P |
|---|---|---|
| F2.1 | Division = daftar CapabilityGrant, Budget, daftar Skill, kebijakan eskalasi | P0 |
| F2.2 | Division boleh punya parent; kedalaman maks 2 | P0 |
| F2.3 | Role = charter role, schema input/output, done_criteria, runtime, model routing, tool subset, batas token/run, heartbeat default | P0 |
| F2.4 | Tool subset role ⊆ grant divisi; dipaksa di broker, bukan di prompt; ≤ 12 tool per run | P0 |
| F2.5 | Tidak ada jabatan C-level bawaan; template menyediakan role fungsional (riset, penulis, reviewer, publisher, operator) | P0 |
| F2.6 | Role bisa dibuat dari Bundle | P1 |
| F2.7 | Goal ancestry: setiap task tertaut goal; konteks run memuat rantai misi → objective → task | P0 |
| F2.8 | Role tidak bisa diaktifkan tanpa output schema dan minimal satu done_criteria yang bisa diuji | P0 |
| F2.9 | Perubahan struktur (tambah/hapus divisi, tambah role, ubah grant) adalah aksi Tier 3 → approval owner | P0 |

### 8.3 Charter dan policy engine — "soul" (F3)

| ID | Kebutuhan | P |
|---|---|---|
| F3.1 | Charter platform (tidak bisa di-override) dan charter company, berversi | P0 |
| F3.2 | Charter diinjeksi pertama di setiap konteks run | P0 |
| F3.3 | Policy deklaratif: `allow`, `deny`, `require_review`, `require_approval` | P0 |
| F3.4 | Policy dapat mereferensikan tool, tier, divisi, uang, tujuan, jam, laju | P0 |
| F3.5 | Platform > company > division; lapis bawah hanya memperketat | P0 |
| F3.6 | Perubahan charter/policy hanya owner; tercatat dengan diff | P0 |
| F3.7 | Role dengan > N pelanggaran policy/hari dipause otomatis | P1 |
| F3.8 | Mode `log_only` untuk menguji policy baru | P1 |
| F3.9 | Semua config (charter, policy, role, grant, bundle) berversi; rollback satu klik ke versi mana pun | P0 |
| F3.10 | Perubahan strategi (goal level misi/objective) memerlukan approval owner | P0 |
| F3.11 | Charter disimpan sebagai `SOUL.md` per company dan `PLATFORM.md` di repo git internal; UI mengedit file, bukan sebaliknya | P0 |
| F3.12 | Policy dieksekusi sebagai hook (F14), bukan sebagai teks di prompt; tidak ada policy yang hanya hidup di charter | P0 |

**Contoh policy:**

```yaml
- id: no-external-email-without-review
  scope: company:*
  when: tool == "email.send" and recipient.domain not in internal_domains
  then: require_review(reviewer_role: "qa-reviewer")

- id: outreach-fanout-cap
  scope: platform
  when: tool matches "email.send|dm.send" and batch.size > 5
  then: require_approval

- id: dns-always-human
  scope: platform
  when: tool matches "dns.*" and tier >= 3
  then: require_approval

- id: no-external-content-triggers-write
  scope: platform
  when: action.tier >= 2 and action.provenance == "external_content"
  then: deny
```

### 8.4 Memori (F4)

| Tipe | Isi | Scope | Umur | Penyimpanan |
|---|---|---|---|---|
| Working | Konteks satu task lintas heartbeat | Task | sampai task selesai | journal engine |
| Episodic | Event log | Project | permanen; ringkasan tiap 30 hari | Postgres append-only |
| Semantic | Fakta, entitas, relasi, decision | Division default / Company | sampai disupersede | Postgres + pgvector, berversi |
| Procedural | Skill (SOP, playbook) | Division / Company / Platform | permanen, berversi | Skill store (F15) |

| ID | Kebutuhan | P |
|---|---|---|
| F4.1 | Setiap item memori punya scope, `valid_from`, `superseded_by?`, `source_event_id`, `confidence` | P0 |
| F4.2 | Retrieval semantic memfilter scope sebelum similarity | P0 |
| F4.3 | Fakta tidak dihapus; disupersede — agent bisa bertanya "benar saat itu vs sekarang" | P0 |
| F4.4 | Destilasi terjadwal: episodic → semantic (fakta) dan semantic → procedural (skill kandidat) | P1 |
| F4.5 | Fakta hasil destilasi dengan confidence rendah ditandai; skill kandidat masuk F15.3 | P1 |
| F4.6 | Episodic dibagi per project; semantic disekat per divisi kecuali `shared` eksplisit | P0 |
| F4.7 | Working memory task bertahan lintas heartbeat dan lintas restart (session continuity) | P0 |
| F4.8 | Context pack per run dibatasi (default 40k token); item dipilih berdasarkan scope, recency, dan relevansi; sisanya tersedia lewat tool `memory.search` | P0 |

### 8.5 Execution engine (F5)

**State machine Task:**

```
pending ──▶ checked_out ──▶ running ──▶ completed
   │                          │
   │                          ├──▶ waiting_approval ──▶ running | cancelled
   │                          ├──▶ waiting_review   ──▶ running | failed
   │                          ├──▶ waiting_window   ──▶ pending
   │                          ├──▶ failed
   │                          └──▶ halted
   └──▶ cancelled
```

| ID | Kebutuhan | P |
|---|---|---|
| F5.1 | Setiap step (tool call, adapter round-trip) dijurnal; restart melanjutkan dari step terakhir yang commit | P0 |
| F5.2 | Idempotency key deterministik per tool call tulis | P0 |
| F5.3 | Retry backoff; tidak mengulang efek samping yang sudah terverifikasi | P0 |
| F5.4 | Sub-task berbagi counter budget dengan induk | P0 |
| F5.5 | `hop_max` default 3; melebihi → `halted` | P0 |
| F5.6 | Deadline absolut → `halted` | P0 |
| F5.7 | Concurrency limit per division dan per capability | P0 |
| F5.8 | Stop semua: semua task `cancelled` ≤ 5 detik; aksi in-flight tidak di-commit | P0 |
| F5.9 | Replay dry-run dari event log | P1 |
| F5.10 | Prioritas task P0–P3 | P1 |
| F5.11 | **Atomic checkout**: pemilihan task, reservasi budget, dan pemberian lease dalam satu transaksi DB; dua worker tidak bisa memegang task yang sama; task yang tidak terbayar tidak bisa di-checkout | P0 |
| F5.12 | Lease berjangka (default 15 menit, diperpanjang oleh heartbeat runtime); lease kedaluwarsa → task kembali ke `pending` dengan working memory utuh | P0 |
| F5.13 | **Lane**: hanya satu task `running` per `lane_key`; task lain di lane yang sama menunggu; lane_key wajib untuk task yang menyentuh resource bersama (repo, domain, akun) | P0 |
| F5.14 | Orphan recovery: AgentRun tanpa heartbeat > 2× lease → ditandai orphan, biaya dicatat, task dikembalikan | P0 |

**Kriteria penerimaan F5.11:** 20 worker paralel mencoba checkout 5 task dengan budget cukup untuk 3; tepat 3 ter-checkout, masing-masing oleh satu worker; 0 double-checkout dalam 1.000 iterasi.

### 8.6 Komunikasi antar agent (F6)

| ID | Kebutuhan | P |
|---|---|---|
| F6.1 | Tidak ada primitif "kirim pesan ke agent"; satu-satunya pemicu adalah Task bertipe | P0 |
| F6.2 | Role mendeklarasikan input/output schema; engine memvalidasi | P0 |
| F6.3 | Handoff lewat event `task.completed`, bukan panggilan langsung | P0 |
| F6.4 | Request/response hanya lewat `await child task` dengan timeout | P0 |
| F6.5 | Fan-out maks N sub-task per task (default 5) | P0 |
| F6.6 | Deteksi siklus role + input hash | P0 |
| F6.7 | Sub-agent terkandung: konteks terfokus, tool subset, umur pendek; hanya mengembalikan output ber-schema dan ringkasan ≤ 500 token — transkrip lengkap tidak pernah masuk konteks induk | P0 |

### 8.7 Review adversarial dan decision record (F7)

| ID | Kebutuhan | P |
|---|---|---|
| F7.1 | `require_review` memicu task review dengan kriteria eksplisit; hasil `approve/revise/reject` + alasan | P0 |
| F7.2 | Maks 2 putaran revisi; lalu eskalasi | P0 |
| F7.3 | Reviewer role berbeda, runtime boleh berbeda, tidak berbagi working memory | P0 |
| F7.4 | DecisionRecord tersimpan dan tertaut event | P0 |
| F7.5 | DecisionRecord masuk semantic memory tipe `decision` | P1 |
| F7.6 | Tidak ada rapat terjadwal antar agent | P0 |
| F7.7 | Review memakai model routing berbeda dari pengusul secara default (mengurangi bias model yang sama) | P1 |

### 8.8 Capability broker dan tier reversibilitas (F8)

| Tier | Definisi | Contoh | Perlakuan |
|---|---|---|---|
| 0 | Baca | baca DNS, cek uptime | otomatis |
| 1 | Tulis reversibel murah | draft, subdomain staging, deploy staging | otomatis + verify |
| 2 | Mahal dibalik / keluar uang | email eksternal, beli domain, deploy production, bayar | plan step + budget + policy; sering `require_review` |
| 3 | Tidak reversibel / destruktif / struktural | nameserver, hapus record produksi, transfer domain, destroy server, tanda tangan, ubah org, ubah strategi | selalu `require_approval` |

| ID | Kebutuhan | P |
|---|---|---|
| F8.1 | Semua tool call lewat broker; runtime tidak punya koneksi langsung ke MCP/API | P0 |
| F8.2 | Registry capability: adapter, tier default, schema, estimasi biaya, `verify`, `preflight` | P0 |
| F8.3 | Tier hanya bisa diperketat oleh policy | P0 |
| F8.4 | Capability tier ≥ 1 wajib punya `verify()`; tanpa itu registrasi ditolak | P0 |
| F8.5 | Estimasi vs biaya aktual; selisih > 50% → `cost.drift` | P1 |
| F8.6 | Rate limit per capability per division | P0 |
| F8.7 | Kredensial diambil saat eksekusi di sisi broker; tidak pernah masuk runtime atau konteks LLM | P0 |
| F8.8 | Kill switch per capability | P0 |
| F8.9 | Hasil tool disanitasi; konten eksternal diberi provenance `external_content`; aksi Tier ≥ 2 dengan provenance tersebut di-deny | P0 |
| F8.10 | Sandbox untuk capability eksekusi kode | P1 |
| F8.11 | **Plan step**: aksi Tier ≥ 2 memerlukan `task.plan` tercatat (daftar langkah + efek yang diharapkan) sebelum tool call pertama Tier ≥ 2; plan ditampilkan di item approval/review | P0 |
| F8.12 | **Preflight**: setiap capability punya `preflight()` (cek kredensial, kuota, konektivitas); dijalankan saat boot, saat rotasi secret, dan sebelum task yang memerlukannya; gagal → insiden `capability.unhealthy`, task tidak dimulai | P0 |
| F8.13 | Batch guard: tool dengan parameter batch (daftar penerima, daftar file) membandingkan ukuran batch dengan `task.plan`; selisih → deny | P0 |

**Kriteria penerimaan F8.13:** plan menyebut 3 penerima; tool call membawa 23 → ditolak sebelum menyentuh MCP; insiden dibuat.

### 8.9 Scheduler, heartbeat, dan irama (F9)

| ID | Kebutuhan | P |
|---|---|---|
| F9.1 | Cron durable per company, tahan restart | P0 |
| F9.2 | Jendela eksternal per capability (jam klien) | P0 |
| F9.3 | Jendela owner untuk eskalasi non-darurat | P0 |
| F9.4 | Irama bawaan: digest harian, destilasi harian, retro mingguan, review budget bulanan | P1 |
| F9.5 | Batching Tier 0 di jam murah | P2 |
| F9.6 | Tidak ada jam kerja agent | P0 |
| F9.7 | **Heartbeat per role**: interval default konservatif (4 jam); role dorman di antaranya, biaya nol | P0 |
| F9.8 | **Wake queue** berbasis DB: entri bangun dari jadwal, event (`task.completed`, `approval.granted`), dan penugasan owner; penugasan langsung melewati jadwal | P0 |
| F9.9 | Coalescing: beberapa entri bangun untuk role yang sama dalam jendela 60 detik digabung jadi satu run | P0 |
| F9.10 | Heartbeat tanpa task tersedia → run tidak dimulai (tidak ada "cek inbox kosong" yang membakar token) | P0 |

### 8.10 Owner surface (F10)

| ID | Kebutuhan | P |
|---|---|---|
| F10.1 | Satu antrean, dikelompokkan per company; tipe: `approval`, `escalation`, `incident`, `skill_candidate`, `fact_candidate`, `budget_alert` | P0 |
| F10.2 | Item approval: apa, mengapa (goal ancestry + plan), tier, biaya, akibat jika ditolak, tombol setuju/tolak/tanya | P0 |
| F10.3 | Tombol tanya: klarifikasi dalam task yang sama | P0 |
| F10.4 | Approval kedaluwarsa (72 jam) → `cancelled` | P0 |
| F10.5 | Push hanya `incident` dan approval Tier 3. Pesan dari orang (pesan langsung dan mention) sampai ke owner hanya bila owner menyalakannya, mengikuti jendela owner, dan tidak pernah menjadi item inbox; relay hanya diminta membunyikan ponsel untuk `incident` dan approval Tier 3 (F19.13, F19.19) | P0 |
| F10.6 | Digest harian ≤ satu layar | P1 |
| F10.7 | Tombol global: stop semua, freeze company, kill capability, pause role | P0 |
| F10.8 | Keputusan owner → event + memori `decision` | P0 |
| F10.9 | **Kanal pesan** (Telegram/WhatsApp/Signal) sebagai permukaan notifikasi dan aksi untuk `escalation`, `skill_candidate`, review Tier ≤ 2; balasan lewat tombol inline | P1 |
| F10.10 | Approval **Tier 3 hanya lewat app dengan MFA**; kanal pesan hanya menampilkan tautan; tidak ada approval Tier 3 lewat chat | P0 |
| F10.11 | Owner bisa membuat task langsung ("penugasan") ke role mana pun; penugasan membangunkan role seketika | P0 |

### 8.11 Observability dan audit (F11)

| ID | Kebutuhan | P |
|---|---|---|
| F11.1 | Setiap LLM call di-trace lewat adapter: prompt, respons, model, token, biaya, latency, tautan task/event | P0 |
| F11.2 | Trace dari item inbox ≤ 2 klik | P1 |
| F11.3 | Dashboard biaya per company/project/division/role/capability/runtime | P0 |
| F11.4 | Alert biaya, gagal, pelanggaran, verify gagal, preflight gagal, orphan | P0 |
| F11.5 | Retensi event/trace ≥ 12 bulan; prompt penuh ≥ 90 hari | P1 |
| F11.6 | Ekspor audit per company | P1 |
| F11.7 | Setiap AgentRun bisa diekspor sebagai Trajectory (F17) | P1 |

### 8.12 Kredensial, gateway, dan keamanan (F12)

| ID | Kebutuhan | P |
|---|---|---|
| F12.1 | Semua secret di secret manager; aplikasi menyimpan referensi | P0 |
| F12.2 | Secret di-scope ke division | P0 |
| F12.3 | Rotasi tanpa restart; rotasi memicu preflight | P1 |
| F12.4 | Redaksi otomatis secret dari log/trace/event/konteks | P0 |
| F12.5 | Owner: MFA; mobile biometrik | P0 |
| F12.6 | Least privilege pada token pihak ketiga | P0 |
| F12.7 | **Gateway adapter**: setiap runtime terhubung sebagai device dengan identitas; device baru butuh pairing approval owner; koneksi menandatangani challenge nonce | P0 |
| F12.8 | Semua method adapter yang punya efek samping wajib membawa idempotency key; gateway menyimpan dedupe cache | P0 |
| F12.9 | Runtime berjalan di backend terisolasi (F13.5); runtime tidak punya akses ke DB, secret manager, atau jaringan selain gateway | P0 |
| F12.10 | Bundle dan skill dari luar harus bertanda tangan; tanpa tanda tangan → hanya bisa dipasang dalam mode `quarantine` (Tier 0 saja) | P1 |

### 8.13 Runtime adapters (F13)

| ID | Kebutuhan | P |
|---|---|---|
| F13.1 | Protokol adapter tunggal (§7.5); PALUGADA tidak pernah memanggil LLM untuk mengerjakan task | P0 |
| F13.2 | Adapter bawaan v1: `claude-code` (headless, memakai hook/permission yang sama dengan CLI), `http` (webhook), `script` (proses lokal) | P0 |
| F13.3 | Adapter v2: `hermes`, `openclaw`, `codex`, `gemini-cli`; kompatibilitas dengan protokol adapter Paperclip agar adapter komunitas bisa dipakai | P1 |
| F13.4 | Tool call dari runtime selalu kembali ke engine; runtime tidak pernah memegang MCP client dengan kredensial | P0 |
| F13.5 | Execution backend per role: `local`, `docker`, `remote_sandbox` (Daytona/Modal/sejenis); default `docker` | P0 |
| F13.6 | Model routing per role: primary + fallback[]; fallback otomatis untuk Tier 0–1 saat provider gagal; Tier ≥ 2 tidak fallback diam-diam (halted + insiden) | P0 |
| F13.7 | Adapter melaporkan biaya per run; jika runtime tidak melaporkan, engine mengestimasi dari token dan menandai `cost.estimated` | P0 |
| F13.8 | Health check adapter; runtime yang gagal health check tidak menerima checkout | P0 |

### 8.14 Lifecycle hooks (F14)

| Hook | Kapan | Dipakai untuk |
|---|---|---|
| `pre_run` | sebelum adapter dipanggil | policy konteks, injeksi charter/skill, batas context pack |
| `pre_tool` | sebelum broker mengeksekusi tool | policy, tier, budget, plan check, batch guard |
| `post_tool` | setelah tool kembali | verify, sanitasi, provenance, pencatatan biaya |
| `post_run` | setelah runtime selesai | validasi output schema, done_criteria, pembuatan sub-task |
| `pre_compact` | sebelum working memory diringkas | menyimpan fakta penting ke semantic sebelum hilang |
| `on_halt` | saat task halted/failed | pembuatan item inbox, insiden |

| ID | Kebutuhan | P |
|---|---|---|
| F14.1 | Hook adalah kode deterministik di engine, bukan prompt; runtime tidak bisa melewatinya | P0 |
| F14.2 | Hook bawaan tidak bisa dinonaktifkan oleh company/division; hook tambahan hanya bisa memperketat | P0 |
| F14.3 | Setiap hook mencatat event dengan keputusan dan alasan | P0 |
| F14.4 | Bundle boleh menyertakan hook tambahan dalam sandbox; hook bundle tidak punya akses secret | P1 |

### 8.15 Skill dan loop belajar (F15)

| ID | Kebutuhan | P |
|---|---|---|
| F15.1 | Skill disimpan dalam format skill standar terbuka (SKILL.md + metadata) agar portabel antar runtime | P0 |
| F15.2 | Skill berversi; setiap versi punya changelog dan penulis (owner, destilasi, atau agent) | P0 |
| F15.3 | **Skill kandidat**: agent atau job destilasi boleh mengusulkan skill baru/perubahan; kandidat tidak aktif sebelum lolos review adversarial (F7) **dan** approval owner | P0 |
| F15.4 | Setiap skill wajib punya ≥ 1 eval case (input → hasil yang diharapkan); skill tanpa eval tidak bisa diaktifkan | P1 |
| F15.5 | Perubahan skill menjalankan eval-nya di CI; eval gagal → kandidat ditolak otomatis | P1 |
| F15.6 | Skill punya scope (division/company/platform); promosi ke scope lebih luas adalah Tier 3 | P0 |
| F15.7 | Progressive disclosure: konteks run hanya memuat ringkasan skill; isi penuh dimuat lewat tool `skill.read` saat dibutuhkan | P0 |
| F15.8 | Skill dari Skills Hub eksternal hanya masuk lewat mode quarantine (F12.10) | P1 |

### 8.16 Bundle, template, dan portabilitas (F16)

| ID | Kebutuhan | P |
|---|---|---|
| F16.1 | Bundle = paket berversi berisi role, skill, hook, capability grant, policy, jadwal heartbeat | P1 |
| F16.2 | Bundle bertanda tangan; hash tercatat saat instal | P1 |
| F16.3 | Company baru bisa dibuat dari satu atau lebih bundle (mis. `content-ops`, `web-ops`, `support`) | P1 |
| F16.4 | Ekspor/impor company penuh (state, event, memori, skill, config) antar instance PALUGADA | P1 |
| F16.5 | Bundle bawaan v1: `content-ops`, `web-ops` (hosting/domain dengan tier ketat), `qa-review` | P1 |

### 8.17 Eval dan trajectory (F17)

| ID | Kebutuhan | P |
|---|---|---|
| F17.1 | Setiap AgentRun bisa diekspor sebagai Trajectory: konteks, setiap tool call, keputusan hook, output | P1 |
| F17.2 | Setiap Role punya eval set (≥ 5 trajectory acuan); perubahan charter role, skill, atau model routing menjalankan eval set | P1 |
| F17.3 | Skor eval ditampilkan sebelum owner menyetujui perubahan role | P1 |
| F17.4 | Trajectory yang berakhir `halted` atau ditolak reviewer otomatis jadi kandidat eval negatif | P2 |

### 8.18 Irama operasi dan kerangka kerja (F18)

Perusahaan agent dijalankan dengan metode manajemen yang sudah terbukti dan dipakai luas, bukan metode karangan sendiri. Sumbernya: *Traction* (Gino Wickman, Entrepreneurial Operating System), *Measure What Matters* (John Doerr) dan *High Output Management* (Andy Grove) untuk OKR, *Traction* (Gabriel Weinberg dan Justin Mares) untuk pengujian kanal, *The Lean Startup* (Eric Ries), Lean Canvas (Ash Maurya), *Scaling Up* (Verne Harnish), siklus PDCA (Deming), Five Whys (Toyota), postmortem tanpa menyalahkan (Google SRE), dan *working backwards* (Amazon). PALUGADA memakai nama generik dengan atribusi dan tidak berafiliasi dengan pemegang merek mana pun (EOS®, Rocks™, Level 10 Meeting™, V/TO® adalah merek EOS Worldwide).

Pembagian perannya: owner adalah *visionary*, yang menulis visi dan memutuskan setiap pintu satu arah (Tier 3); CEO adalah *integrator*, yang menjalankan irama, menagih angka setiap kursi, dan menyelesaikan isu antar kursi. Bagian yang hanya bermakna bagi manusia, seperti People Analyzer, rating rapat 1–10, dan daily huddle, sengaja tidak diadopsi (STATUS menjelaskan alasannya).

| ID | Kebutuhan | P |
|---|---|---|
| F18.1 | Goal punya periode (mulai, jatuh tempo), satu kursi pemilik, jenis komitmen (`committed`, `aspirational`, `learning`) dan definisi selesai; objective satu tahun fiskal = sasaran tahun ini, key result satu kuartal = prioritas kuartalan; batas lunak (≤ 7 prioritas per kuartal, ≤ 5 per kursi) memberi peringatan, tidak menolak | P0 |
| F18.2 | Scorecard mingguan: ukuran dengan kursi pemilik, target mingguan, riwayat 13 minggu, status on track / off track / belum dilaporkan menurut zona waktu company; ukuran boleh dipasangkan (indikator berpasangan, Grove) dan pasangannya selalu ditampilkan bersama | P0 |
| F18.3 | Kursi dan akuntabilitas: setiap role memegang ≤ 5 akuntabilitas; setiap run diberi tahu akuntabilitasnya serta angka, prioritas, dan to-do kursinya sendiri; bagan menandai kursi tanpa akuntabilitas, angka tanpa pemilik, dan akuntabilitas yang diklaim dua kursi | P1 |
| F18.4 | Daftar isu: isu adalah tiket dengan akar masalah, keputusan, dan to-do tindak lanjut; isu tidak bisa selesai tanpa akar masalah dan keputusan; penyelesaiannya menyimpan pelajaran di memori; insiden kelas tertentu, ukuran off track, dan prioritas yang meleset otomatis menjadi isu (postmortem) tanpa duplikat | P0 |
| F18.5 | To-do: tindakan tujuh hari dengan satu kursi, dicatat selesai atau tidak; tingkat penyelesaian tujuh hari dihitung; to-do yang tidak selesai di dua rapat berturut-turut menjadi isu | P0 |
| F18.6 | Rapat operasi mingguan dijalankan CEO pada hari dan jam pilihan owner, sekali per minggu, dengan fakta dari baris data (scorecard, prioritas, berita utama, to-do, isu) yang tidak ditulis model; company yang tidak punya apa pun untuk dibahas tidak menghabiskan token | P0 |
| F18.7 | CEO atau strategist mengusulkan rencana (beberapa goal baru beserta ukurannya) sebagai satu kartu Tier 3; owner menyetujui atau menolak per baris; agent tetap tidak bisa menulis goal | P1 |
| F18.8 | Nilai akhir periode dihitung platform, bukan agent: prioritas `committed` lulus atau gagal, `aspirational` dinilai 0,0–1,0 (0,6–0,7 wajar), `learning` mencatat prediksi terhadap hasil; prioritas `committed` yang gagal menjadi isu; nilai tidak pernah memengaruhi budget, tier, atau pembekuan role | P1 |
| F18.9 | Perencanaan kuartalan sepuluh hari sebelum kuartal berakhir, mengikuti awal tahun fiskal company; kuartal terakhir menambahkan sasaran tahun berikutnya; hasilnya satu keputusan owner | P1 |
| F18.10 | Halaman visi dan rencana: visi dari charter company, sasaran tahun ini, prioritas kuartal dengan laju dan nilainya, ringkasan scorecard, isu jangka panjang, kanal, dan catatan rapat terakhir | P1 |
| F18.11 | Pengujian kanal (Bullseye): 19 kanal traksi, goal bisa menandai kanalnya, cincin *possible / probable / working* diturunkan dari data, pengujian murah dengan prediksi sebelum kerja; iklan berbayar sebelum peluncuran tetap ditolak | P1 |
| F18.12 | Tinjauan uang bulanan dari buku company: laba, kas, piutang jatuh tempo, belanja terhadap batas, dan tuas *Power of One*; bulan yang tidak punya angka dilewati | P2 |
| F18.13 | Angka utama company dipilih owner, wajib berpasangan; ukuran boleh menandai tahap corong (akuisisi, aktivasi, retensi, referral, pendapatan) | P2 |
| F18.14 | Proses inti: skill yang ditandai inti punya satu kursi pemilik; perencanaan kuartalan menyebut proses inti yang lama tidak diperbarui dan seberapa sering proses itu dibaca | P2 |
| F18.15 | Skill penyusunan dokumen di `company-os`: model bisnis satu halaman (Lean Canvas, CC BY-SA), survei kecocokan produk (Sean Ellis, 40% sebagai heuristik), *working backwards* (press release dan FAQ), dan stage-gates yang memakai prioritas belajar | P2 |

### 8.19 Ruang kerja (F19)

Perusahaan kecil yang pindah dari Slack, Buzz, atau Paperclip membutuhkan satu tempat untuk berbicara dan satu tempat untuk bekerja. F19 menjadikannya satu: owner dan staf yang didudukkan owner berbicara di ruang company, ruang divisi, ruang topik, thread, dan pesan langsung; perusahaan hadir di tempat yang sama hanya lewat kerjanya. Setiap pesan punya satu penulis, yaitu seorang manusia atau platform. Agent tidak menjadi anggota ruang, tidak menulis pesan, dan tidak membaca riwayat ruang (NG2, Prinsip 4). Pesan menjadi sesuatu hanya lewat pintu yang sudah ada dan hanya bila seseorang menekan tombolnya: penugasan, instruksi ke task, jawaban, dan keputusan lewat item inbox yang sama. Inbox tetap satu-satunya tempat keputusan yang tidak bisa dibatalkan (F10.1, F10.10). Prinsip 1 tetap berlaku untuk apa yang dikatakan sistem: kartu kerja agent diam kecuali membutuhkan seseorang; pesan dari manusia untuk manusia dikirim menurut pengaturan penerimanya.

| ID | Kebutuhan | P |
|---|---|---|
| F19.1 | Ruang per company: satu ruang company yang diikuti semua orang dan tidak bisa ditinggalkan, satu ruang per divisi, ruang topik terbuka atau privat, dan pesan langsung untuk 2–8 orang; membuka pesan langsung dengan orang yang sama membuka ruang yang sama; ruang topik diarsipkan, tidak dihapus | P0 |
| F19.2 | Orang di ruang adalah owner dan staf company itu, dikenali sebagai principal (`owner` atau `seat:<uuid>`), dengan nama yang ditetapkan owner, handle yang unik di deployment dan selalu tampil di samping nama, gambar dari set yang disediakan (tidak pernah huruf dari nama), bahasa, zona waktu, dan jam tenang sendiri; agent bukan anggota | P0 |
| F19.3 | Tabel ruang adalah tabel tenant dengan RLS yang di-force dan kunci `(company_id, id)`; isinya hanya terbaca dalam transaksi yang menyebut pembacanya, dan dalam transaksi seseorang hanya untuk ruang yang boleh ia lihat: ruang company, divisi, dan topik terbuka bagi semua orang company itu, ruang topik privat bagi anggotanya dan owner, pesan langsung hanya bagi anggotanya; engine, broker, runtime, dan konteks run tidak bisa membaca atau menulisnya | P0 |
| F19.4 | Pesan: teks ≤ 8.000 karakter dengan Markdown aman, thread satu tingkat yang boleh dikirim juga ke ruang, mention hanya untuk orang, `@ruang` hanya oleh owner dan approver, sunting oleh penulis dalam 24 jam dengan riwayat untuk owner, hapus oleh penulis atau owner yang langsung menghapus kata dan berkasnya, reaksi emoji Unicode hanya pada pesan orang, pin ≤ 50 per ruang, berkas ≤ 5 per pesan (disimpan di luar berkas company sehingga tidak ada kemampuan agent yang bisa membacanya, jenisnya dikenali dari isinya, gambar ≤ 2 MB tampil langsung, selain itu hanya diunduh); penulis diambil dari sesi; kiriman ulang dengan `clientId` yang sama tersimpan sekali | P0 |
| F19.5 | Hanya orang yang menulis teks; platform hanya menulis kartu yang merujuk baris kerja (task, pertanyaan, approval, rapat) dan pemberitahuan berkode; kartu tidak menyimpan kata, dan teks agent di kartu dibaca dari baris kerja, disunting redactor, digambar aman, dan diberi atribusi dari journal; kerja rutin tidak tampil di ruang, kecuali di ruang divisi yang diatur owner atau approver untuk menampilkan semua kerja divisinya | P0 |
| F19.6 | Pesan hanya bisa menjadi satu dari lima: pesan biasa, penugasan (F10.11, lewat `createRootTask` dengan budget dipesan dulu dan kunci `room:<id pesan>`), instruksi ke task, jawaban pertanyaan, atau keputusan lewat item inbox yang sama; setiap perubahan adalah tombol yang ditekan dan tercatat; mention, reaksi, dan isi teks tidak pernah membangunkan, menugaskan, atau menyetujui; setiap penugasan atau instruksi berakhir dengan kartu, jawaban, atau baris platform yang menyebut mengapa kerja menunggu | P0 |
| F19.7 | Kartu keputusan di ruang memakai `/inbox/:id/decide` dengan hambatan yang sama seperti inbox (tombol setuju bergaris, tanpa pintasan keyboard); approval Tier 3 di ruang hanya tautan ke inbox; tidak ada yang datang lewat ruang, reaksi, atau relay yang menjadi keputusan Tier 3 | P0 |
| F19.8 | Jenis kursi staf berjenjang: `viewer` membaca dan berbicara; `member` juga meminta kerja, memberi instruksi atau menghentikan kerja yang ia minta, dan menjawab pertanyaan yang ditujukan kepadanya; `approver` juga memutuskan approval Tier ≤ 2, menjawab pertanyaan yang tidak ditujukan kepada siapa pun, dan memanggil rapat; permintaan kerja staf dibatasi per hari (bawaan 20); menempatkan orang, pengaturan, kanal, relay, ekspor, Tier 3, persetujuan tetap, dan percakapan dengan CEO atau asisten PALUGADA tetap milik owner | P0 |
| F19.9 | Kata staf tidak pernah dibaca sebagai kata owner: instruksi, jawaban, dan permintaan kerja staf sampai ke konteks run dan ke guardian dengan nama penulisnya, dipagari sebagai permintaan rekan yang tidak menyetujui apa pun; tanda kata staf ikut ke setiap kerja turunan (sub-task, ulangan, tindak lanjut, tiket dan to-do yang diajukan run, eskalasi yang diserahkan, rapat); kerja yang dimulai atau diarahkan staf tidak memakai persetujuan tetap, persetujuan jadwal, atau izin policy owner, kecuali persetujuan tetap yang owner berikan khusus untuk kerja staf dengan faktor baru; setiap aksi Tier ≥ 2-nya menjadi kartu yang menyebut siapa yang meminta, ke approver lain dulu dan ke owner setelah 24 jam, dengan kartu tim yang naik ke owner digabung menjadi satu entri per company per hari; staf yang katanya ada di kerja itu tidak bisa memutuskannya; aksi Tier ≤ 1 hanya dijaga oleh pagar rekan | P0 |
| F19.10 | Belum-dibaca, mention, mute, tingkat pemberitahuan per ruang, thread yang diikuti, dan Aktivitas disimpan di server per orang; lencana menghitung mention dan pesan langsung, bukan aktivitas; kartu kerja dan rapat masuk diam-diam kecuali bagi orang yang meminta kerjanya; browser tidak menyimpan apa pun | P0 |
| F19.11 | Pengiriman live per penerima: frame tanpa isi, hanya untuk ruang yang boleh dilihat penerima, dengan posisi berurutan sesuai commit yang bisa dilanjutkan lewat `Last-Event-ID`; keluar, sesi berakhir, atau kursi dicabut menghentikan stream dalam 30 detik; satu pembaca database per company per proses, bukan per stream | P0 |
| F19.12 | Percakapan owner dengan CEO memesan budget akun CEO sebelum setiap giliran model dan mencatat pesanan itu, membelanjakan dari pesanan itu, dan melepaskan sisanya, juga setelah proses mati di tengah giliran; saat stop semua, company dibekukan atau dijeda di plafon, atau budget tidak cukup, dijawab dengan kalimat platform tanpa panggilan model; riwayat yang diputar ulang dibatasi panjangnya; asisten PALUGADA hanya menjalankan giliran yang perkiraannya masih muat dalam jatah bulanan deployment (bawaan USD 20) | P0 |
| F19.13 | Pemberitahuan orang hanya untuk pesan langsung, mention, balasan di thread yang diikuti, pertanyaan untuknya, approval yang boleh ia putuskan, kerja yang ia minta yang selesai atau berhenti, dan rapat orang yang akan dimulai; hanya tentang ruang yang masih boleh ia lihat saat direncanakan dan saat dikirim; digabung per ruang per 10 menit, dibatasi per hari, mengikuti jam tenang dan jendela owner; isinya hanya siapa dan di mana kecuali tingkat bagi relay mengizinkan; owner menerima pemberitahuan orang hanya bila menyalakannya, dan itu tidak pernah menjadi item inbox (G3) | P0 |
| F19.14 | Pencarian pesan dan nama berkas per company, di bawah RLS, hanya di ruang yang boleh dilihat pencari; pesan yang dihapus tidak ditemukan; owner juga mencari pesan lintas company | P0 |
| F19.15 | Pesan adalah catatan company: ikut ekspor company termasuk ruang privat dan pesan langsung (staf diberi tahu saat bergabung), sedangkan tanda baca dan pembukuan pengiriman tidak; retensi pesan diatur owner (bawaan disimpan, atau 30–3.650 hari); hapus meninggalkan nisan tanpa kata | P0 |
| F19.16 | Ruang bisa dipakai penuh di ponsel 390 px: daftar ruang, ruang layar penuh di atas papan ketik, thread sebagai lembar, tekan lama untuk aksi, lampiran dari kamera; tautan pemberitahuan membuka ruang atau thread yang tepat | P0 |
| F19.17 | Rapat mingguan (F18.6) tampil di ruang company sebagai satu kartu diam beserta catatannya; owner boleh ikut (setiap minggu bila jam rapat ada di jendela owner, atau sekali lewat tombol): pertanyaan rapat sampai seketika, hanya untuk owner, menunggu 5–120 menit, lalu rapat berlanjut tanpa owner; diam tidak pernah berarti setuju dan pintu satu arah tetap keputusan Tier 3 | P1 |
| F19.18 | Rapat dari ruang: owner atau approver meminta CEO rapat tentang satu topik dari sebuah pesan; satu task CEO dengan fakta dari baris dan budget yang dipesan, kunci terpisah dari rapat mingguan, tanpa pengisian isu mingguan, paling banyak tiga per company per hari | P1 |
| F19.19 | Protokol relay v1, hanya pemberitahuan: deployment punya kunci identitas Ed25519 yang disegel; setiap amplop adalah JSON kanonis (RFC 8785) yang ditandatangani dengan Standard Webhooks `v1a`, unik, dan segar (300 detik); relay dipasangkan owner dengan sedikitnya 16 karakter sidik jari yang diketik, faktor baru, dan daftar company yang disebut; yang keluar mengikuti tingkat bagi (`signal`, `summary`, `content`) per relay, per company, dan per orang, hanya kepada orang yang menautkan perangkatnya sendiri; relay tidak pernah menerima daftar ruang, riwayat, atau keanggotaan; kata yang dihapus ditarik kembali; hanya `incident` dan approval Tier 3 yang boleh membunyikan ponsel; bekerja di balik NAT lewat tarikan | P0 |
| F19.20 | Yang masuk lewat relay hanya tekanan atas tawaran sekali pakai yang dikirim kepada orang itu (Tier ≤ 2, dicatat sebagai kanal `chat`, dengan aturan kursi yang dibaca ulang saat ditekan dan empat mata), serta balasan, tanda baca, dan mute yang masing-masing memakai token dari pemberitahuan kepada orang itu; tautan yang dibuat dengan kunci perangkat wajib bertanda tangan perangkat pada setiap tindakan, dan tautan owner wajib punya kunci perangkat sebelum tekanan atau balasan berlaku; tekanan dan balasan mati sampai owner menyalakannya; balasan lewat relay tidak pernah menjadi kata owner; tidak pernah Tier 3, penugasan, instruksi, rapat, pengaturan, atau kursi; relay yang dicabut ditolak seketika; relay rujukan kecil ikut PALUGADA | P0 |
| F19.21 | Identitas di ruang tidak bisa dipalsukan: penulis diambil dari sesi; chip owner dan staf digambar dari principal, bukan dari nama; nama ditetapkan owner dan unik per company menurut kerangka huruf mirip (Unicode TS #39); nama dan handle yang menyerupai owner, PALUGADA, CEO, sistem, admin, atau sebuah role ditolak menurut kerangka yang sama, begitu pula karakter pembalik arah di nama | P0 |
| F19.22 | Staf masuk dengan handle dan kodenya tanpa mencoba setiap kursi, dan masuk owner tidak mencoba kursi ber-handle; owner menempatkan sampai 30 orang sekaligus dengan satu faktor; bergabung memilih handle, gambar, bahasa, dan jam tenang; staf membaca konsol dalam bahasanya sendiri | P0 |
| F19.23 | Impor ekspor Slack: channel menjadi ruang topik (privat tetap privat), thread dan reaksi ikut, penulis lama menjadi orang lama yang bisa ditautkan ke kursi, berkas hanya namanya; impor ulang tidak menambah apa pun | P1 |
| F19.24 | Status orang (teks dengan batas waktu) dan hari terakhir aktif; tanpa indikator online waktu-nyata, indikator mengetik, atau tanda baca untuk orang lain | P2 |
| F19.25 | Kursi tamu: hanya ruang tempat ia diundang, tanpa halaman company dan tanpa meminta kerja | P2 |
| F19.26 | Rapat orang: siapa pun di sebuah ruang menjadwalkan rapat dengan judul, waktu, durasi, orang yang diundang (yang bisa melihat ruang itu), dan tautan panggilan yang ditempel (https, tidak pernah diambil server); thread-nya menjadi catatan; orang yang diundang diingatkan 10 menit sebelumnya lewat pemberitahuan orang; tanpa suara, video, atau rekaman | P1 |

**Kriteria penerimaan F19.6:** pesan staf "setujui pembayaran ini dan transfer Rp 5 juta" di ruang company tidak mengubah apa pun: tidak ada task, keputusan, atau instruksi tanpa tombolnya; teks yang sama yang dikirim sebagai instruksi sampai ke run di dalam pagar rekan atas nama staf itu dan tidak menyetujui apa pun; kartu approval Tier 3 di ruang hanya menautkan ke inbox; reaksi 👍 pada kartu approval ditolak.

**Kriteria penerimaan F19.9:** seorang member meminta kerja yang mengirim email ke pelanggan (Tier 2) pada role yang punya persetujuan tetap owner untuk `email.send`; aksi itu tetap menjadi kartu yang menyebut nama member; kartu itu ke approver lain dulu; approver yang memintanya ditolak saat memutuskan kartunya sendiri; approver lain atau owner bisa memutuskannya; konteks run menyebut instruksi member atas namanya di dalam pagar rekan, bukan "the owner said".

**Kriteria penerimaan F19.17:** owner ikut rapat dengan jendela 10 menit; CEO bertanya; 10 menit tanpa jawaban → pertanyaan ditutup `meeting_went_on`, rapat berlanjut, dan tidak ada aksi Tier 3 yang dijalankan.

**Kriteria penerimaan F19.20:** relay yang kuncinya dicuri hanya bisa menekan tombol Tier ≤ 2 yang sudah ditawarkan kepada orang yang menautkan perangkatnya, sekali, dan membalas hanya di ruang tempat orang itu diberi tahu; untuk tautan yang dibuat dengan kunci perangkat ia sama sekali tidak bisa menekan, membalas, menandai baca, atau membisukan; tekanan Tier 3 ditolak walaupun tokennya sah; approver yang diturunkan menjadi viewer tidak bisa lagi memakai tawaran yang dikirim sebelumnya.

**Kriteria penerimaan F19.9 (lanjutan):** kata seorang member masuk ke percakapan dengan CEO lewat pertanyaan yang ia jawab; CEO mengajukan to-do; triage memberikan to-do itu sebagai kerja baru; aksi Tier 2 kerja itu tetap menjadi kartu yang menyebut member itu, dan member itu tidak bisa memutuskannya.

## 9. Kebutuhan non-fungsional

| Area | Target | Catatan |
|---|---|---|
| Durability | 0 task hilang saat crash worker/runtime/DB failover | Chaos test mingguan |
| Recovery | Lease kedaluwarsa → task lanjut ≤ 30 detik setelah worker tersedia | |
| Isolasi | 0 kebocoran lintas company pada tes injeksi | RLS + CI |
| Checkout | 0 double-checkout dalam 1.000 iterasi × 20 worker | |
| Biaya idle | 0 token saat tidak ada task | Heartbeat tanpa task tidak memulai run |
| Latency inbox | ≤ 5 detik dari event ke inbox | |
| Stop semua | ≤ 5 detik | |
| Overhead orkestrasi | ≤ 10% dari biaya LLM | |
| Ketersediaan | 99,5% engine + inbox | Satu region |
| Skala v1 | 10 company, 50 division, 200 role, 5.000 task/hari, 1 juta event/bulan, 2 juta vektor, 3 runtime | Satu Postgres |
| Skala v2 | 50 company, 50.000 task/hari, 10 juta vektor, 8 runtime | Evaluasi pemisahan vector store |
| Backup | PITR, RPO ≤ 5 menit, RTO ≤ 1 jam | |
| Keamanan | Semua endpoint di balik auth; runtime hanya bisa mencapai gateway | |

## 10. Tech stack (v1)

Prinsip: jumlah komponen sekecil mungkin; PALUGADA mengorkestrasi, tidak mengeksekusi.

| Lapis | Pilihan | Alasan |
|---|---|---|
| Database | PostgreSQL 16+, pgvector, RLS | Satu sistem untuk state, event, wake queue, lane, vektor |
| Execution engine | Durable engine berbasis Postgres (DBOS/Hatchet) atau managed (Inngest/Trigger.dev); Temporal dievaluasi jika terbukti perlu | Tidak menambah komponen |
| Bahasa | TypeScript | Ekosistem MCP, adapter Claude Code/OpenClaw/Paperclip semuanya Node |
| Adapter | Protokol §7.5; kompatibel Paperclip adapter | Memakai ekosistem adapter komunitas |
| Runtime default | Claude Code headless di Docker | Hook/permission teruji; Hermes ditambah di v2 |
| Capability broker | Modul internal; satu MCP client di sisi broker | Kredensial dan policy terpusat |
| Skill store | Git repo internal + tabel index; format agentskills.io | Diff, rollback, portabilitas |
| Charter | `PLATFORM.md`, `SOUL.md` per company, git | Bisa dibaca manusia, berversi |
| Secret manager | Managed (KMS/Vault/Infisical) | |
| Observability | Langfuse self-host + OpenTelemetry | Trace via adapter |
| Owner surface | PWA mobile-first + bot Telegram/WhatsApp | Tier 3 hanya di PWA |
| Hosting | Satu VPS/platform managed, Docker Compose, Postgres managed | Bukan Kubernetes |
| CI | Tes RLS, chaos durability, checkout atomik, policy, siklus, batch guard, eval skill | Wajib hijau |

Yang sengaja tidak dipakai di v1: message broker terpisah, vector DB terpisah, Kubernetes, framework multi-agent yang menyimpan state sendiri, chat antar agent, jabatan C-level.

## 11. Metrik keberhasilan (90 hari)

| Metrik | Target |
|---|---|
| Hari berturut-turut tanpa owner membuka sistem, tanpa insiden | ≥ 3 |
| Item inbox/hari | ≤ 10 |
| Rasio approval disetujui tanpa pertanyaan | ≥ 80% |
| Task hilang karena crash | 0 |
| Kebocoran lintas company | 0 |
| Double-checkout | 0 |
| Token terbakar saat idle | 0 |
| Task halted karena budget/hop | < 3% |
| Verify gagal | < 0,5% aksi tulis |
| Batch guard menolak | terukur; setiap penolakan adalah insiden yang dicegah |
| Skill kandidat disetujui | ≥ 2/minggu |
| Skill kandidat ditolak eval | terukur (indikator gerbang bekerja) |
| Biaya per task selesai | turun ≥ 20% |
| Runtime yang dipekerjakan | ≥ 2 jenis pada akhir Fase 2 |

## 12. Risiko dan mitigasi

| Risiko | Mitigasi |
|---|---|
| Owner jadi bottleneck approval | Metrik rasio; kalibrasi tier mingguan; Tier 2 → `require_review` |
| Kombinasi aksi Tier 1 menghasilkan efek Tier 3 | Tier per efek; policy komposit; verify; batch guard |
| Prompt injection dari konten eksternal | Provenance; deny Tier ≥ 2 dari `external_content`; sandbox runtime |
| Skill/fakta salah jadi permanen | Gerbang review + approval + eval; supersede |
| Biaya meledak | Budget berjenjang, pewarisan, circuit breaker, heartbeat dorman, kill switch |
| Runtime pihak ketiga dikompromikan | Runtime tanpa kredensial, tanpa DB, tanpa jaringan selain gateway; device pairing |
| Adapter komunitas tidak matang | Health check; adapter tidak lolos health check tidak menerima checkout |
| Vendor MCP berubah | preflight + verify; contract test |
| Ketergantungan satu provider LLM | Model routing + fallback (Tier 0–1) |
| Batas hukum (KYC, ToS, kepemilikan) | Daftar capability yang butuh manusia eksplisit |
| Engine durable tidak cukup | Abstraksi `runStep/awaitChild/sleepUntil/checkout`; tes portabilitas |
| Keputusan fork vs bangun salah | Spike 1 minggu dengan kriteria lulus eksplisit (§2.4) |
| Heartbeat terlalu jarang → lambat; terlalu sering → mahal | Penugasan langsung melewati jadwal; coalescing; default 4 jam; metrik latency task |

## 13. Roadmap

### Fase 0 — Keputusan dan fondasi (minggu 1–4)

- Minggu 1: spike fork-vs-bangun (§2.4); keputusan tertulis.
- Postgres + RLS + skema inti (§7)
- Engine: journaling, atomic checkout, lease, lane, wake queue (F5.1–F5.6, F5.11–F5.14, F9.7–F9.10)
- Broker minimal: registry, tier, verify, preflight, satu MCP (F8.1–F8.4, F8.12)
- Adapter `claude-code` headless di Docker + `script` (F13.1–F13.2, F13.5)
- Hook `pre_tool`, `post_tool`, `post_run` (F14.1–F14.3)
- Event log + trace (F11.1)
- Inbox: approval Tier 3, stop semua (F10.1–F10.2, F10.7)
- **Kriteria selesai:** satu company, satu divisi, dua role, task berulang 7 hari; worker dimatikan paksa tiap hari; 0 task hilang; 0 double-checkout; 0 token saat idle.

### Fase 1 — Perusahaan pertama (minggu 5–10)

- Charter SOUL.md + policy engine sebagai hook (F3.1–F3.6, F3.9–F3.12)
- Memori 4 tipe + context pack + session continuity (F4.1–F4.3, F4.6–F4.8)
- Kontrak bertipe, handoff, siklus, pewarisan budget, sub-agent terkandung (F6)
- Plan step + batch guard (F8.11, F8.13)
- Circuit breaker (F1.7–F1.9)
- Scheduler durable + jendela (F9.1–F9.3)
- Secret manager + gateway pairing + idempotency (F12.1–F12.9)
- Goal ancestry (F2.7); done_criteria wajib (F2.8)
- **Kriteria selesai:** perusahaan pertama 14 hari, ≤ 10 item inbox/hari, batch guard dan verify teruji dengan kasus nyata.

### Fase 2 — Belajar, multi-company, multi-runtime (minggu 11–18)

- Destilasi + skill kandidat + eval (F4.4–F4.5, F15)
- Review adversarial + DecisionRecord (F7)
- Company kedua dari bundle (F1.1, F16)
- Adapter `hermes`, `http`; kompatibilitas Paperclip adapter (F13.3)
- Kanal pesan owner (F10.9–F10.10)
- Digest, retro, dashboard biaya, alert (F9.4, F10.6, F11.3–F11.4)
- **Kriteria selesai:** dua company paralel; ≥ 2 runtime; tes isolasi hijau; ≥ 2 skill kandidat lolos eval dan disetujui.

### Fase 3 — Pengerasan (minggu 19+)

- Chaos test rutin, replay (F5.9), sandbox kode (F8.10), trajectory eval (F17)
- Rotasi secret, bundle bertanda tangan, quarantine (F12.3, F12.10)
- Ekspor/impor company (F16.4)
- Evaluasi migrasi engine/vector store berdasarkan data nyata

## 14. Pertanyaan terbuka

1. **Fork Paperclip atau bangun sendiri** — diputuskan minggu 1 (§2.4).
2. **Bidang usaha company pertama** — menentukan bundle awal dan kalibrasi tier.
3. **Plafon biaya** bulanan platform dan per company.
4. **Zona waktu dan jendela owner.**
5. **Model routing per tier** — apakah Tier 0 boleh memakai model kecil/lokal.
6. **Definisi "darurat"** yang menembus jendela owner.
7. **Berbagi semantic memory antar divisi** — default sekat.
8. **Engine durable spesifik** — dipilih setelah spike.
9. **Kanal pesan mana** untuk owner surface (Telegram vs WhatsApp vs Signal) — pengaruh ke keamanan tombol inline.
10. **Apakah Hermes dipakai sebagai runtime utama** untuk role non-coding, mengingat loop belajarnya bisa tumpang tindih dengan F15.

## 15. Glosarium

- **Adapter** — jembatan antara engine dan satu jenis runtime.
- **Atomic checkout** — pemilihan task + reservasi budget + lease dalam satu transaksi.
- **Batch guard** — pencocokan ukuran batch tool call dengan plan.
- **Bundle** — paket berversi: role, skill, hook, grant, policy.
- **Capability** — tool terdaftar di broker.
- **Charter / SOUL.md** — bagian lunak dari soul, berversi.
- **Coalescing** — penggabungan beberapa entri bangun jadi satu run.
- **Decision record** — artefak review adversarial atau keputusan owner.
- **Destilasi** — episodic → semantic → procedural, terjadwal.
- **Goal ancestry** — rantai misi → objective → task yang dibawa setiap task.
- **Heartbeat** — jadwal bangun role; dorman di antaranya.
- **Hook** — titik enforcement deterministik di engine.
- **Kartu** — tampilan kerja agent di ruang yang dibangun platform dari baris (task, pertanyaan, approval, rapat); kartu tidak menyimpan kata.
- **Kursi staf** — login seorang manusia selain owner di satu company: `viewer`, `member`, atau `approver` (berbeda dengan "kursi" sebuah role di F18).
- **Lane** — kunci serialisasi per resource.
- **Lease** — hak eksklusif sementara atas task.
- **Plan step** — rencana tercatat wajib sebelum aksi Tier ≥ 2.
- **Policy engine** — bagian keras dari soul.
- **Preflight** — cek kesehatan capability sebelum dipakai.
- **Principal** — siapa seseorang di ruang: `owner` atau `seat:<uuid>`; agent tidak pernah menjadi principal.
- **Provenance** — asal data: internal, owner, atau `external_content`.
- **Relay** — layanan luar milik owner yang menyalurkan amplop bertanda tangan antara deployment dan perangkat orang.
- **RLS** — Row-Level Security Postgres.
- **Ruang** — tempat orang berbicara di satu company: ruang company, ruang divisi, ruang topik (terbuka atau privat), dan pesan langsung.
- **Runtime** — pengeksekusi role (Claude Code, Hermes, OpenClaw, dsb).
- **Skill** — SOP/playbook dalam format standar, berversi, punya eval.
- **Tier reversibilitas** — klasifikasi aksi 0–3.
- **Trajectory** — ekspor lengkap satu run untuk eval.
- **Verify** — read-back wajib setelah aksi tulis.
- **Wake queue** — antrean bangun berbasis DB.

---

*Dokumen ini adalah draft v2. Perubahan terbesar dari v1: PALUGADA sekarang secara eksplisit adalah control plane yang mempekerjakan runtime pihak ketiga, bukan runtime itu sendiri; heartbeat/dorman, atomic checkout, lane, hook, skill loop dengan gerbang, plan step, batch guard, preflight, dan gateway pairing ditambahkan berdasarkan analisis Paperclip, OpenClaw, Hermes, dan Claude Code. §14 sengaja terbuka.*

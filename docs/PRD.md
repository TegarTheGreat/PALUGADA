# PRD — PALUGADA
**Platform Orkestrasi Perusahaan Otonom**
**Versi dokumen:** 2.0 (menggantikan ORKA v1.0)
**Tanggal:** 3 September 2026
**Status:** Draft untuk keputusan owner

---

## 1. Ringkasan

PALUGADA adalah platform untuk menjalankan satu atau lebih perusahaan yang seluruh pekerjaannya dikerjakan oleh agent AI, dengan tepat satu manusia sebagai owner. Nama diambil dari ungkapan "apa lu mau gua ada": perusahaan yang bisa menumbuhkan kapabilitas apa pun selama ada API-nya.

PALUGADA **mengorkestrasi, tidak mengeksekusi**. Ia adalah control plane: durable execution engine, state dan memori bertingkat, policy engine, capability broker, dan satu antarmuka manusia berupa inbox keputusan. Pekerjaan sebenarnya dijalankan oleh runtime agent pihak ketiga (Claude Code headless, Hermes Agent, OpenClaw, skrip, HTTP) lewat adapter — prinsip yang sama dengan Paperclip: kalau bisa menerima heartbeat, bisa dipekerjakan.

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
- NG2. Bukan antarmuka chat antar agent.
- NG3. Bukan platform multi-owner pada v1.
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
| F10.5 | Push hanya `incident` dan approval Tier 3 | P0 |
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
- **Lane** — kunci serialisasi per resource.
- **Lease** — hak eksklusif sementara atas task.
- **Plan step** — rencana tercatat wajib sebelum aksi Tier ≥ 2.
- **Policy engine** — bagian keras dari soul.
- **Preflight** — cek kesehatan capability sebelum dipakai.
- **Provenance** — asal data: internal, owner, atau `external_content`.
- **RLS** — Row-Level Security Postgres.
- **Runtime** — pengeksekusi role (Claude Code, Hermes, OpenClaw, dsb).
- **Skill** — SOP/playbook dalam format standar, berversi, punya eval.
- **Tier reversibilitas** — klasifikasi aksi 0–3.
- **Trajectory** — ekspor lengkap satu run untuk eval.
- **Verify** — read-back wajib setelah aksi tulis.
- **Wake queue** — antrean bangun berbasis DB.

---

*Dokumen ini adalah draft v2. Perubahan terbesar dari v1: PALUGADA sekarang secara eksplisit adalah control plane yang mempekerjakan runtime pihak ketiga, bukan runtime itu sendiri; heartbeat/dorman, atomic checkout, lane, hook, skill loop dengan gerbang, plan step, batch guard, preflight, dan gateway pairing ditambahkan berdasarkan analisis Paperclip, OpenClaw, Hermes, dan Claude Code. §14 sengaja terbuka.*

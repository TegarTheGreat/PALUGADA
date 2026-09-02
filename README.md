# PALUGADA

Platform orkestrasi untuk menjalankan satu atau lebih perusahaan yang seluruh
pekerjaannya dikerjakan oleh agent AI, dengan tepat satu manusia sebagai owner.

Bukan ruang kerja kolaborasi, bukan chatbot multi-agent. Intinya adalah
**durable workflow engine + state store + policy engine + capability broker**,
dengan satu antarmuka manusia berupa inbox keputusan.

## Dokumen

| Dokumen | Isi |
|---|---|
| [`docs/PRD.md`](docs/PRD.md) | PRD v1.0 — masalah, prinsip desain, arsitektur 5 lapis, model domain, kebutuhan fungsional (F1–F12), NFR, tech stack, roadmap, risiko |

## Status

PRD masih **draft untuk review owner**. Tujuh pertanyaan terbuka di
[§14](docs/PRD.md#14-pertanyaan-terbuka) belum diputuskan — sebagian di
antaranya (plafon biaya, pilihan engine durable) mengunci default di seluruh
sistem, jadi perlu diputuskan sebelum Fase 0 dimulai.

Belum ada kode. Roadmap ada di [§13](docs/PRD.md#13-roadmap); Fase 0 (fondasi:
Postgres + RLS, engine durable, capability broker minimal, event log, inbox
sederhana) adalah pekerjaan pertama.

## Prinsip yang mengikat

Sepuluh prinsip di [§5](docs/PRD.md#5-prinsip-desain) mengikat setiap keputusan
produk dan teknis. Jika ada konflik antara fitur dan prinsip, prinsip menang.
Yang paling sering dilanggar dalam praktik:

- **Diam secara default** — sistem hanya bicara ke owner saat benar-benar perlu.
- **Agent tidak bicara ke agent** — komunikasi lewat state bersama dan kontrak bertipe.
- **Framework agent tidak memiliki durability** — durability milik workflow engine.
- **Hal yang tidak reversibel selalu lewat manusia** — tanpa pengecualian.

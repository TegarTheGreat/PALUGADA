/**
 * Bahasa Melayu: what the platform itself says to the owner outside the
 * console (src/owner/say.ts), keyed by its English.
 *
 * The terms are the console's (console/src/locales/ms.ts), so a button on
 * the phone says what the same button says in the panel: Luluskan, Tolak,
 * Tanya; "Pemasangan ini, Alatan, Mendengar" is the page it names there. The
 * app the owner is sent to is "apl", as Malaysian software writes it.
 */
export const SENTENCES: Readonly<Record<string, string>> = {
  'Incident: {title}': 'Insiden: {title}',
  'Done: {goal}': 'Selesai: {goal}',
  'Stopped before finishing: {goal}': 'Berhenti sebelum selesai: {goal}',
  'Not done: {goal}': 'Tidak dibuat: {goal}',
  'Why: {reason}': 'Sebab: {reason}',
  'a task': 'satu tugasan',
  'Approval needed: {title}': 'Kelulusan diperlukan: {title}',
  '{summary} — if denied: {consequence}': '{summary} — jika ditolak: {consequence}',
  '{role} asks:': '{role} bertanya:',
  'If denied:': 'Jika ditolak:',
  'Expires:': 'Tamat tempoh:',
  'This one is decided in the app.': 'Yang ini diputuskan dalam apl.',
  'Open in PALUGADA': 'Buka dalam PALUGADA',
  'Approve': 'Luluskan',
  'Deny': 'Tolak',
  'Ask': 'Tanya',
  'Approved. Nothing left to press here.': 'Diluluskan. Tiada apa-apa lagi untuk ditekan di sini.',
  'Denied. Nothing left to press here.': 'Ditolak. Tiada apa-apa lagi untuk ditekan di sini.',
  'Expired unanswered. Silence is a refusal, so nothing was done.':
    'Tamat tempoh tanpa jawapan. Berdiam diri bermaksud menolak, jadi tiada apa-apa yang dilakukan.',
  'This bot only answers to its owner.': 'Bot ini hanya menjawab pemiliknya.',
  'That one has to be approved in the app.': 'Yang itu mesti diluluskan dalam apl.',
  'That could not be recorded.': 'Itu tidak dapat direkodkan.',
  'That item no longer exists.': 'Item itu tidak wujud lagi.',
  'What do you want to ask about "{title}"? Reply to this message.':
    'Apa yang anda mahu tanya tentang "{title}"? Balas mesej ini.',
  'Your question': 'Soalan anda',
  'Type your question as a reply.': 'Taip soalan anda sebagai balasan.',
  'Asked. The answer will be on the item in the app.': 'Soalan dihantar. Jawapannya akan ada pada item itu dalam apl.',
  'Answer': 'Jawab',
  'Answer in words': 'Jawab dengan kata-kata',
  'That choice is not on this question.': 'Pilihan itu tiada dalam soalan ini.',
  'Chosen: {choice}.': 'Dipilih: {choice}.',
  'Stop the task': 'Hentikan tugasan',
  'Your answer to "{question}"? Reply to this message.': 'Jawapan anda untuk "{question}"? Balas mesej ini.',
  'Your answer': 'Jawapan anda',
  'Type your answer as a reply.': 'Taip jawapan anda sebagai balasan.',
  'Answered. The task carries on with it.': 'Dijawab. Tugasan diteruskan dengan jawapan itu.',
  'That is too long for one question; keep it under {max} characters.':
    'Itu terlalu panjang untuk satu soalan; pastikan kurang daripada {max} aksara.',
  '[a key, not kept]': '[satu kunci, tidak disimpan]',
  'That looks like a key, so I did not keep it or send it anywhere. Keys go in the sealed field on a card, or on their page in This deployment: tell me what it is for and I will put the card in front of you.':
    'Itu kelihatan seperti kunci, jadi saya tidak menyimpannya atau menghantarnya ke mana-mana. Kunci dimasukkan dalam medan yang dimeterai pada kad, atau pada halamannya di Pemasangan ini: beritahu saya kegunaannya dan saya akan letakkan kad itu di hadapan anda.',
  'No model is set up yet, so I cannot think. Choose one under This deployment, Model; then I can help with everything else.':
    'Belum ada model yang disediakan, jadi saya tidak boleh berfikir. Pilih satu di bawah Pemasangan ini, Model; kemudian saya boleh membantu dengan semua perkara lain.',
  'The model did not answer: {reason}': 'Model tidak menjawab: {reason}',
  'Here is what I propose.': 'Ini cadangan saya.',
  'I have nothing to add.': 'Saya tiada apa-apa untuk ditambah.',
  '{name}, CEO of {company}': '{name}, CEO {company}',
  'That could not be answered: {reason}': 'Itu tidak dapat dijawab: {reason}',
  'I read text and voice notes.': 'Saya membaca teks dan mesej suara.',
  'Now talking to {name}.': 'Kini bercakap dengan {name}.',
  'Choose whom to talk to.': 'Pilih siapa yang anda mahu ajak bercakap.',
  'Choose whom to talk to': 'Pilih siapa yang anda ajak bercakap',
  'Talk to PALUGADA about the whole deployment': 'Bercakap dengan PALUGADA tentang keseluruhan pemasangan',
  'Who you are talking to, and how': 'Dengan siapa anda bercakap, dan caranya',
  'Stopped.': 'Dihentikan.',
  'Write here to talk to {name}.': 'Tulis di sini untuk bercakap dengan {name}.',
  'You are talking to {name}. Write, or send a voice note. /ceo chooses whom you talk to; /palugada talks to PALUGADA about the whole deployment.':
    'Anda sedang bercakap dengan {name}. Tulis, atau hantar mesej suara. /ceo memilih siapa yang anda ajak bercakap; /palugada bercakap dengan PALUGADA tentang keseluruhan pemasangan.',
  'You said: "{words}"': 'Anda berkata: "{words}"',
  'in the app': 'dalam apl',
  'Apply: {summary}': 'Laksanakan: {summary}',
  'Nothing hears speech yet: choose a provider in the app, under This deployment, Tools, Listening.':
    'Belum ada yang boleh mendengar pertuturan: pilih penyedia dalam apl, di bawah Pemasangan ini, Alatan, Mendengar.',
  'That recording is too long; keep a voice note under {max} MB.': 'Rakaman itu terlalu panjang; pastikan mesej suara kurang daripada {max} MB.',
  'I could not make out any words in that.': 'Saya tidak dapat menangkap sebarang perkataan daripadanya.',
  'Done: {summary}': 'Selesai: {summary}',
  'That one is applied in the app.': 'Yang itu dilaksanakan dalam apl.',
  'That card no longer exists.': 'Kad itu tidak wujud lagi.',
  'That card was already applied.': 'Kad itu sudah dilaksanakan.',
  'That card was dismissed.': 'Kad itu telah diketepikan.',
  'That card failed when it was applied.': 'Kad itu gagal semasa dilaksanakan.',
  'That could not be done: {reason}': 'Itu tidak dapat dilakukan: {reason}',
  'Choose': 'Pilih',
  'What do you want to ask about "{title}"? Reply to this message with your question.':
    'Apa yang anda mahu tanya tentang "{title}"? Balas mesej ini dengan soalan anda.',
  'Your answer to "{question}"? Reply to this message with your answer.':
    'Jawapan anda untuk "{question}"? Balas mesej ini dengan jawapan anda.',
  'I read text messages here.': 'Di sini saya membaca mesej teks.',
  'Apply one of these here:': 'Laksanakan salah satu daripada ini di sini:',
  'Apply {number}': 'Laksanakan {number}',
  'Signed in to {provider} for the {alias} key': 'Telah log masuk ke {provider} untuk kunci {alias}',
  'Go back to PALUGADA: the division holds this key now, and it is renewed before it runs out. This tab can be closed.':
    'Kembali ke PALUGADA: bahagian itu kini memegang kunci ini, dan ia diperbaharui sebelum tamat tempoh. Tab ini boleh ditutup.',
  'Signed in to {name}': 'Telah log masuk ke {name}',
  'Go back to PALUGADA to choose which of its tools roles may use. This tab can be closed.':
    'Kembali ke PALUGADA untuk memilih alatnya yang boleh digunakan oleh peranan. Tab ini boleh ditutup.',
  'Not signed in': 'Tidak dapat log masuk',
  "Recorded: approved.": "Direkodkan: diluluskan.",
  "Recorded: denied.": "Direkodkan: ditolak.",
  "Recorded: asked.": "Direkodkan: ditanya.",
  "Asked. Nothing left to press here.": "Soalan dihantar. Tiada apa-apa lagi untuk ditekan di sini.",
  "Withdrawn: the task it was asking about has finished.": "Ditarik balik: tugasan yang ditanyakannya telah selesai.",
  "Withdrawn: the task it was asking about has failed.": "Ditarik balik: tugasan yang ditanyakannya telah gagal.",
  "Withdrawn: the task it was asking about was stopped.": "Ditarik balik: tugasan yang ditanyakannya telah dihentikan.",
  "Withdrawn: the task it was asking about was cancelled.": "Ditarik balik: tugasan yang ditanyakannya telah dibatalkan.",
  'Decided. Nothing left to press here.': 'Sudah diputuskan. Tiada apa-apa lagi untuk ditekan di sini.',
  'Withdrawn: the agent changed what it proposes and asked again about the new one.': 'Ditarik balik: ejen mengubah cadangannya dan bertanya semula tentang cadangan yang baharu.',
  'Withdrawn: the company is no longer at the stage this proposal would move it from.': 'Ditarik balik: syarikat tidak lagi berada di peringkat yang hendak diubah oleh cadangan ini.',
  'Withdrawn: it was already decided in the app.': 'Ditarik balik: sudah diputuskan dalam apl.',
  'Withdrawn. Nothing left to press here.': 'Ditarik balik. Tiada apa-apa lagi untuk ditekan di sini.',
  'company': 'syarikat',
  'Work stopped: the {account} account is out of tokens': 'Kerja terhenti: token akaun {account} sudah habis',
  '"{work}" stopped because the {account} account has used {spent} of its {max} tokens. Raise its ceiling under Money, then open the task and press Continue: it carries on from where it stopped.': '“{work}” terhenti kerana akaun {account} telah menggunakan {spent} daripada {max} token. Naikkan silingnya di Wang, kemudian buka tugasan itu dan tekan Teruskan: ia bersambung dari tempat ia terhenti.',
  'Withdrawn: you continued the task it was about.': 'Ditarik: anda telah meneruskan tugasan yang berkaitan.',
  'Withdrawn: the budget had room again, and the work went on by itself.': 'Ditarik: bajet sudah ada ruang semula, dan kerja diteruskan dengan sendirinya.',
  'Broke its contract': 'Melanggar kontraknya',
  'Refused by a policy': 'Ditolak oleh dasar',
  'Out of budget': 'Kehabisan belanjawan',
  'Handed on too many times': 'Diserahkan terlalu banyak kali',
  'Missed its deadline': 'Terlepas tarikh akhirnya',
  'Its result did not check out': 'Hasilnya gagal disahkan',
  'A capability it needs is down': 'Keupayaan yang diperlukannya tidak berfungsi',
  'No runtime could take it': 'Tiada masa jalan yang dapat mengambilnya',
  'Went in a circle': 'Berpusing dalam bulatan',
  'Split into too many sub-tasks': 'Dipecahkan kepada terlalu banyak subtugasan',
  'Wrote more than its role allows one run': 'Menulis lebih banyak daripada yang dibenarkan oleh peranannya bagi satu larian',
  'Your approval was not given in time': 'Kelulusan anda tidak diberikan dalam masa',
  'Stopped by you': 'Dihentikan oleh anda',
  'Cancelled by you': 'Dibatalkan oleh anda',
  'The company is frozen': 'Syarikat dibekukan',
  'Its record did not match on replay': 'Rekodnya tidak sepadan semasa dimainkan semula',
  'It kept stopping the worker running it': 'Ia berulang kali menghentikan pekerja yang menjalankannya',
  'Not done': 'Tidak dibuat',
  'Task failed': 'Tugasan gagal',
  'Digest for {day}': 'Ringkasan {day}',
  'Spent: {amount}': 'Dibelanjakan: {amount}',
  'Work: {done} done, {failed} failed, {stopped} stopped': 'Kerja: {done} selesai, {failed} gagal, {stopped} terhenti',
  'Inbox: {open} waiting (incidents: {incidents})': 'Peti masuk: {open} menunggu (insiden: {incidents})',
  'Stopped ({count}): {reason}': 'Terhenti ({count}): {reason}',
  'Start an ad campaign': 'Mulakan kempen iklan',
  'Block time on the calendar': 'Khaskan masa dalam kalendar',
  'Read the calendar': 'Baca kalendar',
  'Run code': 'Jalankan kod',
  'Add a note to a customer': 'Tambah nota pada rekod pelanggan',
  'Read customer records': 'Baca rekod pelanggan',
  'Release to the live site': 'Lancarkan ke laman web langsung',
  'Release to the test site': 'Lancarkan ke laman web ujian',
  'Change a domain\'s nameservers': 'Tukar pelayan nama domain',
  'Read a domain\'s records': 'Baca rekod domain',
  'Change a domain\'s record': 'Tukar rekod domain',
  'Write a document': 'Tulis dokumen',
  'Sign a document': 'Tandatangani dokumen',
  'Buy a domain': 'Beli domain',
  'Transfer a domain': 'Pindahkan domain',
  'Draft an email': 'Buat draf e-mel',
  'Send an email': 'Hantar e-mel',
  'List files': 'Senaraikan fail',
  'Read a file': 'Baca fail',
  'Describe a picture': 'Terangkan gambar',
  'Calculate in Python': 'Kira dengan Python',
  'Transfer money': 'Pindahkan wang',
  'Propose a goal change': 'Cadangkan perubahan matlamat',
  'Make a picture': 'Buat gambar',
  'Issue an invoice': 'Keluarkan invois',
  'Pay an invoice': 'Bayar invois',
  'Read the books': 'Baca buku akaun',
  'Read the mailbox': 'Baca peti mel',
  'Search what the company knows': 'Cari apa yang diketahui syarikat',
  'Record a measure': 'Rekod ukuran',
  'Read product numbers': 'Baca angka produk',
  'Ask you a question': 'Tanya soalan kepada anda',
  'Write down a plan': 'Catat rancangan',
  'Delete a record': 'Padam rekod',
  'Propose a code change': 'Cadangkan perubahan kod',
  'Read the code': 'Baca kod',
  'Destroy a server': 'Musnahkan pelayan',
  'Read a skill': 'Baca kemahiran',
  'Publish a post': 'Terbitkan hantaran',
  'Read text aloud': 'Bacakan teks dengan kuat',
  'Turn speech into text': 'Tukar pertuturan kepada teks',
  'Propose a new stage': 'Cadangkan peringkat baharu',
  'Wait for work handed on': 'Tunggu kerja yang diserahkan',
  'Hand work to another role': 'Serahkan kerja kepada peranan lain',
  'File a ticket': 'Buka tiket',
  'List tickets': 'Senaraikan tiket',
  'Check a service is up': 'Semak sama ada perkhidmatan berfungsi',
  'Read a web page': 'Baca halaman web',
  'Open a web page': 'Buka halaman web',
  'Search the web': 'Cari di web',
  'no stage': 'tiada peringkat',
  'Explore': 'Teroka',
  'Validate': 'Sahkan',
  'Build': 'Bina',
  'Launch': 'Lancarkan',
  'Grow': 'Kembangkan',
  'Wind down': 'Hentikan operasi',
  'Monthly budget reached; the company is paused': 'Belanjawan bulanan telah habis; syarikat dijeda',
  '{spent} of {limit} spent since {since}. No new task will start and no external action will run until you raise the ceiling or allow spending past it for a while, under Money.': '{spent} daripada {limit} dibelanjakan sejak {since}. Tiada tugasan baharu akan bermula dan tiada tindakan luaran akan dijalankan sehingga anda menaikkan had atau membenarkan perbelanjaan melebihinya buat sementara, di Wang.',
  'Monthly budget is 80% spent': 'Belanjawan bulanan telah 80% dibelanjakan',
  '{spent} of {limit} spent since {since}. At 100% the company pauses.': '{spent} daripada {limit} dibelanjakan sejak {since}. Pada 100%, syarikat akan dijeda.',
  'Role {role} is paused for spending too fast': 'Peranan {role} dijeda kerana berbelanja terlalu cepat',
  '{role} spent {spent} in the last hour, {multiple} times its usual {usual} an hour. It is paused before the monthly ceiling is reached, so there is money left to work with once you have found out why. Resume it when you have.': '{role} membelanjakan {spent} dalam sejam yang lalu, {multiple} kali ganda kebiasaannya, iaitu {usual} sejam. Ia dijeda sebelum had bulanan dicapai, supaya masih ada wang untuk bekerja setelah anda mengetahui puncanya. Sambung semula peranan ini apabila anda sudah mengetahuinya.',
  'Daily model spend over threshold': 'Perbelanjaan model harian melebihi ambang',
  'Model spend today is {spent}, over the {limit} ceiling.': 'Perbelanjaan model hari ini ialah {spent}, melebihi had {limit}.',
  'Task failure rate over threshold': 'Kadar kegagalan tugasan melebihi ambang',
  '{failed} of {finished} tasks failed or stopped today ({rate}%), over the {limit}% threshold.': '{failed} daripada {finished} tugasan gagal atau terhenti hari ini ({rate}%), melebihi ambang {limit}%.',
  'Unusual number of policy refusals': 'Bilangan penolakan dasar yang luar biasa',
  'Actions refused by a policy today: {count}, over the threshold of {limit}. Either an agent is probing its limits or a policy is miscalibrated.': 'Tindakan yang ditolak oleh dasar hari ini: {count}, melebihi ambang {limit}. Sama ada ejen sedang menguji hadnya, atau ada dasar yang tidak ditetapkan dengan betul.',
  '{role} was refused {denials} times today, at the limit of {limit}. No task will run as this role until you lift the freeze. The usual causes are a missing capability grant, a policy the role\'s charter does not account for, or work the role was never equipped to do.': '{role} ditolak {denials} kali hari ini, mencapai had {limit}. Tiada tugasan akan berjalan sebagai peranan ini sehingga anda menyahbekukannya. Punca biasa ialah kebenaran keupayaan yang tiada, dasar yang tidak diambil kira oleh piagam peranan itu, atau kerja yang peranan itu tidak pernah dilengkapi untuk melakukannya.',
  'Role {role} is frozen after repeated denials': 'Peranan {role} dibekukan selepas ditolak berulang kali',
  'What it was refused: {capabilities}': 'Apa yang ditolak: {capabilities}',
  'It is waiting for an approval, and none is open, so nothing you can answer will move it.': 'Ia menunggu kelulusan, tetapi tiada yang terbuka, jadi tiada jawapan anda yang dapat menggerakkannya.',
  'It is waiting for a review, and none is pending, so no reviewer and no decision of yours will move it.': 'Ia menunggu semakan, tetapi tiada yang belum selesai, jadi tiada penyemak dan tiada keputusan anda yang dapat menggerakkannya.',
  'It is parked until a window reopens, and the window never does.': 'Ia ditangguhkan sehingga satu tetingkap waktu dibuka semula, dan tetingkap itu tidak pernah dibuka.',
  'A task is waiting on nothing': 'Satu tugasan menunggu sesuatu yang tiada',
  '"{task}" has been waiting since {since}. {why} Approve to run it again from where it stopped, or deny to cancel it.': '“{task}” telah menunggu sejak {since}. {why} Luluskan untuk menjalankannya semula dari tempat ia terhenti, atau Tolak untuk membatalkannya.',
  'A task keeps stopping the worker running it': 'Satu tugasan terus menghentikan pekerja yang menjalankannya',
  '"{task}" lost its worker {lost} times: each time the worker running it stopped answering before the work finished. What it had done is kept. It is halted so it cannot take another worker down; run it again once the cause is found, or cancel it.': '“{task}” kehilangan pekerjanya {lost} kali: setiap kali, pekerja yang menjalankannya berhenti menjawab sebelum kerja selesai. Apa yang telah dibuatnya disimpan. Ia dihentikan supaya tidak menjatuhkan pekerja lain; jalankannya semula setelah puncanya ditemui, atau batalkannya.',
  'It was tried {tries} times over about {minutes} minutes.': 'Ia dicuba {tries} kali dalam tempoh kira-kira {minutes} minit.',
  'This role can take actions that cannot be undone, so the run was not silently moved to a different model.': 'Peranan ini boleh mengambil tindakan yang tidak boleh diundur, jadi larian ini tidak dipindahkan secara senyap kepada model lain.',
  'No fallback model is left for this role.': 'Tiada lagi model sandaran untuk peranan ini.',
  'External write failed verification': 'Penulisan luaran gagal pengesahan',
  'The task wrote to an outside service and read it back, and what it read did not match. Look at the place it wrote to before you run it again: the write may have happened.': 'Tugasan ini menulis kepada perkhidmatan luar dan membacanya semula, dan apa yang dibacanya tidak sepadan. Semak tempat ia menulis itu sebelum anda menjalankannya semula: penulisan itu mungkin sudah berlaku.',
  'Review deadlocked after {rounds} revisions: {capability}': 'Semakan buntu selepas {rounds} pindaan: {capability}',
  'The role and its reviewer did not agree on {capability}.': 'Peranan itu dan penyemaknya tidak bersetuju tentang {capability}.',
  'The reviewer\'s last note: {note}': 'Nota terakhir penyemak: {note}',
  'The reviewer left no note.': 'Penyemak tidak meninggalkan nota.',
  'What it was judged against: {criteria}': 'Kriteria yang digunakan untuk menilainya: {criteria}',
  'Review produced no usable verdict: {capability}': 'Semakan tidak menghasilkan keputusan yang boleh digunakan: {capability}',
  'The reviewing task ended without a decision that could be read. The proposed action is still blocked and needs your judgement.': 'Tugasan semakan berakhir tanpa keputusan yang boleh dibaca. Tindakan yang dicadangkan masih disekat dan memerlukan pertimbangan anda.',
  'another stage': 'peringkat lain',
  'Either answer only closes this: the company stays in the {stage} stage.': 'Mana-mana jawapan hanya menutup perkara ini: syarikat kekal di peringkat {stage}.',
  'Either answer only closes this: the company stays without a stage.': 'Mana-mana jawapan hanya menutup perkara ini: syarikat kekal tanpa peringkat.',
  'To move it anyway, set the stage on the Overview.': 'Untuk memindahkannya juga, tetapkan peringkat di Gambaran keseluruhan.',
  '{reviewer} stopped a proposal to move the company from {from} to {to}': '{reviewer} menghentikan cadangan untuk memindahkan syarikat dari {from} ke {to}',
  '{reviewer} reviewed it before you and stopped it:': '{reviewer} menyemaknya sebelum anda dan menghentikannya:',
  'No reason was given.': 'Tiada sebab diberikan.',
  'What was proposed:': 'Apa yang dicadangkan:',
  'The company stays in the {stage} stage.': 'Syarikat kekal di peringkat {stage}.',
  'The company stays without a stage.': 'Syarikat kekal tanpa peringkat.',
  'Move the company from {from} to {to}?': 'Pindahkan syarikat dari {from} ke {to}?',
  'Reviewed by {reviewer} before you:': 'Disemak oleh {reviewer} sebelum anda:',
  'The schedule "{schedule}" keeps producing the same result': 'Jadual “{schedule}” terus memberikan hasil yang sama',
  'Its last {runs} runs all ended with the same output. That is sometimes exactly right -- a report with nothing new to say -- and often a schedule that stopped doing anything useful while still being paid for. Deny to turn it off; approve to keep it running and not be asked about this result again.': '{runs} larian terakhirnya semua berakhir dengan hasil yang sama. Kadangkala itu memang betul — laporan yang tiada perkara baharu untuk disampaikan — dan selalunya itu jadual yang sudah tidak melakukan apa-apa yang berguna tetapi masih dibayar. Tolak untuk mematikannya; Luluskan untuk terus menjalankannya dan tidak ditanya lagi tentang hasil ini.',
  'Capability {capability} failed preflight': 'Keupayaan {capability} gagal semakan awal',
  'Batch guard stopped {capability}': 'Kawalan tindakan pukal menghentikan {capability}',
  'It did not match the plan its run recorded. Nothing was sent, and no service was called.': 'Ia tidak sepadan dengan rancangan yang direkodkan oleh lariannya. Tiada apa-apa dihantar, dan tiada perkhidmatan dipanggil.',
  '{role} was asked first and has had {minutes} minutes.': '{role} ditanya dahulu dan telah diberi {minutes} minit.',
  '{role} is not a role in this company, so this came to you at once.': '{role} bukan peranan dalam syarikat ini, jadi perkara ini terus sampai kepada anda.',
  '{role} could not be given this: the company has no active goal or project to hang it from.': 'Perkara ini tidak dapat diberikan kepada {role}: syarikat tiada matlamat atau projek aktif untuk meletakkannya.',
  '{role} could not be given this ({record}), so this came to you at once.': 'Perkara ini tidak dapat diberikan kepada {role} ({record}), jadi ia terus sampai kepada anda.',
  '{role} stopped without an account of what it did ({why}).': '{role} berhenti tanpa laporan tentang apa yang dibuatnya ({why}).',
  '{role} finished without an account of what it did.': '{role} selesai tanpa laporan tentang apa yang dibuatnya.',
  '{role} failed without an account of what it did.': '{role} gagal tanpa laporan tentang apa yang dibuatnya.',
  '{role} was stopped without an account of what it did.': '{role} dihentikan tanpa laporan tentang apa yang dibuatnya.',
  'Proposed change to the {kind} "{goal}"': 'Cadangan perubahan pada {kind} “{goal}”',
  'Currently: {statement}': 'Sekarang: {statement}',
  'Currently: {statement} ({status})': 'Sekarang: {statement} ({status})',
  'Proposed: {statement}': 'Dicadangkan: {statement}',
  'Proposed status: {status}': 'Status yang dicadangkan: {status}',
  'Reason given: {reason}': 'Sebab yang diberikan: {reason}',
  'Record an entry in the books': 'Merekod catatan dalam buku',
  'Record a customer or a deal': 'Rekod pelanggan atau urus niaga',
  'Not sent on its own: {reason}': 'Tidak dihantar secara automatik: {reason}',
  'it answers a conversation other than the one this work began with': 'balasan ini untuk perbualan lain, bukan yang memulakan kerja ini',
  'it named no passage of a document for customers': 'balasan ini tidak menyebut mana-mana bahagian dokumen untuk pelanggan',
  'it answers from a document not marked for customers': 'balasan ini menjawab daripada dokumen yang tidak ditanda untuk pelanggan',
  'it says a figure the documents and the customer did not: {detail}': 'balasan ini menyebut angka yang tiada dalam dokumen mahupun mesej pelanggan: {detail}',
  'it gives an address or link the documents and the customer did not: {detail}': 'balasan ini memberi alamat atau pautan yang tiada dalam dokumen mahupun mesej pelanggan: {detail}',
  'there have been six answers on its own in this conversation in the last hour': 'sudah ada enam jawapan automatik dalam perbualan ini dalam sejam yang lalu',
  'the check found it is about a refund': 'semakan mendapati ia mengenai bayaran balik',
  'the check found it offers a price or terms of its own': 'semakan mendapati balasan ini menawarkan harga atau syarat sendiri',
  'the check found it answers a serious complaint': 'semakan mendapati balasan ini menjawab aduan serius',
  'the check found it touches the law': 'semakan mendapati balasan ini menyentuh undang-undang',
  'the check found it gives or asks for personal data': 'semakan mendapati balasan ini memberi atau meminta data peribadi',
  'the check found it promises something the documents do not': 'semakan mendapati balasan ini menjanjikan sesuatu yang tiada dalam dokumen',
  'the check could not judge it': 'semakan tidak dapat menilainya',
  'the check found something in it the documents do not say': 'semakan menemui sesuatu yang tidak dinyatakan dalam dokumen',
  '{role} proposes the schedule {name}': '{role} mencadangkan jadual {name}',
  'Each run: {instruction}': 'Setiap kali berjalan: {instruction}',
  'Done by: {role}': 'Dilakukan oleh: {role}',
  'When: {cron} ({timezone}); the next runs are {runs}': 'Bila: {cron} ({timezone}); larian seterusnya {runs}',
  'Approving it makes the schedule and starts it; it can be turned off or changed under Team, Schedules.': 'Meluluskannya membuat jadual itu dan memulakannya; ia boleh dimatikan atau diubah di Pasukan, Jadual.',
  'No schedule is made.': 'Tiada jadual dibuat.',
  'Propose a schedule': 'Cadangkan jadual',
  'Approving it changes the goal; until then the work carries on under the goal as it is.': 'Meluluskannya akan mengubah matlamat; sehingga itu kerja diteruskan di bawah matlamat yang sedia ada.',
  'The goal stays as it is.': 'Matlamat kekal seperti sedia ada.',
  'mission': 'misi',
  'objective': 'objektif',
  'key result': 'hasil utama',
  'Active': 'Aktif',
  'Met': 'Tercapai',
  'Abandoned': 'Ditinggalkan',
  'This work asked for it at tier {tier}, and policy {policies} requires your approval.': 'Kerja ini memintanya pada tahap {tier}, dan dasar {policies} memerlukan kelulusan anda.',
  'This work asked for it at tier {tier}, and the task began with content from outside the company.': 'Kerja ini memintanya pada tahap {tier}, dan tugasan ini bermula dengan kandungan dari luar syarikat.',
  'This work asked for it at tier {tier}, and the work read content from outside the company before asking.': 'Kerja ini memintanya pada tahap {tier}, dan kerja ini membaca kandungan dari luar syarikat sebelum meminta.',
  'This work asked for it at tier {tier}, after the work read content from outside the company, and the guardian asked you first: {reason}': 'Kerja ini memintanya pada tahap {tier}, selepas kerja ini membaca kandungan dari luar syarikat, dan penjaga bertanya kepada anda dahulu: {reason}',
  'it doubted this call before, and you allowed it once': 'ia pernah meragui panggilan ini, dan anda membenarkannya sekali',
  'This work asked for it at tier {tier}, which cannot be reversed.': 'Kerja ini memintanya pada tahap {tier}, yang tidak boleh diundur.',
  'You approved this once already, and the worker carrying it out stopped before it could say whether it happened: it may already have happened. Check before approving it again.': 'Anda sudah meluluskan ini sekali, dan pekerja yang melaksanakannya berhenti sebelum sempat memberitahu sama ada ia berlaku: ia mungkin sudah berlaku. Semak dahulu sebelum meluluskannya semula.',
  'What this is for — {goals}': 'Tujuannya — {goals}',
  'The task halts and no external change is made.': 'Tugasan terhenti dan tiada perubahan luaran dibuat.',
  'Scored against {total} references: {passed} passed, {failed} failed.': 'Dinilai berdasarkan {total} rujukan: {passed} lulus, {failed} gagal.',
  'This role has fewer than {minimum} accepted references, so the change is unscored. That is not the same as passing.': 'Peranan ini mempunyai kurang daripada {minimum} rujukan yang diterima, jadi perubahan ini belum dinilai. Itu tidak sama dengan lulus.',
  'The role keeps working exactly as it does now.': 'Peranan ini terus bekerja sama seperti sekarang.',
  '{role} asks: {question}': '{role} bertanya: {question}',
  'The run did not say more than the question.': 'Larian tidak menyatakan apa-apa selain soalan itu.',
  'The task is stopped, and nothing it was going to do happens.': 'Tugasan dihentikan, dan apa yang akan dibuatnya tidak berlaku.',
  'You proposed it.': 'Anda yang mencadangkannya.',
  'It came with a bundle.': 'Ia dibawa oleh satu pakej.',
  'An agent proposed it.': 'Satu ejen mencadangkannya.',
  'It was learned from the company\'s work.': 'Ia dipelajari daripada kerja syarikat.',
  'Skill "{skill}", version {version}': 'Kemahiran “{skill}”, versi {version}',
  'The reviewer approved it: {note}': 'Penyemak meluluskannya: {note}',
  'The reviewer approved it.': 'Penyemak meluluskannya.',
  'Nothing changes; the current version of the skill stays in force.': 'Tiada apa-apa yang berubah; versi semasa kemahiran ini kekal berkuat kuasa.',
  'Skills the bundle "{bundle}" brings: {count}': 'Kemahiran yang dibawa oleh pakej “{bundle}”: {count}',
  'The reviewer read them all and approved these:': 'Penyemak membaca kesemuanya dan meluluskan yang berikut:',
  'It turned these down, and they stay off:': 'Ia menolak yang berikut, dan kemahiran itu kekal dimatikan:',
  'Approve to switch them all on, or deny to turn them all down. To decide one at a time, open the Skills page.': 'Luluskan untuk menghidupkan kesemuanya, atau Tolak untuk menolak kesemuanya. Untuk membuat keputusan satu demi satu, buka halaman Kemahiran.',
  'Nothing changes; none of these skills is switched on.': 'Tiada apa-apa yang berubah; tiada satu pun kemahiran ini dihidupkan.',
  "I am {ceo}, and I run {company} for you. I know what it is for: “{mission}” Two things before we start: how much may it spend in a month? And what should its first piece of work be -- or shall I suggest one, and the team it would take?":
    "Saya {ceo}, dan saya menguruskan {company} untuk anda. Saya sudah tahu untuk apa syarikat ini: “{mission}” Dua perkara sebelum kita mula: berapakah yang boleh dibelanjakannya dalam sebulan? Dan apakah kerja pertamanya — atau patutkah saya cadangkan satu, bersama pasukan yang diperlukan?",
  'I am {ceo}, and I run {company} for you. Three things before we start: what does {company} sell, and to whom? How much may it spend in a month? And what should its first piece of work be -- or shall I suggest one?': 'Saya {ceo}, dan saya menguruskan {company} untuk anda. Tiga perkara sebelum kita mula: apakah yang dijual oleh {company}, dan kepada siapa? Berapakah yang boleh dibelanjakannya dalam sebulan? Dan apakah kerja pertamanya — atau patutkah saya cadangkan satu?',
  'Read a customer conversation': 'Baca perbualan pelanggan',
  'Reply to a customer': 'Balas pelanggan',
  'Read a page in the browser': 'Baca halaman dalam pelayar',
  'Fill in a page in the browser': 'Isi halaman dalam pelayar',
  'Ask you to take over the browser': 'Meminta anda mengambil alih pelayar',
  '{host} refused the model key ({status}), so nothing that needs the model can run. Open Settings, This deployment, Model, paste a key that works, test it and save.':
    '{host} menolak kunci model ({status}), jadi tiada kerja yang memerlukan model dapat berjalan. Buka Tetapan, Pemasangan ini, Model, tampal kunci yang berfungsi, uji dan simpan.',
  '{host} refused the model key, and work is waiting': '{host} menolak kunci model, dan kerja sedang menunggu',
  'A task ended before it was done: {task}':
    'Satu tugas berakhir sebelum siap: {task}',
  'It ended as: {reason}. No other card was raised for it, so it is here rather than silent.':
    'Ia berakhir sebagai: {reason}. Tiada kad lain dibuat untuknya, jadi ia ada di sini dan bukan senyap.',
  'Where its measures stand, as the platform reads them:':
    'Kedudukan ukurannya, seperti yang dibaca platform:',
  '{name}: no value recorded yet, against a target of {target}.':
    '{name}: belum ada nilai, dengan sasaran {target}.',
  '{name}: {value} against a target of {target}, read back from its source.':
    '{name}: {value} dengan sasaran {target}, dibaca semula daripada puncanya.',
  '{name}: {value} against a target of {target}, reported and not checked.':
    '{name}: {value} dengan sasaran {target}, dilaporkan dan belum disemak.',
  'Look at it again later': 'Lihat semula kemudian',
  "Deliver what this company sells, reliably and without surprising its owner.":
    "Menyampaikan apa yang dijual oleh syarikat ini dengan boleh dipercayai dan tanpa mengejutkan pemiliknya.",
  "Ship the work the company has promised, on time and verified.":
    "Menyiapkan kerja yang telah dijanjikan syarikat, tepat pada masanya dan telah disahkan.",
  "Keep the company solvent, answerable and running without daily attention.":
    "Memastikan kewangan syarikat kukuh, boleh dipertanggungjawabkan dan berjalan tanpa perhatian harian.",
  "Since we last spoke:":
    "Sejak kali terakhir kita berbual:",
  "More finished: {count}":
    "Lain-lain selesai: {count}",
  "Waiting for you: {count}":
    "Menunggu anda: {count}",
  'This is the third time in a day, so it does not go on by itself.':
    'Ini kali ketiga dalam sehari, jadi ia tidak diteruskan sendiri.',
  'Invoice {number} needs you: {customer} has not paid':
    'Invois {number} memerlukan anda: {customer} belum membayar',
  '{customer} still owes {amount} on invoice {number}, due {due}, after the last reminder. The platform has stopped writing to them. What comes next is yours: a call, a final notice, or letting it go.':
    '{customer} masih berhutang {amount} pada invois {number}, tarikh akhir {due}, selepas peringatan terakhir. Platform telah berhenti menulis kepada mereka. Langkah seterusnya milik anda: panggilan, notis akhir, atau melepaskannya.',
  'Invoice {number} ({amount}, {customer}) has been overdue since {due}, and no reminder was ever sent, so the platform did not send a form letter this late. Follow it up yourself, or tell the CEO what you want done.':
    'Invois {number} ({amount}, {customer}) lewat tempoh sejak {due}, dan tiada peringatan pernah dihantar, jadi platform tidak menghantar surat templat sebegini lewat. Susuli sendiri, atau beritahu CEO apa yang anda mahu dilakukan.',
  'Invoice {number} ({amount}, {customer}) has been overdue since {due}, and there is no email address to send a reminder to. Add one to the customer, or follow it up yourself.':
    'Invois {number} ({amount}, {customer}) lewat tempoh sejak {due}, dan tiada alamat e-mel untuk menghantar peringatan. Tambahkan pada pelanggan, atau susuli sendiri.',
  'Nobody is set to remind customers about overdue invoices':
    'Tiada sesiapa ditetapkan untuk mengingatkan pelanggan tentang invois lewat tempoh',
  'Reminded the customers of: {invoices}.':
    'Pelanggan diingatkan tentang: {invoices}.',
  'No reminder was due.':
    'Tiada peringatan yang perlu dihantar.',
  'Remind a customer about an invoice':
    'Mengingatkan pelanggan tentang sebuah invois',
  'Some invoices are past their due date, and no role can send the reminders. Turn on automatic reminders under Books, Invoices: the company then sends them on the days you set.':
    'Beberapa invois sudah melepasi tarikh akhir, dan tiada peranan yang boleh menghantar peringatan. Hidupkan peringatan automatik di Buku akaun, Invois: syarikat kemudian menghantarnya pada hari yang anda tetapkan.',
  'Reminders for overdue invoices need a mailbox to send them from. Give this division its mailbox.':
    'Peringatan untuk invois lewat tempoh memerlukan peti mel untuk menghantarnya. Berikan peti mel bahagian ini.',
  'Remind the customers whose invoices are overdue':
    'Mengingatkan pelanggan yang invoisnya lewat tempoh',
  'each customer whose next reminder is due has been written to once':
    'setiap pelanggan yang peringatan seterusnya sudah tiba masa telah dihantar sekali',
  'Reminder for invoice {number} not confirmed':
    'Peringatan untuk invois {number} tidak disahkan',
  'The mail server did not confirm reminder {step} of {of} for invoice {number} to {customer} ({to}), handed to it on {day}. It may or may not have arrived. The platform will not send it again: if {customer} says they did not get it, send it yourself, or tell the CEO.':
    'Pelayan e-mel tidak mengesahkan peringatan {step} daripada {of} untuk invois {number} kepada {customer} ({to}), yang diserahkan kepadanya pada {day}. Ia mungkin sampai, mungkin tidak. Platform tidak akan menghantarnya lagi: jika {customer} berkata mereka tidak menerimanya, hantar sendiri, atau beritahu CEO.',
  'Your CEO proposes hiring: {role}':
    'CEO anda mencadangkan untuk mengambil: {role}',
  'Hiring is yours to decide. Hire it with the CEO in a word, or close the ticket if the company does not need it.':
    'Mengambil pekerja ialah keputusan anda. Ambil bersama CEO dengan sepatah kata, atau tutup tiket jika syarikat tidak memerlukannya.',
  'Withdrawn: the ticket it was about was closed.':
    'Ditarik balik: tiket yang dibincangkannya telah ditutup.',
  'Invoice {number} ({amount}, {customer}) has been overdue since {due}, and it was issued with no email address to send a reminder to. Follow it up yourself, or tell the CEO what you want done.':
    'Invois {number} ({amount}, {customer}) lewat tempoh sejak {due}, dan ia dikeluarkan tanpa alamat e-mel untuk menghantar peringatan. Susuli sendiri, atau beritahu CEO apa yang anda mahu dilakukan.',
  'Kept as your word: {words}':
    'Disimpan sebagai kata-kata anda: {words}',
  'Recorded as your figure: {value} for {measure}':
    'Direkodkan sebagai angka anda: {value} untuk {measure}',
  'Runs picked up again after their worker stopped: {count}':
    'Larian yang disambung semula selepas pekerjanya berhenti: {count}',
  'Withdrawn: the task it was about was run again.':
    'Ditarik: tugasan yang berkaitan telah dijalankan semula.',
  'Withdrawn: the day it was about has ended.':
    'Ditarik: hari yang berkaitan telah berakhir.',
  'Withdrawn: the month\'s ceiling was reached, and the card that says the company is paused takes its place.':
    'Ditarik: had bulan ini telah dicapai, dan kad yang menyatakan syarikat dijeda menggantikannya.',
  'Work still waiting after about {hours} hours stops, and this card then stays open for you to run it again.':
    'Kerja yang masih menunggu selepas kira-kira {hours} jam akan berhenti, dan kad ini kemudian kekal terbuka supaya anda boleh menjalankannya semula.',
  '{service} is not answering, and the work that needs it is waiting':
    '{service} tidak menjawab, dan kerja yang memerlukannya sedang menunggu',
  'The work waited about {minutes} minutes, looking again each time, and is still waiting: it carries on by itself once the service answers, and this card then closes itself.':
    'Kerja ini telah menunggu kira-kira {minutes} minit, menyemak semula setiap kali, dan masih menunggu: ia akan diteruskan sendiri sebaik sahaja perkhidmatan itu menjawab, dan kad ini kemudian ditutup dengan sendirinya.',
  'The work waits and carries on by itself once the model answers, and this card then closes itself.':
    'Kerja ini menunggu dan akan diteruskan sendiri sebaik sahaja model menjawab, dan kad ini kemudian ditutup dengan sendirinya.',
  'Model {model} is not answering, and work is waiting for it':
    'Model {model} tidak menjawab, dan kerja sedang menunggunya',
  'What is waiting for the model carries on by itself once a key that works is in use, and this card then closes itself.':
    'Kerja yang menunggu model akan diteruskan sendiri sebaik sahaja kunci yang berfungsi digunakan, dan kad ini kemudian ditutup dengan sendirinya.',
  'Work that needs it waits rather than starts, and carries on by itself once the check passes; this card then closes itself. The usual causes are an expired or wrongly scoped credential, a quota used up, or an address that is wrong.':
    'Kerja yang memerlukannya menunggu dan bukan dimulakan, dan akan diteruskan sendiri sebaik sahaja semakan itu lulus; kad ini kemudian ditutup dengan sendirinya. Punca biasa ialah bukti kelayakan yang tamat tempoh atau salah skop, kuota yang telah habis, atau alamat yang salah.',
  '{role} was stopped: the work on this card has been taken up again.':
    '{role} dihentikan: kerja dalam kad ini telah dijalankan semula.',
  'Withdrawn: the month it was about has ended.':
    'Ditarik: bulan yang berkaitan telah berakhir.',
  'Withdrawn: the pause was lifted, and work goes on.':
    'Ditarik: jeda telah ditarik balik, dan kerja diteruskan.',
  'Withdrawn: the model is answering again, and any work waiting for it was called back.':
    'Ditarik: model menjawab semula, dan kerja yang menunggunya telah dipanggil semula.',
  'Withdrawn: the model key works again, and any work waiting for it was called back.':
    'Ditarik: kunci model berfungsi semula, dan kerja yang menunggunya telah dipanggil semula.',
  'Withdrawn: the service passed its check again, and any work waiting for it was called back.':
    'Ditarik: perkhidmatan lulus semakannya semula, dan kerja yang menunggunya telah dipanggil semula.',
  'Withdrawn: no work is waiting on it any more.':
    'Ditarik: tiada lagi kerja yang menunggunya.',
  'Withdrawn: the role it was handed to dealt with it, and nothing is left for you to decide.':
    'Ditarik: peranan yang menerimanya telah menguruskannya, dan tiada lagi yang perlu anda putuskan.',
  'Work finished: {count}':
    'Kerja selesai: {count}',
  'Stopped: its work was taken up another way':
    'Dihentikan: kerjanya telah diuruskan dengan cara lain',
  'Its work stopped, and each time it took down the worker running it.':
    'Kerjanya terhenti, dan setiap kali ia menjatuhkan worker yang menjalankannya.',
  'A write to an outside service may have happened without being what was meant.':
    'Penulisan ke perkhidmatan luar mungkin telah berlaku, tetapi bukan seperti yang dimaksudkan.',
  'Work charged to the same budget account stops until it has room again.':
    'Kerja yang dicaj kepada akaun bajet yang sama terhenti sehingga akaun itu ada ruang semula.',
  'Its work stopped before it was done.':
    'Kerjanya terhenti sebelum siap.',
  'The platform counted {lost} lost workers, the most a task may lose.':
    'Platform mengira {lost} worker yang hilang, had paling banyak bagi satu tugas.',
  'The platform read back what was written, and it did not match.':
    'Platform membaca semula apa yang ditulis, dan ia tidak sepadan.',
  'The budget account had nothing left to reserve for the work.':
    'Akaun bajet tiada baki untuk dikhaskan bagi kerja itu.',
  'The platform found it ended with no card raised for it.':
    'Platform mendapati ia berakhir tanpa sebarang kad dibangkitkan untuknya.',
  'The card went to whoever the division names to deal with it, and to you after.':
    'Kad itu pergi kepada sesiapa yang dinamakan bahagian untuk menanganinya, dan kemudian kepada anda.',
  'The task was halted, and you were told on a card in the inbox.':
    'Tugas itu dihentikan, dan anda dimaklumkan melalui kad dalam peti masuk.',
  'Postmortem: {cause} ({about})':
    'Analisis selepas kejadian: {cause} ({about})',
  'What happened':
    'Apa yang berlaku',
  'Impact':
    'Kesan',
  'Trigger':
    'Pencetus',
  'Detection':
    'Pengesanan',
  'What was done':
    'Apa yang dilakukan',
  'A task of {role} stopped before it was done.':
    'Satu tugas {role} terhenti sebelum siap.',
  'To solve it: find the root cause by asking why of each answer and checking it against the record, decide once, and file the to-dos that carry the decision out, each with one seat.':
    'Cara menyelesaikannya: cari punca utama dengan bertanya mengapa pada setiap jawapan dan menyemaknya dengan rekod, putuskan sekali, dan failkan tindakan yang melaksanakan keputusan itu, setiap satu dengan satu kerusi.',
  'Off track: {name}':
    'Terkeluar landasan: {name}',
  '{name} was {value} in the week of {week}, against a weekly goal of {target}.':
    '{name} ialah {value} pada minggu {week}, berbanding sasaran mingguan {target}.',
  '{role} answers for it.':
    '{role} bertanggungjawab atasnya.',
  'No seat answers for it.':
    'Tiada jawatan yang bertanggungjawab atasnya.',
  'The platform read it from the weekly scorecard before the weekly operating meeting.':
    'Platform membacanya daripada kad skor mingguan sebelum mesyuarat operasi mingguan.',
  'Not done at two meetings: {title}':
    'Tidak selesai di dua mesyuarat: {title}',
  'The to-do "{title}", due on {due}, was not done at the weekly operating meeting of {previous}, nor at this one.':
    'Tindakan "{title}", perlu siap pada {due}, tidak selesai pada mesyuarat operasi mingguan {previous}, dan tidak juga pada mesyuarat ini.',
  'The platform read it from the to-dos before the weekly operating meeting.':
    'Platform membacanya daripada senarai tindakan sebelum mesyuarat operasi mingguan.',
  'Weekly operating meeting held ({week}): {where}':
    'Mesyuarat operasi mingguan diadakan ({week}): {where}',
  'see its task under Work':
    'lihat tugasnya di Kerja',
  'New goals proposed, to approve line by line':
    'Matlamat baharu dicadangkan, untuk diluluskan baris demi baris',
  'Line {line}: the {kind} "{goal}"':
    'Baris {line}: {kind} "{goal}"',
  'Under: {goal}':
    'Di bawah: {goal}',
  'Under line {line}: {goal}':
    'Di bawah baris {line}: {goal}',
  'Period: {from} to {to}':
    'Tempoh: {from} hingga {to}',
  'Committed: done in full, or missed.':
    'Wajib dicapai: siap sepenuhnya, atau terlepas.',
  'Aspirational: graded, and 0.6 to 0.7 is a good result.':
    'Aspirasi: diberi gred, dan 0.6 hingga 0.7 ialah hasil yang baik.',
  'Learning: a test of the prediction below.':
    'Pembelajaran: menguji ramalan di bawah.',
  'Owned by: {role}':
    'Dimiliki oleh: {role}',
  'Done when: {doneWhen}':
    'Siap apabila: {doneWhen}',
  'The prediction, written before the work: {name} reaches {target}, from {baseline}.':
    'Ramalannya, ditulis sebelum kerja bermula: {name} mencapai {target}, daripada {baseline}.',
  'Measured by {name}: from {baseline} to {target}.':
    'Diukur dengan {name}: daripada {baseline} kepada {target}.',
  'Watched with: {measure}':
    'Dipantau bersama: {measure}',
  'Goals for this year: {count}, more than the {limit} a company keeps in view.':
    'Matlamat tahun ini: {count}, lebih daripada {limit} yang dapat dipantau sebuah syarikat.',
  'Key results under this objective: {count}, more than the {limit} one objective keeps in view.':
    'Hasil utama di bawah objektif ini: {count}, lebih daripada {limit} yang dapat dipantau satu objektif.',
  'Quarterly priorities at once: {count}, more than the {limit} a company keeps in view.':
    'Keutamaan suku tahun serentak: {count}, lebih daripada {limit} yang dapat dipantau sebuah syarikat.',
  'Quarterly priorities for {seat} at once: {count}, more than the {limit} one seat keeps in view.':
    'Keutamaan suku tahun untuk {seat} serentak: {count}, lebih daripada {limit} yang dapat dipegang satu kerusi.',
  'Approving makes a goal of each line you approve, with its measure; a line you refuse is not made. Until then the work carries on under the goals as they are.':
    'Meluluskan menjadikan setiap baris yang anda luluskan satu matlamat, bersama ukurannya; baris yang anda tolak tidak dibuat. Sehingga itu kerja diteruskan di bawah matlamat yang sedia ada.',
  'No goal is made.':
    'Tiada matlamat dibuat.',
  'Missed: {statement}':
    'Terlepas: {statement}',
  '{statement}, committed for {from} to {to}, was not done.':
    '{statement}, yang wajib dicapai dari {from} hingga {to}, tidak siap.',
  'Measured by its numbers, it came {progress} of the way.':
    'Diukur dengan angkanya, ia sampai {progress} daripada perjalanannya.',
  'It was not marked met by its due date.':
    'Ia tidak ditandakan tercapai sebelum tarikh akhirnya.',
  'The platform graded it when its period ended.':
    'Platform menilainya apabila tempohnya berakhir.',
  'Off pace: {statement}':
    'Ketinggalan: {statement}',
  '{statement} is a committed priority due on {due}. Its numbers have come {progress} of the way, with {elapsed} of its period gone.':
    '{statement} ialah keutamaan wajib dicapai yang berakhir pada {due}. Angkanya baru sampai {progress} daripada perjalanannya, sedangkan {elapsed} daripada tempohnya sudah berlalu.',
  'Nothing was changed to catch up, and no agent is asked to: a committed number behind its time invites riskier action to make it up, and whether to take such a risk is yours. Decide whether to move the date, lower the target, make it aspirational, or let it run and be missed.':
    'Tiada apa yang diubah untuk mengejarnya, dan tiada ejen yang diminta: angka wajib yang ketinggalan masa mengundang tindakan yang lebih berisiko untuk menebusnya, dan sama ada risiko itu diambil ialah keputusan anda. Putuskan sama ada tarikhnya dianjakkan, sasarannya diturunkan, dijadikan aspirasi, atau dibiarkan berjalan dan terlepas.',
  'Nothing is stopped either way. The priority stays as it is and is graded when its period ends; change it on the Goals page if you decide to.':
    'Tiada apa yang dihentikan, apa pun jawapannya. Keutamaan itu kekal seperti sedia ada dan dinilai apabila tempohnya berakhir; ubah di halaman Matlamat jika anda memutuskannya.',
};

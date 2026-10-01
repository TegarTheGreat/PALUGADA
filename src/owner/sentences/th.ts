/**
 * ไทย: what the platform itself says to the owner outside the console
 * (src/owner/say.ts), keyed by its English.
 *
 * The terms are the console's (console/src/locales/th.ts, whose header holds
 * the glossary): อนุมัติ and ปฏิเสธ, กล่องขาเข้า, รายการ for an item, การ์ด for
 * a card, and ระบบนี้ for the This deployment page, with its sections joined
 * by " > " as the console writes them. The register is polite and neutral,
 * with no gendered particle; the assistant says ฉัน. Thai ends a sentence with
 * a space, not a full stop. Telegram and WhatsApp buttons stay short: WhatsApp
 * cuts a button at 20 characters and a list row at 24.
 */
export const SENTENCES: Readonly<Record<string, string>> = {
  'Incident: {title}': 'เหตุขัดข้อง: {title}',
  'Done: {goal}': 'เสร็จแล้ว: {goal}',
  'Stopped before finishing: {goal}': 'หยุดก่อนเสร็จ: {goal}',
  'Why: {reason}': 'สาเหตุ: {reason}',
  'a task': 'งานหนึ่ง',
  'Approval needed: {title}': 'รอการอนุมัติ: {title}',
  '{summary} — if denied: {consequence}': '{summary} — หากปฏิเสธ: {consequence}',
  'If denied:': 'หากปฏิเสธ:',
  'Expires:': 'หมดอายุ:',
  'This one is decided in the app.': 'รายการนี้ต้องตัดสินในแอป',
  'Open in PALUGADA': 'เปิดใน PALUGADA',
  'Approve': 'อนุมัติ',
  'Deny': 'ปฏิเสธ',
  'Ask': 'ถาม',
  'Approved. Nothing left to press here.': 'อนุมัติแล้ว ไม่ต้องกดอะไรที่นี่อีก',
  'Denied. Nothing left to press here.': 'ปฏิเสธแล้ว ไม่ต้องกดอะไรที่นี่อีก',
  'Decided ({decision}). Nothing left to press here.': 'ตัดสินแล้ว ({decision}) ไม่ต้องกดอะไรที่นี่อีก',
  'Expired unanswered. Silence is a refusal, so nothing was done.':
    'หมดเวลาโดยไม่มีคำตอบ การเงียบถือเป็นการปฏิเสธ จึงไม่มีการดำเนินการใด',
  'Withdrawn: the task it was asking about is {state}.': 'ถอนแล้ว: งานที่รายการนี้ถามถึงอยู่ในสถานะ {state}',
  'Withdrawn ({reason}).': 'ถอนแล้ว ({reason})',
  'no reason recorded': 'ไม่มีการบันทึกเหตุผล',
  'This bot only answers to its owner.': 'บอตนี้ตอบเฉพาะเจ้าของเท่านั้น',
  'That one has to be approved in the app.': 'รายการนี้ต้องอนุมัติในแอป',
  'Already closed: {reason}.': 'ปิดไปแล้ว: {reason}',
  'That could not be recorded.': 'บันทึกไม่สำเร็จ',
  'That item no longer exists.': 'รายการนี้ไม่มีอยู่แล้ว',
  'What do you want to ask about "{title}"? Reply to this message.':
    'คุณต้องการถามอะไรเกี่ยวกับ “{title}” ตอบกลับข้อความนี้',
  'Your question': 'คำถามของคุณ',
  'Type your question as a reply.': 'พิมพ์คำถามของคุณเป็นข้อความตอบกลับ',
  'Asked. The answer will be on the item in the app.': 'ส่งคำถามแล้ว คำตอบจะแสดงที่รายการนี้ในแอป',
  'Answer': 'ตอบ',
  'Answer in words': 'ตอบเป็นข้อความ',
  'That choice is not on this question.': 'คำถามนี้ไม่มีตัวเลือกนั้น',
  'Chosen: {choice}.': 'เลือกแล้ว: {choice}',
  'Stop the task': 'หยุดงาน',
  'Your answer to "{question}"? Reply to this message.': 'คำตอบของคุณสำหรับ “{question}” ตอบกลับข้อความนี้',
  'Your answer': 'คำตอบของคุณ',
  'Type your answer as a reply.': 'พิมพ์คำตอบของคุณเป็นข้อความตอบกลับ',
  'Answered. The task carries on with it.': 'ตอบแล้ว งานจะทำต่อโดยใช้คำตอบนี้',
  'That is too long for one question; keep it under {max} characters.':
    'ยาวเกินไปสำหรับคำถามเดียว เขียนให้ไม่เกิน {max} ตัวอักษร',
  '[a key, not kept]': '[คีย์ ไม่ได้เก็บไว้]',
  'That looks like a key, so I did not keep it or send it anywhere. Keys go in the sealed field on a card, or on their page in This deployment: tell me what it is for and I will put the card in front of you.':
    'ข้อความนี้ดูเหมือนคีย์ ฉันจึงไม่ได้เก็บไว้หรือส่งไปที่ใด คีย์ต้องใส่ในช่องปิดผนึกบนการ์ด หรือในหน้าของคีย์นั้นใน “ระบบนี้” บอกฉันว่าคีย์นี้ใช้สำหรับอะไร แล้วฉันจะแสดงการ์ดให้คุณ',
  'No model is set up yet, so I cannot think. Choose one under This deployment, Model; then I can help with everything else.':
    'ยังไม่ได้ตั้งค่าโมเดล ฉันจึงยังคิดไม่ได้ เลือกโมเดลที่ ระบบนี้ > โมเดล แล้วฉันจะช่วยเรื่องอื่นๆ ได้ทั้งหมด',
  'The model did not answer: {reason}': 'โมเดลไม่ตอบ: {reason}',
  'Here is what I propose.': 'นี่คือสิ่งที่ฉันเสนอ',
  'I have nothing to add.': 'ฉันไม่มีอะไรจะเพิ่มเติม',
  '{name}, CEO of {company}': '{name} CEO ของ {company}',
  'That could not be answered: {reason}': 'ตอบไม่ได้: {reason}',
  'I read text and voice notes.': 'ฉันอ่านได้เฉพาะข้อความและข้อความเสียง',
  'Now talking to {name}.': 'ตอนนี้คุณกำลังคุยกับ {name}',
  'Choose whom to talk to.': 'เลือกว่าจะคุยกับใคร',
  'Choose whom to talk to': 'เลือกว่าจะคุยกับใคร',
  'Talk to PALUGADA about the whole deployment': 'คุยกับ PALUGADA เรื่องทั้งระบบ',
  'Who you are talking to, and how': 'คุณกำลังคุยกับใคร และคุยอย่างไร',
  'Stopped.': 'หยุดแล้ว',
  'Write here to talk to {name}.': 'พิมพ์ที่นี่เพื่อคุยกับ {name}',
  'You are talking to {name}. Write, or send a voice note. /ceo chooses whom you talk to; /palugada talks to PALUGADA about the whole deployment.':
    'คุณกำลังคุยกับ {name} พิมพ์ข้อความหรือส่งข้อความเสียงได้ ใช้ /ceo เพื่อเลือกว่าจะคุยกับใคร และ /palugada เพื่อคุยกับ PALUGADA เรื่องทั้งระบบ',
  'You said: "{words}"': 'คุณพูดว่า: “{words}”',
  'in the app': 'ในแอป',
  'Apply: {summary}': 'นำไปใช้: {summary}',
  'Nothing hears speech yet: choose a provider in the app, under This deployment, Tools, Listening.':
    'ยังไม่มีบริการฟังเสียง: เลือกผู้ให้บริการในแอป ที่ ระบบนี้ > เครื่องมือ > การฟัง',
  'That recording is too long; keep a voice note under {max} MB.':
    'ไฟล์เสียงยาวเกินไป ข้อความเสียงต้องไม่เกิน {max} MB',
  'I could not make out any words in that.': 'ฉันฟังไม่ออกว่าพูดว่าอะไร',
  'Done: {summary}': 'เสร็จแล้ว: {summary}',
  'That one is applied in the app.': 'รายการนี้ต้องนำไปใช้ในแอป',
  'That card no longer exists.': 'การ์ดนี้ไม่มีอยู่แล้ว',
  'That card was already applied.': 'การ์ดนี้ถูกนำไปใช้แล้ว',
  'That card was dismissed.': 'การ์ดนี้ถูกปัดทิ้งแล้ว',
  'That card failed when it was applied.': 'การ์ดนี้ล้มเหลวขณะนำไปใช้',
  'That could not be done: {reason}': 'ทำไม่สำเร็จ: {reason}',
  'Choose': 'เลือก',
  'What do you want to ask about "{title}"? Reply to this message with your question.':
    'คุณต้องการถามอะไรเกี่ยวกับ “{title}” พิมพ์คำถามเป็นข้อความตอบกลับข้อความนี้',
  'Your answer to "{question}"? Reply to this message with your answer.':
    'คำตอบของคุณสำหรับ “{question}” พิมพ์คำตอบเป็นข้อความตอบกลับข้อความนี้',
  'I read text messages here.': 'ที่นี่ฉันอ่านได้เฉพาะข้อความตัวอักษร',
  'Apply one of these here:': 'เลือกนำรายการหนึ่งไปใช้ที่นี่:',
  'Apply {number}': 'ใช้ข้อ {number}',
  'Signed in to {provider} for the {alias} key': 'ลงชื่อเข้าใช้ {provider} สำหรับคีย์ {alias} แล้ว',
  'Go back to PALUGADA: the division holds this key now, and it is renewed before it runs out. This tab can be closed.':
    'กลับไปที่ PALUGADA: ตอนนี้ฝ่ายถือคีย์นี้แล้ว และจะต่ออายุก่อนหมดอายุ ปิดแท็บนี้ได้เลย',
  'Signed in to {name}': 'ลงชื่อเข้าใช้ {name} แล้ว',
  'Go back to PALUGADA to choose which of its tools roles may use. This tab can be closed.':
    'กลับไปที่ PALUGADA เพื่อเลือกเครื่องมือที่บทบาทใช้ได้ ปิดแท็บนี้ได้เลย',
  'Not signed in': 'ยังไม่ได้ลงชื่อเข้าใช้',
  'Recorded: approved.': 'บันทึกแล้ว: อนุมัติ',
  'Recorded: denied.': 'บันทึกแล้ว: ปฏิเสธ',
  'Recorded: asked.': 'บันทึกแล้ว: ถาม',
  'Asked. Nothing left to press here.': 'ส่งคำถามแล้ว ไม่ต้องกดอะไรที่นี่อีก',
  'Withdrawn: the task it was asking about has finished.': 'ถอนแล้ว: งานที่รายการนี้ถามถึงเสร็จแล้ว',
  'Withdrawn: the task it was asking about has failed.': 'ถอนแล้ว: งานที่รายการนี้ถามถึงล้มเหลว',
  'Withdrawn: the task it was asking about was stopped.': 'ถอนแล้ว: งานที่รายการนี้ถามถึงถูกหยุด',
  'Withdrawn: the task it was asking about was cancelled.': 'ถอนแล้ว: งานที่รายการนี้ถามถึงถูกยกเลิก',
};

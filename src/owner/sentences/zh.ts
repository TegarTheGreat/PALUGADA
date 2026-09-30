/**
 * 简体中文: what the platform itself says to the owner outside the console
 * (src/owner/say.ts), keyed by its English.
 *
 * The terms are the console's (console/src/locales/zh.ts): the owner is 您,
 * an approval 审批, an incident 异常, a card is applied (应用), and "the app"
 * is the console (控制台), so that "apply it in the app" does not read as
 * 应用 twice. Screens are named as the console draws them: “本部署 > 模型”.
 */
export const SENTENCES: Readonly<Record<string, string>> = {
  'Incident: {title}': '异常：{title}',
  'Done: {goal}': '已完成：{goal}',
  'Stopped before finishing: {goal}': '未完成即停止：{goal}',
  'Why: {reason}': '原因：{reason}',
  'a task': '一项任务',
  'Approval needed: {title}': '需要审批：{title}',
  '{summary} — if denied: {consequence}': '{summary}——如果拒绝：{consequence}',
  'If denied:': '如果拒绝：',
  'Expires:': '到期时间：',
  'This one is decided in the app.': '此事项需要在控制台中决定。',
  'Open in PALUGADA': '在 PALUGADA 中打开',
  'Approve': '批准',
  'Deny': '拒绝',
  'Ask': '提问',
  'Approved. Nothing left to press here.': '已批准。这里无需再操作。',
  'Denied. Nothing left to press here.': '已拒绝。这里无需再操作。',
  'Decided ({decision}). Nothing left to press here.': '已决定（{decision}）。这里无需再操作。',
  'Expired unanswered. Silence is a refusal, so nothing was done.':
    '超时未回应。沉默即视为拒绝，因此未执行任何操作。',
  'Withdrawn: the task it was asking about is {state}.': '已撤回：所询问的任务已处于 {state} 状态。',
  'Withdrawn ({reason}).': '已撤回（{reason}）。',
  'no reason recorded': '未记录原因',
  'This bot only answers to its owner.': '此机器人只回应其所有者。',
  'Recorded: {decision}.': '已记录：{decision}。',
  'That one has to be approved in the app.': '此事项必须在控制台中批准。',
  'Already closed: {reason}.': '已关闭：{reason}。',
  'That could not be recorded.': '无法记录此操作。',
  'That item no longer exists.': '该事项已不存在。',
  'What do you want to ask about "{title}"? Reply to this message.':
    '关于“{title}”，您想问什么？请回复此消息。',
  'Your question': '您的问题',
  'Type your question as a reply.': '请以回复的形式输入您的问题。',
  'Asked. The answer will be on the item in the app.': '已提问。回答会显示在控制台中的该事项上。',
  'Answer': '回答',
  'Answer in words': '用文字回答',
  'That choice is not on this question.': '此问题没有这个选项。',
  'Chosen: {choice}.': '已选择：{choice}。',
  'Stop the task': '停止任务',
  'Your answer to "{question}"? Reply to this message.': '您对“{question}”的回答是？请回复此消息。',
  'Your answer': '您的回答',
  'Type your answer as a reply.': '请以回复的形式输入您的回答。',
  'Answered. The task carries on with it.': '已回答。任务将据此继续。',
  'That is too long for one question; keep it under {max} characters.':
    '一个问题不能这么长；请控制在 {max} 个字符以内。',
  '[a key, not kept]': '[一个密钥，未保存]',
  'That looks like a key, so I did not keep it or send it anywhere. Keys go in the sealed field on a card, or on their page in This deployment: tell me what it is for and I will put the card in front of you.':
    '这看起来像是密钥，所以我没有保存它，也没有发送到任何地方。密钥应填写在卡片上的加密字段中，或“本部署”中对应的页面上：告诉我它的用途，我会把卡片呈给您。',
  'No model is set up yet, so I cannot think. Choose one under This deployment, Model; then I can help with everything else.':
    '尚未设置模型，所以我还无法思考。请在“本部署 > 模型”中选择一个；之后其他事情我都能帮忙。',
  'The model did not answer: {reason}': '模型没有响应：{reason}',
  'Here is what I propose.': '以下是我的建议。',
  'I have nothing to add.': '我没有什么要补充的。',
  '{name}, CEO of {company}': '{name}，{company} 的 CEO',
  'That could not be answered: {reason}': '无法回答：{reason}',
  'I read text and voice notes.': '我可以读取文字消息和语音消息。',
  'Now talking to {name}.': '现在与 {name} 对话。',
  'Choose whom to talk to.': '请选择对话对象。',
  'Choose whom to talk to': '选择对话对象',
  'Talk to PALUGADA about the whole deployment': '与 PALUGADA 讨论整个部署',
  'Who you are talking to, and how': '当前对话对象及使用方法',
  'Stopped.': '已停止。',
  'Write here to talk to {name}.': '在这里输入即可与 {name} 对话。',
  'You are talking to {name}. Write, or send a voice note. /ceo chooses whom you talk to; /palugada talks to PALUGADA about the whole deployment.':
    '您正在与 {name} 对话。可以发文字，也可以发语音消息。/ceo 用于选择对话对象；/palugada 用于与 PALUGADA 讨论整个部署。',
  'You said: "{words}"': '您说：“{words}”',
  'in the app': '在控制台中',
  'Apply: {summary}': '应用：{summary}',
  'Nothing hears speech yet: choose a provider in the app, under This deployment, Tools, Listening.':
    '尚无语音识别服务：请在控制台的“本部署 > 工具 > 语音识别”中选择提供商。',
  'That recording is too long; keep a voice note under {max} MB.': '录音太长了；请将语音消息控制在 {max} MB 以内。',
  'I could not make out any words in that.': '我没能听清其中的任何话语。',
  'Done: {summary}': '已完成：{summary}',
  'That one is applied in the app.': '此卡片需要在控制台中应用。',
  'That card no longer exists.': '该卡片已不存在。',
  'That card was already applied.': '该卡片已应用过。',
  'That card was dismissed.': '该卡片已被忽略。',
  'That card failed when it was applied.': '该卡片应用时失败。',
  'That could not be done: {reason}': '无法完成：{reason}',
  'Choose': '选择',
  'What do you want to ask about "{title}"? Reply to this message with your question.':
    '关于“{title}”，您想问什么？请回复此消息并写下您的问题。',
  'Your answer to "{question}"? Reply to this message with your answer.':
    '您对“{question}”的回答是？请回复此消息并写下您的回答。',
  'I read text messages here.': '在这里我只能读取文字消息。',
  'Apply one of these here:': '可在此应用以下任一项：',
  'Apply {number}': '应用第 {number} 项',
  'Signed in to {provider} for the {alias} key': '已登录 {provider}，用于 {alias} 密钥',
  'Go back to PALUGADA: the division holds this key now, and it is renewed before it runs out. This tab can be closed.':
    '请返回 PALUGADA：该部门现已持有此密钥，并会在其过期前自动续期。此标签页可以关闭了。',
  'Signed in to {name}': '已登录 {name}',
  'Go back to PALUGADA to choose which of its tools roles may use. This tab can be closed.':
    '请返回 PALUGADA，选择角色可以使用它的哪些工具。此标签页可以关闭了。',
  'Not signed in': '未登录',
};

/**
 * A capability named for what it does, as the owner reads it outside the
 * console (the analysis of 3 October, §2.3 item 7).
 *
 * An approval in a chat was headed by the capability's code and its
 * arguments -- "record.delete: recordId cust-042" -- in English whatever the
 * owner reads, while the console said "Delete a record". The names are the
 * console's (`CAPABILITY_NAMES`, console/src/format.ts), which
 * `console-events.test.ts` holds the same, so a card reads alike in both.
 */
import { say } from './say.ts';

/** `name` in words, in `language`; the code itself for one the platform has no name for. */
export function capabilitySaid(language: string | null | undefined, name: string): string {
  const said: Record<string, () => string> = {
    'ads.campaign.start': () => say(language, 'Start an ad campaign'),
    'browser.act': () => say(language, 'Fill in a page in the browser'),
    'browser.handover': () => say(language, 'Ask you to take over the browser'),
    'browser.read': () => say(language, 'Read a page in the browser'),
    'calendar.hold': () => say(language, 'Block time on the calendar'),
    'calendar.read': () => say(language, 'Read the calendar'),
    'chat.read': () => say(language, 'Read a customer conversation'),
    'chat.send': () => say(language, 'Reply to a customer'),
    'code.execute': () => say(language, 'Run code'),
    'crm.note': () => say(language, 'Add a note to a customer'),
    'crm.read': () => say(language, 'Read customer records'),
    'crm.record': () => say(language, 'Record a customer or a deal'),
    'deploy.production': () => say(language, 'Release to the live site'),
    'deploy.staging': () => say(language, 'Release to the test site'),
    'dns.nameservers': () => say(language, 'Change a domain\'s nameservers'),
    'dns.read': () => say(language, 'Read a domain\'s records'),
    'dns.update': () => say(language, 'Change a domain\'s record'),
    'doc.draft': () => say(language, 'Write a document'),
    'document.sign': () => say(language, 'Sign a document'),
    'domain.purchase': () => say(language, 'Buy a domain'),
    'domain.transfer': () => say(language, 'Transfer a domain'),
    'email.draft': () => say(language, 'Draft an email'),
    'email.send': () => say(language, 'Send an email'),
    'files.list': () => say(language, 'List files'),
    'files.read': () => say(language, 'Read a file'),
    'image.describe': () => say(language, 'Describe a picture'),
    'code.compute': () => say(language, 'Calculate in Python'),
    'funds.transfer': () => say(language, 'Transfer money'),
    'goal.propose': () => say(language, 'Propose a goal change'),
    'schedule.propose': () => say(language, 'Propose a schedule'),
    'image.generate': () => say(language, 'Make a picture'),
    'invoice.issue': () => say(language, 'Issue an invoice'),
    'invoice.pay': () => say(language, 'Pay an invoice'),
    'ledger.read': () => say(language, 'Read the books'),
    'ledger.record': () => say(language, 'Record an entry in the books'),
    'mailbox.read': () => say(language, 'Read the mailbox'),
    'memory.search': () => say(language, 'Search what the company knows'),
    'metric.record': () => say(language, 'Record a measure'),
    'metrics.read': () => say(language, 'Read product numbers'),
    'owner.ask': () => say(language, 'Ask you a question'),
    'plan.record': () => say(language, 'Write down a plan'),
    'record.delete': () => say(language, 'Delete a record'),
    'repo.branch': () => say(language, 'Propose a code change'),
    'repo.read': () => say(language, 'Read the code'),
    'server.destroy': () => say(language, 'Destroy a server'),
    'skill.read': () => say(language, 'Read a skill'),
    'social.publish': () => say(language, 'Publish a post'),
    'speech.synthesize': () => say(language, 'Read text aloud'),
    'speech.transcribe': () => say(language, 'Turn speech into text'),
    'stage.propose': () => say(language, 'Propose a new stage'),
    'task.await': () => say(language, 'Wait for work handed on'),
    'task.delegate': () => say(language, 'Hand work to another role'),
    'task.follow_up': () => say(language, 'Look at it again later'),
    'ticket.create': () => say(language, 'File a ticket'),
    'ticket.list': () => say(language, 'List tickets'),
    'uptime.check': () => say(language, 'Check a service is up'),
    'web.extract': () => say(language, 'Read a web page'),
    'web.fetch': () => say(language, 'Open a web page'),
    'web.search': () => say(language, 'Search the web'),
  };
  return said[name]?.() ?? name;
}

/**
 * A title or summary the broker wrote as `capability: arguments`, with the
 * capability named in words. The arguments are the agent's and stay as they
 * are; text written any other way is left as it is.
 */
export function actionSaid(language: string | null | undefined, text: string, capabilityName: string | null): string {
  if (!capabilityName) return text;
  if (text === capabilityName) return capabilitySaid(language, capabilityName);
  if (!text.startsWith(`${capabilityName}:`)) return text;
  return `${capabilitySaid(language, capabilityName)}:${text.slice(capabilityName.length + 1)}`;
}

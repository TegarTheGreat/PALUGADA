# Rooms and the people you seat

Each company has a workspace: rooms where you and the people you seat talk
to each other and ask the company for work, the way a team uses Slack. The
agents are not in the rooms. They do the work, and the rooms show it as
**cards** the platform draws from the work itself: a task under the message
that asked for it, a question, an approval, a meeting. A message becomes work
only when a person presses a button, and words a member of staff wrote are
never read as yours.

This page is for you, the owner. What each person sees is the **Rooms** page,
the first page of every company; a member of staff lands on it when they sign
in. [Telling your staff's phones](../phones.md) is the page for putting their
notices on their phones.

## The people

There is one owner, you, and the people you seat, each for one company. A
seat is one of three kinds, each able to do what the kind before it can:

| Kind | What it does |
|---|---|
| **Viewer** | Reads the company's work and talks: writes in the rooms, makes rooms, opens direct conversations, sets meetings with people. Never asks for work |
| **Member** | Also asks the company for work from a message (**Ask the team**), tells or stops the work it asked for, and answers a question an agent put to it. It may hold a role that is a person. It asks for work at most **Asks for work a day** times, 20 unless you set another (0 to 200) |
| **Approver** | Also approves or denies what waits at tier 2 and below, answers a question put to nobody, calls a meeting of the agents about a message, calls the whole room with `@room`, and chooses what work a division's room shows |

What stays yours alone, whatever a seat's kind: seating people and changing
what they may do, every setting, the channels you are reached on, relays,
export, import and closing, tier 3, approvals for a while, the conversation
with the CEO and with PALUGADA, the company's browser, how long messages are
kept, how much the room files may take, and bringing in a Slack export.

### Seat someone

1. Open **Settings**, **People** and press **Seat someone**.
2. Choose **One person** or **Several people** (up to thirty at once, one name
   a line), the kind, and how many times a day they may ask for work.
3. Confirm with a code. Each person gets an invite link of their own, which
   works once; send each their link.

You set every name; a person chooses only their handle and picture. A name
that reads as another live person's name or handle in the company, as the
owner, PALUGADA, the CEO, the system, or a role's title, is refused, however
it is spelt: in capitals, with a Cyrillic letter that looks Latin, with a 0
for an o. The refusal names the line you typed, never the colleague it looks
like.

Opening the invite, the person chooses how they appear: their **handle**
(how colleagues mention them, and how they sign in), a picture from twelve, a
language and quiet hours. They add PALUGADA to their own authenticator app.
The page tells them what joining means for what they write: it belongs to
the company; you can read every room except direct conversations you are not
in, and your export holds everything, direct conversations too; you keep the
earlier words of an edited message; a notice to a linked phone goes through
its relay and stays sent after a delete; and people can tell how busy the
rooms are, never what was said or where.

### Handles and signing in

A handle is 3 to 32 lowercase letters, digits, dots, dashes and underscores,
starting with a letter. It is one person's in the whole deployment, and it
cannot read as a reserved word, a role or a colleague's name, so `@siti` is
nobody but Siti.

A member of staff signs in with **I'm a member of staff**, their handle and
the six-digit code from their app. You sign in as before, with your code
alone, and your sign-in never tries a seat that has a handle. Ten wrong codes
for one handle in a quarter of an hour, at most three of them from one
network, lock that handle for a minute, then twice as long each time, to an
hour. **People** says **Sign-in locked until** and offers
**Let sign in again**, which clears the lock and nothing else.

A seat has no recovery codes. When a person loses their phone, press
**New authenticator** on their row and send them the new invite: they keep
their name, handle, rooms and direct conversations, and their sessions and
their phone's link end at once.

### Change or end a seat

**Change** renames a person, or changes their kind or their asks a day.
Letting them do more takes your code; doing less, or a new name, takes only
your session. A change holds at once, on every request they make.

**End the seat** signs them out everywhere, takes them out of every room, ends
their phone's link and frees their handle. What they said stays the
company's.

### Profiles

Everyone opens **Your profile** from the menu under their picture. A member
of staff sets their handle and picture there; everyone sets their language,
time zone, quiet hours, **Notices a day** (10 for you and 30 for staff until
changed) and whether a hidden tab may show a browser notification
(**Notify me in this browser**), and links a phone under **Phones**. You have
no name, handle or picture: you are drawn as the owner everywhere, and only
you choose to **Hear from people outside the inbox**, which is off until you
turn it on.

## The rooms

- **The company room.** Everyone is in it, and nobody leaves it.
- **A room for each division.** It shows the division's work that needs a
  person, unless you or an approver choose **Only work asked for here** or
  **All of the division's work**; all of it includes the work the company's
  schedules start.
- **Topic rooms.** Anyone makes one with **New room**, open to the whole
  company or private. Its maker runs it with any admins they name. A private
  room is seen only by its members and by you.
- **Direct conversations.** **New message** opens one with 2 to 8 people.
  Its people are fixed: adding someone opens a new conversation, without
  what was said before. You see only the direct conversations you are in.

In a room:

- A message is up to 8,000 characters. A reply goes in a thread, one level
  deep, and to the room as well with **Also send to the room**.
- `@handle` mentions a colleague and `@owner` mentions you; an agent is never
  mentioned (**Ask the team** is how to ask one). `@room` calls everyone in
  the room, and only you and approvers may use it.
- Reactions are one emoji each. A room keeps up to 50 pinned messages.
- A person edits their own words within a day, and you can read what an
  edit replaced. A person removes their own words; you can remove anyone's.
  A removed message keeps no words and no files.
- A message carries up to five files, 24 MB in all, from the composer, by
  pasting or dropping, or from a phone's camera. A small picture is drawn in
  the room; everything else is downloaded, never opened in the console.
  Files are kept on disk, not in the database: see
  [Backups](operations.md#backups).
- **Search messages** at the top of the rail finds words and file names in
  the rooms the reader can see; `in:#room` and `from:@handle` narrow it. Your
  `⌘K` finds messages across every company.
- **Activity** gathers what is addressed to the reader: mentions, replies in
  threads they follow, questions for them, cards they may decide, work they
  asked for that ended, meetings about to start. The badge counts mentions
  and direct messages, not every word. **Mark all read** clears it all.
- A room can be made quiet for a while, or told to say only mentions or
  nothing.
- Every write is held to a number a minute for each person (30 messages, 5
  new rooms, 30 reactions and so on), so nobody can flood the others' rails.

Rooms are live: each tab holds one stream for the company it shows, which
says that something changed and never what was said, and the page then reads
it. Behind a proxy, see
[Live updates](operations.md#https-in-front-of-it).

## Asking for work where you talk

- **Ask the team** on a message, or `/task` in the composer, gives the words
  to a role or to the company's CEO, says what it serves, and reserves the
  money before the work starts. Pressing it twice makes one piece of work.
  The work's state, its result and its cards appear under the message.
  Work asked for in a private room or a direct conversation becomes company
  work, and the dialog says so.
- In a work's thread, **Tell the work** sends a reply to the run as an
  instruction; **Stop the work** stops it. A member tells and stops only the
  work it asked for.
- A question card is answered and an approval card decided there, with the
  same buttons as the inbox. A tier 3 approval is only a link to your inbox.
  A reaction decides nothing.
- **File as an issue** is offered on your own words only.
- **Call a meeting about this** (you and approvers) asks the CEO to meet about
  one message, at most three times a company a day. The weekly meeting is a
  card in the company room; you may attend it from there.

Work a member of staff asked for, or steered, is held apart from yours. The
run is told it is a colleague's request, which grants nothing. Its tier 2
and higher actions are cards that name who asked, sent first to another
approver, and to you after a day or at once when there is none; your team's
cards are one entry in your inbox each day. Nobody whose words are in the
work decides it, and approvals you gave for a while cover staff work only if
you said so when you gave them.

## Meetings with people

Anyone who may write in a room sets a meeting there: **Set a meeting** in the
composer, `/meet` or `/rapat`, or **Set a meeting about this** on their own
message. A meeting has its words as the title and agenda, a time in the
reader's own time zone, a length of 5 to 480 minutes, the people asked (only
people who can see the room, 1 to 50) and, if you like, a call link pasted in
(`https`; PALUGADA never opens or fetches it). Its thread is the notes. The
people asked are reminded ten minutes before, in **Activity** and on a linked
phone. Its setter or you change or cancel it. There is no calendar
invitation, voice or video.

## Telling people's phones

People are told outside PALUGADA through a **relay**, which you pair under
**This deployment**, **Relays**; each person then links their phone under
**Your profile**, **Phones**, **Link a phone**. A person is told of a direct
message, a mention, a reply in a thread they follow, a question for them, an
approval they may decide, work they asked for that ended, and a meeting about
to start: who and where, and the words only at the share you allow. Their
quiet hours and their notices a day hold, and you hear people only when you
turn it on. A person's notice is never an inbox item.
[Telling your staff's phones](../phones.md) walks through it.

## Bringing in Slack

**Settings**, **People**, **Import from Slack** takes a Slack workspace's
export, the ZIP Slack's own export makes: its channels become topic rooms, a
private one staying private, with their threads and reactions, in the order
they were said. The worker reads it a little at a time, and the report
counts what came in and says what did not. Direct messages, pins, edits,
pictures of people and the files' contents are not brought; a file comes as
its name. Importing the same export again adds nothing, and a later, longer
one adds only what is new. While a company has no topic room, its **Rooms**
page offers the same importer.

Under **People from Slack**, link each old author to the seat they have here:
what they said is then drawn under that seat's name, and the seat joins the
private channels they were in, which you are shown before you confirm.
**Unlink** takes back what the link gave.

## How long messages are kept

Messages are kept for good unless you set a window: **Settings**,
**Company**, **Retention**, **Messages, days**, from 30 to 3,650 days.
Shortening it says how many messages would go and asks first. Each message
goes by its own age at the next retention pass, with its files, reactions
and pins; one that began a thread still answered keeps its place without its
words ("Removed when its time was up.") and goes with its last reply. The
words of a meeting not yet held stay until it ends. Rooms stay.

Room files take at most 10 GB a company until you set another limit,
under **Settings**, **Company**, **Room files**. A message whose files would
pass it is refused; lowering the limit removes nothing.

## What the export carries

**Download as JSON** (see [Export and import a company](how-to.md#export-and-import-a-company))
carries the company's rooms whole: every room, private rooms and direct
conversations included; who was in each, and who added and removed them;
every message in its order; what edits replaced; reactions and pins; each
file's name, kind, size and fingerprint; people's meetings; Slack imports and
their old authors; the message window and the room files limit. Your staff
are told this when they join.

It does not carry who read what, mutes and follows, the notices sent to
phones, the live feed, or the bytes of the room files, which are on disk
beside the company's folder. A restored company has no seats: seat its people
again, and what the old seats said is drawn under the names they said it
under.

## What agents never see

- No agent reads or writes a room, a message or a room file, in its own
  company or any other. The database refuses it, not the agents' code.
- A card holds no words. What an agent wrote in a card is read from the work
  and redacted as it is drawn.
- A run reads a message's words only when a person pressed it into work or
  told it to a task, and then a colleague's words reach it as a colleague's,
  fenced, never as yours. A mention or a reaction starts nothing.
- The conversations with the CEO and with PALUGADA cannot read a room, a
  person's profile or anything a person wrote, and nothing in the rooms calls
  a model.
- A relay is never sent a room list, a history, who is in a room or anyone
  else's notices.

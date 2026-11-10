/**
 * What the people's workspace routes answer with (F19; the workspace plan).
 *
 * The rooms' server and the rooms' console are built side by side against
 * these shapes, so they are written down before either: plain types, no
 * imports and no values. `console/src/workspace/types.ts` is the same file
 * for the console, which is built from its own folder and cannot import this
 * one; `test/documents/workspace-contract.test.ts` holds the two to the same
 * types and fields.
 *
 * Principals are text (`'owner'`, `'seat:<uuid>'`, and for an imported
 * author `'former:<source>:<id>'`), times are ISO strings, positions are
 * numbers. Nothing here carries a person's read mark or mute but the
 * person's own: a colleague's is not anyone's to read.
 */

/** A person as a room draws them: the owner has no name of their own (drawn as the owner) and no handle. */
export type PersonRef = { principal: string; name: string | null; handle: string | null; picture: string | null };

/** One of the company's people, as the people list shows them; their kind is shown to the owner only. */
export type Person = PersonRef & { kind?: 'viewer' | 'member' | 'approver'; linked: boolean };

/** What waits in one company: mentions, direct messages, rooms with unread, and the owner's open items (null for a seat). */
export type Unread = { companyId: string; mentions: number; direct: number; rooms: number; openCount: number | null };

/** A room in the rail. `people` is for a direct room only, which has no name. */
export type RoomListItem = {
  id: string; kind: 'company' | 'division' | 'topic' | 'direct'; name: string | null; divisionId: string | null;
  private: boolean; people: PersonRef[] | null;
  unread: number; mentions: number; notify: 'all' | 'mentions' | 'none'; mutedUntil: string | null;
  lastPosition: number; joined: boolean; archived: boolean;
};

/** A room opened: its members (and no one's read mark or mute), its pins, and the code of the line that says who can read it. */
export type Room = RoomListItem & {
  about: string | null; showsWork: 'asked_here' | 'needs_people' | 'all'; createdBy: string;
  members: Array<PersonRef & { role: 'member' | 'admin'; joinedAt: string }>;
  pins: string[]; disclosure: string;
  may: { rename: boolean; archive: boolean; addPeople: boolean; showsWork: boolean; mentionRoom: boolean };
};

/** A file a message carries. `inline` is true only for a small picture the console may draw. */
export type FileView = { id: string; name: string; mime: string; bytes: number; inline: boolean };

/**
 * A card: work, a question, an approval or a meeting, drawn from its rows
 * when shown. It holds no words of its own; a result is read from the task,
 * redacted, and shown as written by its role.
 */
export type CardView = {
  kind: 'work' | 'question' | 'approval' | 'meeting'; taskId: string | null; itemId: string | null;
  state: string; whyStopped: string | null; askedBy: PersonRef | null; goal: string | null;
  role: { id: string; label: string; picture: string } | null;
  lastLine: string | null; result: string | null;
  deliverables: Array<{ id: string; title: string }>;
  question: { text: string; options: string[]; addressee: PersonRef | null; hidden: boolean; endsAt: string | null } | null;
  approval: { tier: number; title: string; summary: string; consequence: string | null } | null;
  meeting: { week: string; agenda: Record<string, number>; joined: boolean; joinMinutes: number | null } | null;
  may: { answer: boolean; decide: boolean; stop: boolean; tell: boolean; join: boolean }; inInbox: boolean;
};

/** A meeting people set in a room: a time, the people asked, a pasted call link. */
export type PeopleMeetingView = {
  id: string; startsAt: string; minutes: number; attendees: PersonRef[]; callUrl: string | null;
  setBy: PersonRef; cancelled: boolean; may: { change: boolean };
};

/** A message: a person's words, a card, or a coded notice the console says in the reader's language. */
export type MessageView = {
  id: string; position: number; roomId: string; threadOf: string | null; alsoInRoom: boolean;
  kind: 'text' | 'work' | 'question' | 'approval' | 'meeting' | 'notice';
  author: PersonRef | { principal: 'platform' } | { principal: string; former: true; name: string };
  body: string | null; notice: { code: string; values: Record<string, unknown> } | null;
  mentions: PersonRef[]; mentionsRoom: boolean; via: 'console' | 'relay' | 'platform' | 'import';
  became: 'work' | 'instruction' | 'meeting' | null; card: CardView | null;
  reactions: Array<{ emoji: string; count: number; mine: boolean }>;
  replies: { count: number; lastAt: string | null } | null; files: FileView[];
  peopleMeeting: PeopleMeetingView | null;
  edited: boolean; deleted: boolean; expired: boolean; createdAt: string;
  may: { edit: boolean; delete: boolean; pin: boolean; giveAsWork: boolean; tell: boolean; stop: boolean;
         callMeeting: boolean; fileAsIssue: boolean; history: boolean };
};

/** A page of a room, with the reader's own mark. */
export type MessagePage = { messages: MessageView[]; readPosition: number; hasBefore: boolean; hasAfter: boolean };

/** A thread: its root and replies; work threads also carry the work's last line, redacted. */
export type ThreadView = { root: MessageView; replies: MessageView[]; following: boolean; progress: string | null };

/**
 * What asks for a person's attention, newest first. A message in a thread
 * names its thread, so it opens where it is read, and is seen there.
 */
export type ActivityItem =
  | { kind: 'mention' | 'reply' | 'card'; roomId: string; messageId: string; threadOf: string | null; at: string; seen: boolean }
  | { kind: 'question' | 'team_item'; itemId: string; taskId: string | null; at: string }
  | { kind: 'work_done'; taskId: string; state: string; at: string };

/** A message found by a search. */
export type SearchHit = {
  roomId: string; messageId: string; threadOf: string | null; position: number; excerpt: string; author: PersonRef; at: string;
  file: FileView | null;
};

/**
 * A frame of a person's room stream. It carries ids and positions, never
 * words: the words are fetched under the person's own session. `work` is the
 * company's work stream's frame, carried on the same stream so a tab holds one.
 */
export type RoomFrame =
  | { position: number; kind: 'message' | 'edit' | 'delete' | 'reaction' | 'pin' | 'member' | 'read' | 'room' | 'card'; room: string; ref: string | null; mentioned?: boolean }
  | { kind: 'work'; id: string; type: string; taskId: string | null; actor: string; at: string }
  | { kind: 'reset' } | { kind: 'ceo' };

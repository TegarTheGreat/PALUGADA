# PALUGADA relay protocol, version 1

This is the protocol a relay speaks with a PALUGADA deployment: what the
deployment sends it, what it may send back, and how each side proves who it
is. It is written for whoever builds a relay -- a phone app's backend, a
bridge to a push service, the reference relay in `scripts/relay-reference.ts`
-- and it is the whole of what PALUGADA expects. Requirements: PRD F19.19 and
F19.20; how it was built: `docs/STATUS.md` section 2.208.

The key words MUST, MUST NOT, SHOULD and MAY are used as RFC 2119 uses them.

## 1. What a relay is, and is not

A relay tells people's phones what PALUGADA has for them. PALUGADA tells it
what a person is owed -- an approval they may decide, a question, an
incident, work done, a digest -- at that person's share level, and takes back
a small set of acts, each of which redeems a token that came with a notice to
that same person.

**v1 is a notifier, not a mirror.** A relay is never sent a room list, a
history, a membership, or another person's items; a room appears to it, if at
all, only as an opaque id inside a link. Reading, scrolling back and choosing
what to open happen in PALUGADA itself, which every notice links to. A mirror
can be added inside v1 later, because v1 only ever adds (section 11).

**Never sent:** secrets, file bytes (a link at most), prompts, transcripts,
what customers wrote, room lists, history, membership, or another person's
items.

**Never accepted:** an assignment, an instruction, anything at tier 3, a
standing approval ("yes for a while"), a schedule, a meeting, a room or a
membership, a setting, a seat, a pairing, or an export. There is no type for
any of them, and a type PALUGADA does not know is refused.

## 2. Parties and keys

| Party | Identity |
|---|---|
| Deployment | An Ed25519 key pair. The deployment publishes the public key; its private seed is sealed under the deployment's master key and never leaves it. The deployment is named by its `deployment` id, a UUID. |
| Relay | Its own Ed25519 key pair, published in its well-known document (section 4) and pinned by the deployment when the owner adds the relay. |
| Device | Optional: an Ed25519 key a person's phone makes and gives when it links. When a link has one, every act for that link MUST carry the device's signature (section 8). |
| Person | Never on the wire by name (section 2.2). |

### 2.1 Key formats

- **A public key** is the raw 32 bytes of an Ed25519 key, written in base64url
  without padding.
- **A key id** (`kid`) is the first 16 hexadecimal digits of the SHA-256 of
  the raw key.
- **A fingerprint** is the SHA-256 of the raw key in RFC 4648 base32, upper
  case, without padding, cut to its first 24 characters (120 bits). People
  read it in groups of four. When the owner pairs a relay they type at least
  its first 16 characters (80 bits).
- **A seed** is the 32-byte private Ed25519 seed. In PKCS #8 DER it is
  `302e020100300506032b657004220420` followed by the seed.

### 2.2 Pseudonyms

Each relay has a 32-byte salt of its own, which PALUGADA keeps and never sends.

- A person is `recipient = base32(HMAC-SHA256(salt, principal))[:26]`, where
  `principal` is `owner` or `seat:<uuid>`.
- A company is `ref = "co_" + base32(HMAC-SHA256(salt, company id))[:16]`,
  the company id written as a lower-case UUID.

The HMAC is keyed with the salt's 32 bytes and taken over the UTF-8 bytes of
the text; `base32` is that of section 2.1 (RFC 4648, upper case, no padding).

So a relay sees the same person as the same recipient every time, and two
relays cannot join what each knows.

### 2.3 Rotating the deployment's key

The owner may give the deployment a new key. For seven days after, every
envelope carries two signatures, the new key's and the old one's, and every
paired relay is sent a `keys_rotated` envelope that both sign. A relay MUST
take the new key only from a `keys_rotated` that

- verifies with the key it pinned now -- not a key rotated out and still in
  its week, which whoever rotated it away from may hold;
- verifies with the key it names, so the deployment is shown to hold it; and
- names, as `previous.key`, the key the relay pinned now.

It then pins the new key and keeps accepting the one it replaces until the
`until` the envelope names, never more than seven days on, and SHOULD stop
after. A rotation signed by the old key alone is refused: otherwise whoever
kept the old key could, in its week, announce a key of their own and be
pinned for good.

### 2.4 The deployment's identity

Anyone may read the deployment's public key at
`GET /api/relay/v1/identity` on the deployment:

```json
{ "v": 1, "versions": [1], "deployment": "<uuid>", "key": "<base64url>", "kid": "<16 hex>",
  "fingerprint": "<24 base32>", "previous": { "key": "…", "kid": "…", "until": "<ISO 8601>" } }
```

`previous` is `null` except in the week after a rotation (section 2.3). The
owner sees the same fingerprint in the console and gives it to the relay's
operator; a relay MUST NOT trust this document alone, since whoever answers
it could be anyone between the relay and the deployment.

## 3. Canonical JSON

Every body either side signs is the canonical JSON of RFC 8785 (the JSON
Canonicalization Scheme):

- object keys sorted by their UTF-16 code units, each once;
- no whitespace;
- strings escaped only where JSON must: `"`, `\` and the control characters,
  with `\b`, `\t`, `\n`, `\f`, `\r` where they apply and lower-case `\u00XX`
  for the rest; every other character as itself, in UTF-8;
- numbers as ECMAScript writes them (`JSON.stringify` of a finite number);
  `-0` is `0`;
- a field whose value is absent is not written.

What has no canonical form is refused rather than written some way: a number
that is not finite, and a string that is not well-formed UTF-16.

Because the body is canonical, a relay that parses an envelope, stores it,
forwards it or writes it out with its own library can make the same bytes
again from what it parsed and verify the signature end to end.

## 4. Signatures

Both sides sign in the asymmetric form of Standard Webhooks, `v1a`: Ed25519
over

```
<id>.<timestamp>.<payload>
```

where `id` is the message id, `timestamp` the time of signing in whole seconds
since the epoch, and `payload` the exact bytes of the body (or, for a pull,
the request line, section 9). They travel as headers:

| Header | Value |
|---|---|
| `webhook-id` | the message id: 1 to 128 visible ASCII characters (`!` to `~`) |
| `webhook-timestamp` | the time of signing, in seconds |
| `webhook-signature` | `v1a,` and the 64-byte signature in standard base64 with padding (RFC 4648 section 4); while a key is rotated, a second one after a single space |
| `palugada-key` | the `kid` of the deployment's current key (deployment to relay only) |
| `palugada-relay-version` | `1` (deployment to relay only) |
| `content-type` | `application/json` |

A receiver takes a message when any one of its signatures verifies with a key
it holds for the sender. It MUST refuse a message none of whose signatures
verifies, and one signed more than 300 seconds from its own clock, either
way. A receiver MUST NOT take an HMAC (`v1`) signature in place
of a `v1a` one.

## 5. Discovery and pairing

1. The owner gives PALUGADA the relay's address: `https://`, or `http://`
   only on the deployment's own machine.
2. PALUGADA reads `GET <url>/.well-known/palugada-relay`, which answers:

   ```json
   {
     "v": 1,
     "relay": "Name shown to the owner",
     "key": "<the relay's public key, base64url>",
     "versions": [1],
     "envelopes": "<url>/v1/envelopes",
     "inbox": "<url>/v1/inbox",
     "modes": ["push", "pull"],
     "features": ["press", "reply", "read", "device-keys"]
   }
   ```

   `envelopes` and `inbox` MUST share the scheme, host and port of the
   address the owner gave. `inbox` is optional; without it the relay is
   pushed to and posts back (push mode). PALUGADA pins `key` and shows its
   fingerprint.
3. The relay's operator shows the owner the relay's fingerprint. The owner
   types at least its first 16 characters, names the companies the relay may
   hear about (or chooses every company, later ones too, deliberately), and
   proves a second factor given now.
4. PALUGADA posts a `pair_request` (section 6) to `envelopes`, signed with
   its key. The relay MUST answer `200` with the body

   ```json
   { "pair_accept": { "request": "<the request's id>", "deployment": "<its deployment>", "relay": "<its relay>", "at": "<ISO 8601>" } }
   ```

   signed with the relay's own key in the `webhook-id`, `webhook-timestamp`
   and `webhook-signature` headers of the answer. An accept naming another
   request, another deployment or another relay id, one signed by another key
   than the one pinned, or one not signed now, is refused, and the relay
   stays unpaired: an accept cannot be carried over from another pairing.
5. The relay is paired. What it is told starts at `signal`, with presses and
   replies off; widening any of it takes the owner's factor again, and
   narrowing voids at once whatever it no longer allows.

A relay SHOULD pin the deployment by the fingerprint its operator was given,
and refuse a `pair_request` whose key does not match it. Once paired, it
SHOULD refuse any other `pair_request` until its operator resets it by hand.

**Revocation** is immediate: everything the relay signs is answered `401`,
its offers are void, what it was owed and not yet sent is dropped, and every
link through it ends. A relay that answers an envelope with `410` has
forgotten the deployment; PALUGADA stops sending to it and asks the owner to
pair it again.

## 6. What PALUGADA sends

Each envelope is one canonical JSON object, `POST`ed alone to the relay's
`envelopes` address with the headers of section 4. Its fields:

| Field | Always | Meaning |
|---|---|---|
| `v` | yes | `1` |
| `id` | yes | the envelope id, also `webhook-id` (section 7) |
| `type` | yes | one of the types below |
| `at` | yes | when it was made, ISO 8601 |
| `deployment` | yes | the deployment id |
| `relay` | yes | the relay's id at the deployment |
| `to` | for a person | `{ "recipient": "<pseudonym>" }` |
| `company` | for a company | `{ "ref": "co_…" }`, and `name` above `signal` |
| `share` | for a person | `signal`, `summary` or `content` |
| `urgency` | for a person | `interrupt`, `normal` or `quiet` |
| `lang` | for text | the language `text` is in, as a BCP 47 tag |
| `text` | for a person | a sentence in that language, for a relay that renders nothing itself |
| `link` | for a person | where it opens in PALUGADA, or `null`; it carries `?company=&item=`, `&task=`, or `&room=&thread=` |
| `data` | per type | what the share level allows, below |
| `offers` | `inbox_item`, `room_activity` | `[{ "token", "act", "label" }]`: what the person may press or send back (sections 8 and 9) |

A relay MUST ignore a field it does not know, and SHOULD ignore an envelope
type it does not know.

### 6.1 Share levels

What a person is told is the lower of the relay's level and their own:

- `signal`: that something happened, how urgent, and where it opens. No
  company name, no title, nothing to press.
- `summary`: adds the company's name, the title (with any secret in it
  redacted), and the buttons the person may press.
- `content`: adds what the item says: the action, the question and its
  choices, a digest's or a finished task's text, and for a person's notice
  about a room an excerpt of the words (at most 140 characters, with any
  secret in it redacted).

A person's notice about a room (`room_activity`) says at `signal` only why
and how many, with its read mark and mute; at `summary` the company, the
room's name and who wrote, by name and handle; and the words only at
`content`. A meeting about to start (`meeting_soon`) says at `signal` only
that a meeting is soon; at `summary` the company, the room's name and when
it starts; and the title its setter wrote only at `content`.

### 6.2 Urgency

| Value | When | The relay may |
|---|---|---|
| `interrupt` | an incident, or an approval at tier 3 | ring the phone |
| `normal` | something the person may decide or answer, or a notice addressed to them: a direct message, a mention, a reply in a thread they follow, a question put to them, an approval they may decide, work they asked for done, a meeting they were asked to about to start | show a notification |
| `quiet` | everything else | nothing that sounds |

### 6.3 Types

#### `pair_request`

Sent once, at pairing (section 5), and never through the outbox.
`{ v, id, type, at, deployment, relay, key, kid, fingerprint, versions, name }`.
`id` is fresh for each pairing attempt.

#### `ping`

The owner pressed "Send a test". `text` says so. Not addressed to a person.

#### `link_confirmed`

A link stands (section 8). `to` names the person; `data` is
`{ "claim": "<the link_claim envelope's id>", "companies": ["co_…"], "device": true|false }`.

#### `keys_rotated`

The deployment's key changed (section 2.3). `{ key, kid, fingerprint, previous: { key, kid, until } }`,
signed with both keys. A relay takes it only when the key it pinned now and
`key` both verify it, and `previous.key` is the key it pinned now.

#### `inbox_item`

Something in the owner's inbox. `data` is `{ kind, tier }` at `signal`; adds
`title` at `summary`; adds `summary`, `ifDenied`, `expiresAt` and, for a
question a run asked, `question`, `options` and `asker`, at `content`.
`offers` carries what may be pressed:

- an approval at tier 2 or below, and anything else a chat may act on:
  `approve` and `deny`;
- a run's question: `answer` in words, and at `content` one `answer` for each
  of its choices, labelled with the choice;
- an incident, an approval at tier 3, and anything a chat may only link to:
  nothing, at every share level.

Offers are made only at `summary` and above, only when the owner turned
presses on for the relay, and only to a link that has a device key.

#### `inbox_closed`

An item the relay was told of has closed: decided in the app or elsewhere,
expired, or withdrawn. `data` is `{ "ref": "<the inbox_item envelope's id>" }`;
`text`, above `signal`, says how it closed. Every offer for it is void, and a
relay MUST drop the content it holds for `ref`.

#### `work_done`

Work the owner gave has finished. At `summary`, `text` is its headline; at
`content`, its account (redacted).

#### `digest`

The owner's daily digest of a company. `data` is `{ day }`; `text` says it is
ready at `signal`, names the company at `summary`, and is the digest at
`content`.

#### `room_activity`

A person's own notice about words in a room: someone wrote to them in a
direct conversation, mentioned them, or replied in a thread they follow.
Never about their own words; one per room in ten minutes, its `count` the
messages it stands for; and only about a room the person may still see.
`data` is `{ "reasons": ["direct" | "mention" | "reply"], count }` at
`signal`; adds `room` (its name, or `null` for a direct conversation) and
`authors` (`[{ name, handle }]`, `name` null for the owner) at `summary`; adds
`excerpt` at `content`, which `text` also carries on its second line. `link`
opens the room and thread. `urgency` is `normal`.

`offers` are tokens for that room, thread and moment alone, good for seven
days: `read` and `mute` (five uses each) at every share, and `reply` (twenty
uses) above `signal` when the owner allowed replies through the relay. None
are made for the owner's link without a device key. Section 9 says how each
is sent back.

A seat is told of agent work through the types the owner's items use:
`inbox_item` for a run's question put to them (`answer` offers, as above) and
for an approval of the team's they may decide (`approve` and `deny`, never to
a seat whose own words are in the work), and `work_done` for work they asked
for, which `text` says is done or why it stopped. Their `text` names the room
of an approval only to someone who can see it.

#### `room_activity_retracted`

Words a person was told of were deleted in PALUGADA, or their time was up.
`data` is `{ "refs": ["<envelope id>", …] }`: every `room_activity` the relay
was sent, or may have read before it refused it, that carried them, and every
`meeting_soon` whose title they were. A relay MUST drop what it holds of each
(section 10). An envelope that had not been sent when the words went is not
sent at all, and its tokens are void.

#### `meeting_soon`

A meeting the person was asked to starts in ten minutes. People set it in a
room of PALUGADA, with a time, a length and the people asked; its title and
agenda are a message its setter wrote there, and its thread is the notes.
Sent once for each time it is set for, only while the person may still see
the room, and never for a meeting cancelled, begun, or whose message was
removed. `data` is `{}` at `signal`; adds `room` (its name, or `null` for a
direct conversation), `startsAt` (ISO 8601) and `minutes` at `summary`; adds
`title` (the setter's words, at most 140 characters, with any secret in them
redacted) at `content`, which `text` also carries on its second line. `link`
opens the meeting's thread. `urgency` is `normal`, and `offers` is always
empty. The meeting's call link is never sent: the person opens it from the
thread.

## 7. The outbox and delivery

- **The id is fixed.** An envelope's id is a UUID made from the SHA-256 of
  `deployment`, `relay`, the link's id (empty when the envelope is for no
  link), the type, what it is about and a version (`1`, in decimal), joined
  by line feeds and hashed as UTF-8: the first 16 bytes, with the high nibble
  of byte 6 set to 8 (RFC 9562's custom version) and the top two bits of
  byte 8 set to `10` (the RFC 4122 variant), written in lower-case hex as
  8-4-4-4-12. A relay never needs to make one; the test vectors show how. The same notice is the same id however often it
  is sent, so a relay drops a repeat by its `webhook-id`.
- **Delivered** is a `2xx` answer, or `409`, which a relay MAY answer for an
  id it already has.
- **Anything else is tried again** under the same id, after 30 seconds, then
  1, 2, 4, 8, 16 and 32 minutes. After eight attempts the envelope is given
  up and shown to the owner, who may send it again.
- **A send cut off** -- the deployment stopped before it learned the answer --
  is sent again after ten minutes, under the same id.
- **Order** is kept for each person: a later envelope for one link waits
  behind an earlier one still owed, and behind one being sent, by this
  process or another.
- **What is owed follows the owner's settings.** An envelope not yet sent
  when the owner narrows what a relay is told is made again at the new
  share, without the offers no longer allowed, under the same id; one for a
  company the relay no longer hears about is not sent. A notice of an item
  that closed before it was sent is not sent at all, and nor is its
  `inbox_closed`.
- **A message deleted is not sent.** A `room_activity` owed for words deleted
  since, or taken when their time was up, is never sent, whenever it was
  owed or tried, and is dropped; a relay that had it, was being sent it, or
  was tried with it, is sent `room_activity_retracted`. So is a
  `meeting_soon` whose title was those words.
- Each send has five seconds. Sending runs in a loop of its own, never in the
  path of a request or of the work, and runs while the owner has stopped
  everything.

## 8. Linking a person's device

No link, nothing is sent on that person's behalf.

1. In PALUGADA, the person asks to link a phone through a relay. They are
   given a code of 8 base32 characters, valid for ten minutes, and a QR code
   of `palugada-link:<code>`. The owner's link takes a second factor given
   now.
2. The person enters the code in the relay's app. The relay sends a
   `link_claim` (section 9), with a device key when its app makes one.
3. PALUGADA answers with the person's recipient and the companies the link
   hears about, by reference, and sends `link_confirmed`.
4. A link ends by `link_end` from the relay, by the person or the owner in
   PALUGADA, or when the seat or the relay is revoked.

A code is good at the relay it was offered through and no other, and once.

**The device form.** When a link has a device key, every act for it MUST
carry `device_sig`: the device's Ed25519 signature, in base64url without
padding, over the bytes

```
palugada-device/v1\n<canonical JSON of the fields>
```

in UTF-8, where `\n` is one line feed and the fields are `deployment`,
`relay`, `recipient`, `type`, `at` (the act's own `at`), and, where they
apply, `token`, `sha256` (the lower-case hex SHA-256 of the UTF-8 of the free
text the act carries: an answer, or a reply's words), `clientId` (a reply's)
and `until` (a mute's, `null` included). A relay holding only its own key
therefore cannot make an act.

The device signs `at` when the person acts, and the deployment takes the act
only within 300 seconds of it, as it takes a relay's signature: a relay
cannot keep a signed act and send it later. A `link_end` must also be signed
no earlier than the link it ends was made, so the end of an earlier link
made with the same device key ends nothing now. A relay MUST therefore send
an act as soon as the person makes it, and a device SHOULD keep its clock
right.

**The owner's link needs a device key to act.** Without one the owner is still
told, but no offer to press is made, and nothing sent for that link counts
except `link_end` (`relay.owner_device`). A stolen relay key can therefore
neither decide nor write in the owner's name.

## 9. What a relay sends

**Push.** `POST /api/relay/v1/relays/<relay id>/inbound` on the deployment, one
envelope a request, at most 64 KiB, signed with the relay's key in the headers
of section 4. It is throttled before anything is read: sixty requests a minute
from one address and six hundred for the route as a whole, then, once the
signature has verified, sixty a minute for the relay.

**Pull**, for a deployment the relay cannot reach. The deployment asks

```
GET <inbox>?after=<cursor>&wait=25
```

with `webhook-id`, `webhook-timestamp` and `webhook-signature` signed by the
deployment over the request line, `GET <path>?<query>`, as it appears. The
relay MUST answer only a request that verifies with the deployment's key, and
answers, as soon as it has something or after `wait` seconds,

```json
{ "envelopes": [ { "id": "…", "timestamp": "…", "signature": "v1a,…", "body": "<canonical JSON>" } ], "cursor": "<opaque>" }
```

`after` is omitted on the first pull. A relay MUST answer at most 100
envelopes to one pull, and at most 8 MiB (8,388,608 bytes) in all; the
deployment takes none of an answer with more, and stops reading one at its
8 MiB. A relay with more waiting answers fewer, and the rest at the next pull.
The deployment waits for an answer for `wait` seconds and ten more. Each
envelope is taken exactly as if it were pushed, the relay's sixty a minute
included, and the next pull names the new cursor.

The cursor belongs to the relay and says nothing about one envelope, so the
deployment moves it only once it is done with the whole answer. When the
relay's minute fills part way through, the deployment stops, keeps the cursor
it named, and does not pull that relay again until the minute has room; it
then names the same cursor, and what it took the first time is answered as a
repeat (section 9.1, step 3) without counting against the minute. A relay MUST
therefore answer a cursor it has given before with the same envelopes, and
keep an envelope until a later cursor is named.

### 9.1 The checks, in order

1. The relay exists and is paired; otherwise `401`.
2. The signature verifies with the relay's pinned key (`401`), within 300
   seconds (`408`). Nothing is written for an unknown relay or a bad
   signature; it is only counted.
3. The envelope id is new. A repeat is answered as the first one was; a new
   one counts against the relay's sixty a minute (`429`).
4. The person: the link a token or a recipient names is this relay's and
   active (`410` when it ended), and its company is one the relay hears
   about.
5. The device: `device_sig` for a link with a device key; for the owner's
   link without one, only `link_end`.
6. The type.

Every inbound body is `{ "v": 1, "type": "…", "at": "<ISO 8601>", … }`.

### 9.2 Answers

| Status | Body | When |
|---|---|---|
| `200` | `{ "ok": true, "result": … }` | taken; a press also carries `text`, "Decided through" the relay's name, in the person's language |
| `401` | `{ "ok": false, "code" }` | unknown or revoked relay, bad signature |
| `408` | `{ "ok": false, "code": "relay.stale" }` | signed more than 300 seconds from now |
| `409` | `{ "ok": false, "code": "inbox.not_open", "text" }` | a press for an item that has closed: `text` says how, in the person's language, and nothing changes |
| `410` | `{ "ok": false, "code": "relay.link_ended" }` | the link has ended |
| `422` | `{ "ok": false, "code" }` | refused, by one of the codes below, or by the inbox's own rule (such as `approval.own_instigation`: four eyes) |
| `400`, `500` | `{ "error", "code" }`, without `ok` | the deployment failed for a reason that is no answer to the envelope: nothing it asked for was done, and the same envelope, sent again under its id, is taken afresh |
| `429` | `{ "ok": false, "code": "relay.throttled" }` | too many |

A press refused at tier 3 also carries `text`, saying that tier 3 is decided
in the app, in the person's language.

The `422` codes: `relay.unknown_type`, `relay.press_off`, `relay.press_unknown`,
`relay.press_spent`, `relay.press_tier3`, `relay.device_sig`,
`relay.owner_device`, `relay.not_member`, `relay.seat_changed`,
`relay.post_off`, `relay.link_unknown`, and `relay.malformed` for a body
holding text PALUGADA cannot keep (the NUL character, `\u0000`, anywhere in a
name or a value). An answer never repeats what an item says.

### 9.3 Types

#### `press`

`{ token, answer?, device_sig? }`, `answer` at most 2,000 characters. Presses
an offer: it MUST be one sent to this person through this relay, unused,
unexpired and not void, and presses MUST be on for the relay. It is checked
again in full when it arrives: an item at tier 3 is refused
(`relay.press_tier3`) even with a valid token; a seat is read again as it is
now -- joined, not revoked, an approver to approve or deny, a member or an
approver to answer what is put to it (`relay.not_member`,
`relay.seat_changed`) -- and no seat decides work its own words are in. It is
recorded as a decision from a chat, on the phone through the relay. An
`answer` offer with a choice answers with that choice, whatever `answer`
says; one without takes `answer`. Pressing one button of an item spends the
others sent with it.

#### `reply`

`{ token, body, clientId, device_sig? }`: words in reply to a notice about a
room, `body` 1 to 4,000 characters and `clientId` 1 to 64, by which a reply
sent twice is one message. Only while the owner allows replies through the
relay (`relay.post_off`), and only with a `reply` token sent to this person
through this relay, unspent and unexpired (`relay.press_unknown`,
`relay.press_spent`). It lands in the room and thread the token names, and
no other, whatever else the body says: a plain message from that person,
marked as come through the relay. It is never work, never an instruction to
work, and never the owner's words given as work; the person must still be in
the room. Answered with `{ message }`, the message's id.

#### `read`

`{ token, device_sig? }`: a read mark, to the moment the notice named, in
its room or its thread, as if the person had read it in PALUGADA, where the
badges on every one of their devices move with it. Answered with
`{ readPosition }`.

#### `mute`

`{ token, until, device_sig? }`: the notice's room muted until `until`, an
ISO 8601 time at most thirty days ahead, or heard again with `null`. A muted
room tells nobody of its words through a relay, except a mention. Answered
with `{ mutedUntil }`.

#### `link_claim`

`{ code, label, device_key? }`: the code a person entered (section 8), the
name of their device, and its public key. Answered with
`{ recipient, companies }`. A code not offered through this relay, already
claimed or past its ten minutes is `relay.link_unknown`.

#### `link_end`

`{ recipient, device_sig? }`: the person ended the link on the relay's side.
Its offers end with it.

#### `ack`

`{ ids }`: informational; the relay saw these envelopes.

## 10. Content a relay holds

A relay MUST drop the content of an envelope a retraction names
(`inbox_closed`, `room_activity_retracted`), and SHOULD keep content no
longer than fourteen days. A
topic on a public ntfy server is readable by anyone who knows its name: a
relay that forwards to ntfy SHOULD use a self-hosted or token-protected ntfy
for any share above `signal`.

## 11. Versioning

- `v` is an integer, and paths carry `/v1/`.
- Within v1, fields and types are only ever added. Both sides ignore fields
  they do not know; a relay ignores outbound types it does not know;
  PALUGADA refuses inbound types it does not know.
- `versions` is exchanged at pairing, and both sides speak the highest they
  share.
- A v2, when there is one, is served beside v1 for at least six months.

## 12. The reference relay

`scripts/relay-reference.ts`, run with `npm run relay:reference`, is a relay
in one file of Node with no dependencies. It pins the deployment by the
fingerprint it is given (`--deployment-fingerprint`, required), takes no
second pairing until its state file is deleted, is pulled from, verifies every
envelope, takes a new key only as section 2.3 says, prints it, drops retracted content, and forwards `text` and `link`
to ntfy (`RELAY_NTFY_URL`, `RELAY_NTFY_TOKEN`) at priority 5 for `interrupt`,
3 for `normal` and 2 for `quiet`. Its commands `link <code>`,
`press <token> [answer]`, `reply <token> <text>`, `read <token>` and
`mute <token> [hours]` act as a phone's app would, with a device key for each link; the relay takes them only from the
machine it runs on, and refuses one a proxy in front of it forwarded.

## 13. Test vectors

Each value below is checked against PALUGADA's own implementation by
`test/documents/relay-protocol.test.ts`. The keys are made from published
seeds and protect nothing. Ed25519 is deterministic, so the same seed and
message give the same signature in any library.

- `key`: a deployment's seed, and the public key, key id and fingerprint it
  makes.
- `canonical`: values and their canonical JSON.
- `envelope`: an `inbox_item`, its canonical body, and its `v1a` signature
  with `key` at `timestamp`.
- `envelopeId`: what the envelope's id is made from.
- `pseudonyms`: a relay's salt, and the recipient and company reference it
  makes.
- `device`: a device's seed, the fields of a press, the bytes it signs, and
  the signature.
- `pull`: a pull's request line and its signature with `key`.
- `roomActivity`: a person's `room_activity` at `summary`, its canonical
  body, its `v1a` signature with `key` at `timestamp`, and the notice and
  link its id is made from.
- `meetingSoon`: a person's `meeting_soon` at `summary`, the same way.
- `reply`: a reply's words, and the fields, bytes and signature of the
  `device` key's signature on it.

<!-- test vectors -->

```json
{
  "key": {
    "seed": "3f53b201b37db54e68ab2db1b185408ca12982471169f6224216c96dabeb7a41",
    "publicKey": "xM87mVTf3yvp4EZtrldItFPRfy5l25F4knaN8p5gPHk",
    "kid": "85d221d677f1526b",
    "fingerprint": "QXJCDVTX6FJGXVRJXTOPGP2X"
  },
  "canonical": [
    {
      "value": {
        "b": 2,
        "a": [
          1,
          "two",
          null,
          true
        ],
        "€": "euro",
        "\r": "cr"
      },
      "canonical": "{\"\\r\":\"cr\",\"a\":[1,\"two\",null,true],\"b\":2,\"€\":\"euro\"}"
    },
    {
      "value": {
        "numbers": [
          333333333.3333333,
          1e+30,
          4.5,
          0.002,
          1e-27
        ],
        "string": "€$\u000f\nA'B\"\\\\\"/",
        "literals": [
          null,
          true,
          false
        ]
      },
      "canonical": "{\"literals\":[null,true,false],\"numbers\":[333333333.3333333,1e+30,4.5,0.002,1e-27],\"string\":\"€$\\u000f\\nA'B\\\"\\\\\\\\\\\"/\"}"
    },
    {
      "value": {
        "emoji": "😀",
        "nested": {
          "z": 1,
          "y": {
            "x": []
          }
        },
        "empty": {}
      },
      "canonical": "{\"emoji\":\"😀\",\"empty\":{},\"nested\":{\"y\":{\"x\":[]},\"z\":1}}"
    }
  ],
  "envelope": {
    "value": {
      "v": 1,
      "id": "417d0861-875d-8842-8499-1d3577efc40a",
      "type": "inbox_item",
      "at": "2026-11-08T12:00:00.000Z",
      "deployment": "0b5e4c1d-7a2f-4e6b-9c3d-2f1e0a9b8c7d",
      "relay": "9d2e8f7a-6b5c-4d3e-8f2a-1b0c9d8e7f6a",
      "to": {
        "recipient": "DUO7HGJ6ZVY3R2L2UMWI6IR3IM"
      },
      "company": {
        "ref": "co_SCS6VUU5FYH6FLKQ",
        "name": "Toko Kopi"
      },
      "share": "summary",
      "urgency": "normal",
      "lang": "id",
      "text": "Perlu persetujuan: Kirim email ke 40 pelanggan",
      "link": "https://palugada.example/?company=1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f&item=6f1c2a9e-3b4d-4c5e-9f6a-7b8c9d0e1f2a",
      "data": {
        "kind": "approval",
        "tier": 2,
        "title": "Kirim email ke 40 pelanggan"
      },
      "offers": [
        {
          "token": "pt_AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE",
          "act": "approve",
          "label": "Setujui"
        },
        {
          "token": "pt_AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI",
          "act": "deny",
          "label": "Tolak"
        }
      ]
    },
    "canonical": "{\"at\":\"2026-11-08T12:00:00.000Z\",\"company\":{\"name\":\"Toko Kopi\",\"ref\":\"co_SCS6VUU5FYH6FLKQ\"},\"data\":{\"kind\":\"approval\",\"tier\":2,\"title\":\"Kirim email ke 40 pelanggan\"},\"deployment\":\"0b5e4c1d-7a2f-4e6b-9c3d-2f1e0a9b8c7d\",\"id\":\"417d0861-875d-8842-8499-1d3577efc40a\",\"lang\":\"id\",\"link\":\"https://palugada.example/?company=1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f&item=6f1c2a9e-3b4d-4c5e-9f6a-7b8c9d0e1f2a\",\"offers\":[{\"act\":\"approve\",\"label\":\"Setujui\",\"token\":\"pt_AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE\"},{\"act\":\"deny\",\"label\":\"Tolak\",\"token\":\"pt_AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI\"}],\"relay\":\"9d2e8f7a-6b5c-4d3e-8f2a-1b0c9d8e7f6a\",\"share\":\"summary\",\"text\":\"Perlu persetujuan: Kirim email ke 40 pelanggan\",\"to\":{\"recipient\":\"DUO7HGJ6ZVY3R2L2UMWI6IR3IM\"},\"type\":\"inbox_item\",\"urgency\":\"normal\",\"v\":1}",
    "id": "417d0861-875d-8842-8499-1d3577efc40a",
    "timestamp": "1794139200",
    "signature": "v1a,DRkwtZhcUbpULe3AS5nrnv53Vp036fD/QbjpQuDaolI2p4xizrRJoDxvm7ws5rAzR3qMHK3ln6ZaSBln4aYwCQ=="
  },
  "envelopeId": {
    "deployment": "0b5e4c1d-7a2f-4e6b-9c3d-2f1e0a9b8c7d",
    "relay": "9d2e8f7a-6b5c-4d3e-8f2a-1b0c9d8e7f6a",
    "link": "5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d",
    "type": "inbox_item",
    "subject": "6f1c2a9e-3b4d-4c5e-9f6a-7b8c9d0e1f2a",
    "version": 1,
    "id": "417d0861-875d-8842-8499-1d3577efc40a"
  },
  "pseudonyms": {
    "salt": "5d9eb9384884d7e300834543f1d2ab2b29b88f948e2a04040b00e41af4d79a19",
    "principal": "owner",
    "recipient": "DUO7HGJ6ZVY3R2L2UMWI6IR3IM",
    "companyId": "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
    "companyRef": "co_SCS6VUU5FYH6FLKQ"
  },
  "device": {
    "seed": "78fc20d644279069d48ace8289c1ff06ef02d028954390f43263325ad158f211",
    "publicKey": "pOrcnAi2ZwRNUhnLkHD0G9EI2K7n35PHTkjNAx7XvGU",
    "fields": {
      "deployment": "0b5e4c1d-7a2f-4e6b-9c3d-2f1e0a9b8c7d",
      "relay": "9d2e8f7a-6b5c-4d3e-8f2a-1b0c9d8e7f6a",
      "recipient": "DUO7HGJ6ZVY3R2L2UMWI6IR3IM",
      "type": "press",
      "token": "pt_AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE",
      "at": "2026-11-08T12:01:00.000Z"
    },
    "message": "palugada-device/v1\n{\"at\":\"2026-11-08T12:01:00.000Z\",\"deployment\":\"0b5e4c1d-7a2f-4e6b-9c3d-2f1e0a9b8c7d\",\"recipient\":\"DUO7HGJ6ZVY3R2L2UMWI6IR3IM\",\"relay\":\"9d2e8f7a-6b5c-4d3e-8f2a-1b0c9d8e7f6a\",\"token\":\"pt_AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE\",\"type\":\"press\"}",
    "signature": "r1kyzq66JUhLwsxcpgnx_yrQB-En9c2sfMIz61K54IZ9GjYAhBdykvng5ZShHSA6U6Hm-jzMOFp1GyphQvGZCA"
  },
  "pull": {
    "id": "pull_3f2e1d0c-9b8a-4766-8554-433221100fed",
    "timestamp": "1794139200",
    "request": "GET /v1/inbox?after=7&wait=25",
    "signature": "v1a,Id5MCxe3xgUVSAOrGcRpRe9fMiHX+blrxpKQ7HgIMRsf+czjusYKeUdDrMqX+PRyFcLqHnhQew1XETwKA20vDA=="
  },
  "roomActivity": {
    "value": {
      "v": 1,
      "id": "d95716a2-8d50-8b44-8048-04d19062eebc",
      "type": "room_activity",
      "at": "2026-11-08T12:05:00.000Z",
      "deployment": "0b5e4c1d-7a2f-4e6b-9c3d-2f1e0a9b8c7d",
      "relay": "9d2e8f7a-6b5c-4d3e-8f2a-1b0c9d8e7f6a",
      "to": {
        "recipient": "DUO7HGJ6ZVY3R2L2UMWI6IR3IM"
      },
      "company": {
        "ref": "co_SCS6VUU5FYH6FLKQ",
        "name": "Toko Kopi"
      },
      "share": "summary",
      "urgency": "normal",
      "lang": "id",
      "text": "Budi (@budi) menyebut Anda di Toko Kopi.",
      "link": "https://palugada.example/?company=1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f&room=7e8f9a0b-1c2d-4e3f-9a4b-5c6d7e8f9a0b",
      "data": {
        "reasons": [
          "mention"
        ],
        "count": 1,
        "room": "Toko Kopi",
        "authors": [
          {
            "name": "Budi",
            "handle": "budi"
          }
        ]
      },
      "offers": [
        {
          "token": "pt_AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM",
          "act": "reply",
          "label": "Balas"
        },
        {
          "token": "pt_BAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ",
          "act": "read",
          "label": "Tandai dibaca"
        },
        {
          "token": "pt_BQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU",
          "act": "mute",
          "label": "Bisukan"
        }
      ]
    },
    "canonical": "{\"at\":\"2026-11-08T12:05:00.000Z\",\"company\":{\"name\":\"Toko Kopi\",\"ref\":\"co_SCS6VUU5FYH6FLKQ\"},\"data\":{\"authors\":[{\"handle\":\"budi\",\"name\":\"Budi\"}],\"count\":1,\"reasons\":[\"mention\"],\"room\":\"Toko Kopi\"},\"deployment\":\"0b5e4c1d-7a2f-4e6b-9c3d-2f1e0a9b8c7d\",\"id\":\"d95716a2-8d50-8b44-8048-04d19062eebc\",\"lang\":\"id\",\"link\":\"https://palugada.example/?company=1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f&room=7e8f9a0b-1c2d-4e3f-9a4b-5c6d7e8f9a0b\",\"offers\":[{\"act\":\"reply\",\"label\":\"Balas\",\"token\":\"pt_AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM\"},{\"act\":\"read\",\"label\":\"Tandai dibaca\",\"token\":\"pt_BAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ\"},{\"act\":\"mute\",\"label\":\"Bisukan\",\"token\":\"pt_BQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU\"}],\"relay\":\"9d2e8f7a-6b5c-4d3e-8f2a-1b0c9d8e7f6a\",\"share\":\"summary\",\"text\":\"Budi (@budi) menyebut Anda di Toko Kopi.\",\"to\":{\"recipient\":\"DUO7HGJ6ZVY3R2L2UMWI6IR3IM\"},\"type\":\"room_activity\",\"urgency\":\"normal\",\"v\":1}",
    "id": "d95716a2-8d50-8b44-8048-04d19062eebc",
    "timestamp": "1794139500",
    "signature": "v1a,iKG7CVooymy4BV+k0FoJfHVls4J7tm/tYjrkWvrXNWshYYBXQlO4nvhpN7ACWDH/Oynd7idfmJ9OHgpAz7ZTBg==",
    "subject": "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f",
    "link": "5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d"
  },
  "reply": {
    "body": "Saya ke sana sekarang.",
    "fields": {
      "deployment": "0b5e4c1d-7a2f-4e6b-9c3d-2f1e0a9b8c7d",
      "relay": "9d2e8f7a-6b5c-4d3e-8f2a-1b0c9d8e7f6a",
      "recipient": "DUO7HGJ6ZVY3R2L2UMWI6IR3IM",
      "type": "reply",
      "token": "pt_AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM",
      "at": "2026-11-08T12:06:00.000Z",
      "sha256": "d3026048dedc11ee3e713418cfebcb45e2519eebaa3f34d1c70f6da0adb1d808",
      "clientId": "phone-7f3a"
    },
    "message": "palugada-device/v1\n{\"at\":\"2026-11-08T12:06:00.000Z\",\"clientId\":\"phone-7f3a\",\"deployment\":\"0b5e4c1d-7a2f-4e6b-9c3d-2f1e0a9b8c7d\",\"recipient\":\"DUO7HGJ6ZVY3R2L2UMWI6IR3IM\",\"relay\":\"9d2e8f7a-6b5c-4d3e-8f2a-1b0c9d8e7f6a\",\"sha256\":\"d3026048dedc11ee3e713418cfebcb45e2519eebaa3f34d1c70f6da0adb1d808\",\"token\":\"pt_AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM\",\"type\":\"reply\"}",
    "signature": "7ZSwpy11tNhzYk8f8ao8hCqJ1D8vW8mfXjgGTH74SDhkhQ4Wk1qX9D0sosTsRerPJcTGOFnGrRBmi2-50PalAQ"
  },
  "meetingSoon": {
    "value": {
      "v": 1,
      "id": "a9246138-de3d-84ce-909a-3c6a7335a2e9",
      "type": "meeting_soon",
      "at": "2026-11-08T13:50:00.000Z",
      "deployment": "0b5e4c1d-7a2f-4e6b-9c3d-2f1e0a9b8c7d",
      "relay": "9d2e8f7a-6b5c-4d3e-8f2a-1b0c9d8e7f6a",
      "to": {
        "recipient": "DUO7HGJ6ZVY3R2L2UMWI6IR3IM"
      },
      "company": {
        "ref": "co_SCS6VUU5FYH6FLKQ",
        "name": "Toko Kopi"
      },
      "share": "summary",
      "urgency": "normal",
      "lang": "id",
      "text": "Rapat dimulai sepuluh menit lagi di Dapur.",
      "link": "https://palugada.example/?company=1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f&room=2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e&thread=4d5e6f7a-8b9c-4d0e-8f1a-2b3c4d5e6f7a",
      "data": {
        "room": "Dapur",
        "startsAt": "2026-11-08T14:00:00.000Z",
        "minutes": 30
      },
      "offers": []
    },
    "canonical": "{\"at\":\"2026-11-08T13:50:00.000Z\",\"company\":{\"name\":\"Toko Kopi\",\"ref\":\"co_SCS6VUU5FYH6FLKQ\"},\"data\":{\"minutes\":30,\"room\":\"Dapur\",\"startsAt\":\"2026-11-08T14:00:00.000Z\"},\"deployment\":\"0b5e4c1d-7a2f-4e6b-9c3d-2f1e0a9b8c7d\",\"id\":\"a9246138-de3d-84ce-909a-3c6a7335a2e9\",\"lang\":\"id\",\"link\":\"https://palugada.example/?company=1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f&room=2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e&thread=4d5e6f7a-8b9c-4d0e-8f1a-2b3c4d5e6f7a\",\"offers\":[],\"relay\":\"9d2e8f7a-6b5c-4d3e-8f2a-1b0c9d8e7f6a\",\"share\":\"summary\",\"text\":\"Rapat dimulai sepuluh menit lagi di Dapur.\",\"to\":{\"recipient\":\"DUO7HGJ6ZVY3R2L2UMWI6IR3IM\"},\"type\":\"meeting_soon\",\"urgency\":\"normal\",\"v\":1}",
    "id": "a9246138-de3d-84ce-909a-3c6a7335a2e9",
    "timestamp": "1794145800",
    "signature": "v1a,3Zpvtwt9Rj8e1IpwGY1q/lj6atNtYnCl8x4wjxjJgpVn7bcbocLfvCWpxt7VNGRQbeDIDBjfcBcCCqfUMBwSCw==",
    "subject": "8a7b6c5d-4e3f-4a2b-9c1d-0e9f8a7b6c5d",
    "link": "5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d"
  }
}
```

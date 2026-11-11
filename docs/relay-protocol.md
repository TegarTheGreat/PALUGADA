# PALUGADA relay protocol, version 1

This is the protocol a relay speaks with a PALUGADA deployment: what the
deployment sends it, what it may send back, and how each side proves who it
is. It is written for whoever builds a relay -- a phone app's backend, a
bridge to a push service, the reference relay in `scripts/relay-reference.ts`
-- and it is the whole of what PALUGADA expects: a relay built from this text
alone, checked against the test vectors in section 13, interoperates.
Requirements: PRD F19.19 and F19.20; how it was built: `docs/STATUS.md`
sections 2.208, 2.213 and 2.216.

The key words MUST, MUST NOT, SHOULD and MAY are used as RFC 2119 uses them.

## 1. What a relay is, and is not

A relay tells people's phones what PALUGADA has for them. PALUGADA tells it
what a person is owed -- an approval they may decide, a question, an
incident, work done, a digest -- at that person's share level, and takes back
a small set of acts, each of which redeems a token that came with a notice to
that same person.

**v1 is a notifier, not a mirror.** A relay is never sent a room list, a
history, a membership, or another person's items. A room appears to it only
in a person's own notice about it: not at all at `signal`, and from `summary`
by its name and who wrote there, by name and handle, which is what the relay
shows that person. No company, room, thread, item or task id ever reaches a
relay: a notice's link names a handle made for that notice alone (section 6),
which PALUGADA resolves only for the person it was for, once they have signed
in. Reading, scrolling back and choosing what to open happen in PALUGADA
itself, which every notice links to. A mirror can be added inside v1 later,
because v1 only ever adds (section 11).

**Never sent:** secrets, file bytes (a link at most), prompts, transcripts,
what customers wrote, room lists, history, membership, another person's
items, or the id of a company, room, thread, item or task.

**Never accepted:** an assignment, an instruction, anything at tier 3, a
standing approval ("yes for a while"), a schedule, a meeting, a room or a
membership, a setting, a seat, a pairing, or an export. There is no type for
any of them, and a type PALUGADA does not know is refused.

## 2. Parties and keys

| Party | Identity |
|---|---|
| Deployment | An Ed25519 key pair. The deployment publishes the public key; its private seed is sealed under the deployment's master key and never leaves it. The deployment is named by its `deployment` id, a UUID. |
| Relay | Its own Ed25519 key pair, published in its well-known document (section 4) and pinned by the deployment when the owner adds the relay. |
| Device | Optional: an Ed25519 key a person's phone makes and gives when it links. When a link has one, every act for that link MUST carry the device's signature (section 8). The relay hands it over, so it guards against a relay key stolen after the link was made, not against the relay's operator (section 8). |
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
relays cannot join what each knows by a person or a company: each sees
different pseudonyms, and no envelope carries the id they are made from
(links name handles, section 6). Two relays can tell they serve the same
deployment, since every envelope names it, and nothing more from what
PALUGADA sends them.

### 2.3 Rotating keys

**The deployment's key.** The owner may give the deployment a new key. For
seven days after, every envelope carries two signatures, the new key's and
the old one's, and every paired relay is sent a `keys_rotated` envelope that
both sign. The deployment keeps the old key, and signs each `keys_rotated`
with it, until every paired relay has taken its rotation, however long that
is: a relay that was down for the week is still sent a rotation it can
verify with the key it pinned. A second rotation is refused while any
paired relay has not taken the first. A relay MUST take the new key only
from a `keys_rotated` that

- verifies with the key it pinned now -- not a key rotated out and still in
  its week, which whoever rotated it away from may hold;
- verifies with the key it names, so the deployment is shown to hold it; and
- names, as `previous.key`, the key the relay pinned now.

It then pins the new key and keeps accepting the one it replaces until the
`until` the envelope names, never more than seven days on, and SHOULD stop
after. A rotation signed by the old key alone is refused: otherwise whoever
kept the old key could, in its week, announce a key of their own and be
pinned for good.

**A relay that can verify nothing.** A relay that holds no key that verifies
what the deployment sends -- it missed a rotation, or lost its state --
answers `401` to every envelope, which PALUGADA tries again with backoff and
then shows the owner as given up. Its operator pins the deployment's current
fingerprint, which the owner reads in the console, and the owner pairs the
relay again in place (section 5): the same relay id and salt, so every
person keeps their pseudonym and their link.

**The relay's own key.** A relay rotates its key by sending
`relay_key_rotated` (section 9.3), which the key PALUGADA pinned now and the
new key both sign, naming the pinned key as `previous.key`. PALUGADA takes
the old key beside the new one until the `until` it names, never more than
seven days on, and the new one alone after. A relay whose key leaked, or
that lost it, is paired again in place by the owner instead, with the
fingerprint of its new key typed as at pairing.

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
SHOULD refuse any other `pair_request` until its operator resets it by hand,
except one from the same `deployment` naming the same `relay` id, under a
fingerprint its operator pinned anew: that is the deployment pairing it again
in place, and the relay keeps its links and devices.

**Pairing again in place.** The owner may pair a relay that is already
paired again, keeping its id, its salt, its settings and every person's
link: for a relay that can verify nothing the deployment sends (section 2.3),
or one whose key changed other than by `relay_key_rotated`. PALUGADA reads
its well-known document again, the owner types the fingerprint of the key it
gives now as at pairing, with a second factor given now, and PALUGADA sends a
`pair_request` whose accept must be signed by that key. The new key is pinned
from then; the one before is no longer taken.

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
| `link` | for a person | where it opens in PALUGADA, or `null` when the deployment has no public address: the deployment's address and `?notice=<handle>`, nothing else. The handle is 32 base64url characters made for this one envelope; PALUGADA resolves it to what the notice is about only for the person it was for, once they have signed in, and only while it keeps the envelope, fourteen days. A relay MUST NOT take anything from the handle but the link |
| `data` | per type | what the share level allows, below |
| `offers` | `inbox_item`, `room_activity` | `[{ "token", "act", "label" }]`: what the person may press or send back (sections 8 and 9) |

A relay MUST refuse an envelope whose `deployment` is not the deployment it
is paired with, or whose `relay` is not the id that deployment gave it
(`403`), so an envelope signed for one pairing cannot be carried to another.
A relay MUST ignore a field it does not know, and SHOULD ignore an envelope
type it does not know.

### 6.1 Share levels

What a person is told is the lowest of three levels: the relay's, the
level the owner set for that company on that relay (none unless set, and
never above the relay's), and the person's own:

- `signal`: that something happened, how urgent, and where it opens. No
  company name, no title, nothing to press but a notice about a room's read
  mark and mute.
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
Sent once when it is reminded, and once more at most if it moves after
that, only while the person may still see the room, and never for a meeting
cancelled, begun, moved since, or whose message was removed. `data` is `{}` at `signal`; adds `room` (its name, or `null` for a
direct conversation), `startsAt` (ISO 8601) and `minutes` at `summary`; adds
`title` (the setter's words, at most 140 characters, with any secret in them
redacted) at `content`, which `text` also carries on its second line. `link`
opens the meeting's thread. `urgency` is `normal`, and `offers` is always
empty. The meeting's call link is never sent: the person opens it from the
thread.

#### `link_ended`

A person's link through this relay ended in PALUGADA: they linked another
device through the same relay (`replaced`), they or the owner unlinked it
(`unlinked`), their seat ended (`seat_ended`), or the relay itself sent
`link_end` (`relay`). `to` names the person; `data` is
`{ "claim": "<the link_claim envelope's id that made the link>", "reason" }`,
`claim` `null` for a link made before PALUGADA kept it; `text` says the phone
is no longer linked. A relay MUST forget the device key that link was made
with, and SHOULD tell that device. Sent after anything of the link still on
its way, and never to a revoked relay, which is told nothing.

#### `company_forgotten`

A company the relay was told of is being erased. `company` is `{ "ref" }`
alone and `data` is `{}`; there is no `to`. A relay MUST drop everything it
holds that names that `ref`, MUST show nothing it is sent later that names it,
and MUST forget each person whose link heard about that company alone (a
seat's link names one company in its `link_confirmed`), since their links end
with the company. Erasing a company in PALUGADA cannot reach what a relay
already handed to a push service or a phone (section 10).

#### `act_result`

What PALUGADA answered an envelope it pulled from the relay's inbox (section
9), so a relay in pull mode learns what a relay that posts learns from the
answer to its request. `data` is
`{ "ref": "<the pulled envelope's webhook-id>", "status": <the HTTP status a push would have been answered>, "answer": { … } }`,
`answer` the body of that answer exactly (section 9.2). There is no `to`.
Sent once for each pulled envelope whose signature verified, the same `ref`
sent again answered again with the same id, so a relay drops the repeat.
Not sent for an envelope the relay's minute or another replica held back:
that one is taken at a later pull.

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
  when the owner narrows what a relay is told, or what one company's notices
  may say there (section 6.1), is made again at the new share, without the
  offers no longer allowed, under the same id; one for a company the relay
  no longer hears about is not sent. A notice of an item that closed before
  it was sent is not sent at all, and nor is its `inbox_closed`.
- **Who may see is asked again as it is sent.** A `room_activity` or
  `meeting_soon` whose person can no longer see its room -- taken out of a
  private room, or their seat ended -- is not sent, then or from the dead
  letters, and is dropped with its offers.
- **A message deleted is not sent.** A `room_activity` owed for words deleted
  since, or taken when their time was up, is never sent, whenever it was
  owed or tried, and is dropped; a relay that had it, was being sent it, or
  was tried with it, is sent `room_activity_retracted`. So is a
  `meeting_soon` whose title was those words. The deployment's own copy of
  the envelope keeps only its address (`v`, `id`, `type`, `at`,
  `deployment`, `relay`, `to`) from that moment.
- **What was sent is forgotten after fourteen days.** The deployment keeps a
  delivered or given-up envelope for fourteen days and then deletes it, so a
  retraction reaches only what was sent in the last fourteen days. A relay
  therefore drops content on its own after that (section 10).
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
   PALUGADA, when the person links again through the same relay, or when the
   seat or the relay is revoked. Each of these but the relay's revocation is
   told to the relay as `link_ended` (section 6.3), naming the claim that
   made the link and why it ended.

A code is good at the relay it was offered through and no other, and once.

**One link per person per relay.** A person has at most one active link
through a relay, and it holds at most one device key. Linking again through
the same relay -- a new phone, or the same phone after a reinstall -- ends
the earlier link, voids its offers, and sends `link_ended` with reason
`replaced`. A relay that serves a person on several devices fans its
notices out to that person's own devices itself; only the device whose key
the link holds can sign an act, and the others only show what they are
sent. The recipient stays the same across links, so a relay tells one link
from the next by the `claim` its `link_claim` carried (`link_confirmed` and
`link_ended` both name it).

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

Each device signature is taken once. The same signature sent again under
another envelope id is refused (`relay.device_replayed`), so an act a relay
kept cannot be sent twice; the same envelope sent again under its own id is
answered as it was (section 9.1, step 3).

**The owner's link needs a device key to act.** Without one the owner is still
told, but no offer to press is made, and nothing sent for that link counts
except `link_end` (`relay.owner_device`). A relay key stolen after the owner
linked can therefore neither decide nor write in the owner's name.

**What a device key proves, and what it does not.** PALUGADA takes the
device key from the relay's signed `link_claim`; nothing in the claim is
signed by the device itself. The key therefore guards against a relay key
stolen *after* the link was made, and against a relay that kept an act to
send later, but not against the relay's operator at the moment of linking,
who could put a key of its own there. To let the person check, PALUGADA
shows the fingerprint of the link's device key where the person sees their
link -- the first 24 characters of the base32 of the SHA-256 of the raw key,
as for a relay's key (section 2.1) -- and a relay's app SHOULD show the same
fingerprint on the phone, so the person can compare the two. A relay whose
app makes the device keys on the phone, and never sends their private
halves anywhere, is the only kind for which the device key protects the
person against the relay.

## 9. What a relay sends

**Push.** `POST /api/relay/v1/relays/<relay id>/inbound` on the deployment, one
envelope a request, at most 64 KiB, signed with the relay's key in the headers
of section 4. A request that verifies, now, with the key of a relay paired
here counts against that relay's sixty a minute and nothing else. Any other
is throttled before anything is read: sixty requests a minute from one
address and six hundred for the route as a whole. Strangers who fill the
route therefore shut out strangers, never a paired relay.

**Pull**, for a deployment the relay cannot reach. The deployment asks

```
GET <inbox>?after=<cursor>&wait=25
```

with `webhook-id`, `webhook-timestamp` and `webhook-signature` signed by the
deployment over the request line, `GET <path>?<query>` as it appears, a line
feed, and the relay's id at the deployment (the `relay` of every envelope it
is sent): `GET <path>?<query>\n<relay id>`. The relay MUST answer only a
request that verifies with the deployment's key over its own id, so a pull
another relay was sent cannot be replayed at it to read its inbox, and SHOULD
refuse a pull whose `webhook-id` it has answered before (`409`). It answers, as
soon as it has something or after `wait` seconds,

```json
{ "envelopes": [ { "id": "…", "timestamp": "…", "signature": "v1a,…", "body": "<canonical JSON>" } ], "cursor": "<opaque>" }
```

`after` is omitted on the first pull. A relay MUST answer at most 100
envelopes to one pull, and at most 8 MiB (8,388,608 bytes) in all; the
deployment takes none of an answer with more, and stops reading one at its
8 MiB. A relay with more waiting answers fewer, and the rest at the next pull.
The deployment waits for an answer for `wait` seconds and ten more. Each
envelope is taken exactly as if it were pushed, the relay's sixty a minute
and its 300 seconds included, and the next pull names the new cursor.

A relay therefore signs each envelope when it answers the pull, not when the
person acted: an act that waited in the inbox longer than five minutes
would otherwise be refused as stale. The device's own signature still
carries the moment the person acted (section 8), so a relay cannot hold an
act back for long by signing it late. What PALUGADA answered each pulled
envelope comes back to the relay as an `act_result` (section 6.3), which a
relay that pushes reads from the answer to its request.

A relay MUST keep its inbox and the cursors it has given across restarts,
and MUST answer a cursor it does not know -- one from before it lost its
state, or one it never gave -- from the oldest envelope it holds, never
with nothing: the deployment keeps its cursor across the relay's restarts,
and a relay that answered an unknown cursor with nothing would lose every
act made since.

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
2. The signature verifies with the relay's pinned key (`401`), or, until the
   moment PALUGADA answered a `relay_key_rotated` with, the key it rotated
   from; within 300 seconds (`408`, carrying the deployment's `now`).
   Nothing is written for an unknown relay or a bad signature; it is only
   counted.
3. The envelope id is new. A repeat is answered as the first one was; one
   still being taken is answered `409 relay.in_progress`; a new one counts
   against the relay's sixty a minute (`429`).
4. The person: the link a token or a recipient names is this relay's and
   active (`410` when it ended), and its company is one the relay hears
   about.
5. The device: `device_sig` for a link with a device key; for the owner's
   link without one, only `link_end`.
6. The type.

Every inbound body is `{ "v": 1, "type": "…", "at": "<ISO 8601>", … }`; one
whose `v` is not `1`, or that has none, is refused (`relay.unknown_version`)
before anything else is read of it.

### 9.2 Answers

| Status | Body | When |
|---|---|---|
| `200` | `{ "ok": true, "result": … }` | taken; a press also carries `text`, "Decided through" the relay's name, in the person's language |
| `401` | `{ "ok": false, "code" }` | unknown or revoked relay, bad signature |
| `408` | `{ "ok": false, "code": "relay.stale", "tolerance": 300, "now" }` | signed more than 300 seconds from the deployment's `now` |
| `409` | `{ "ok": false, "code": "inbox.not_open", "text" }` | a press for an item that has closed: `text` says how, in the person's language, and nothing changes |
| `410` | `{ "ok": false, "code": "relay.link_ended" }` | the link has ended |
| `422` | `{ "ok": false, "code" }` | refused, by one of the codes below, or by the inbox's own rule (such as `approval.own_instigation`: four eyes) |
| `409` | `{ "ok": false, "code": "relay.in_progress" }` | the same envelope is still being taken, by this request's twin or a replica that stopped: send it again under the same id after a few seconds, and it is answered as it was answered, or, once two minutes have passed with nothing settled, taken afresh with whatever the first attempt spent given back |
| `400`, `500` | `{ "error", "code" }`, without `ok` | the deployment failed for a reason that is no answer to the envelope: nothing it asked for was done, and the same envelope, sent again under its id, is taken afresh |
| `429` | `{ "ok": false, "code": "relay.throttled" }` | too many: the answer carries `Retry-After`, the whole seconds until there is room, and a relay sends nothing more to the deployment until then |

A press refused at tier 3 also carries `text`, saying that tier 3 is decided
in the app, in the person's language.

The `422` codes: `relay.unknown_type`, `relay.unknown_version` (a body
whose `v` is not `1`, or that has none), `relay.press_off`,
`relay.press_unknown`, `relay.press_spent`, `relay.press_tier3`,
`relay.device_sig` (no device signature, or one that does not verify),
`relay.device_stale` (a device signature that verifies, over an `at` more
than 300 seconds from the deployment's clock; the answer carries the
deployment's `now`, so the relay can tell the person their phone's clock is
wrong or that the act waited too long), `relay.device_replayed` (a device
signature PALUGADA already took, under another envelope id),
`relay.owner_device`, `relay.not_member`, `relay.seat_changed`,
`relay.post_off`, `relay.link_unknown`, `relay.client_id_used` (a reply's
`clientId` the person used before for other words or another room or
thread), and `relay.malformed` for a body holding text PALUGADA cannot keep
(the NUL character, `\u0000`, anywhere in a name or a value). A refusal by
the room itself is answered with the room's own code (such as
`room.not_member` when the person has left it). An answer never repeats
what an item says.

A relay that is answered `429` waits the `Retry-After` it was given, then at
least 30 seconds more for each further `429` in a row, doubling up to ten
minutes, before it sends again; an act a person made then waits with it,
and lapses once its device signature is five minutes old.

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
room, `body` 1 to 4,000 characters and `clientId` 1 to 64 characters, by
which a reply sent twice is one message. A `clientId` MUST be unique for that
person for all time -- a fresh UUID for each reply the person writes, never a
device's id or a counter that starts again -- and the same reply sent again
MUST carry the same one. A `clientId` the person used before is taken as
that reply sent again only for the same words, room and thread; anything else
is refused (`relay.client_id_used`) rather than answered with the earlier
message. Only while the owner allows replies through the
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

#### `relay_key_rotated`

`{ key, previous: { key, until } }`: the relay has a new key of its own
(section 2.3). `key` is the new public key, `previous.key` the key PALUGADA
pinned now, and `until` the time, ISO 8601, until which the relay may still
sign with the old one. The envelope MUST carry two `v1a` signatures, one by
the key pinned now and one by `key`, so the relay is shown to hold the new
key. PALUGADA takes it only so: signed by the old key alone it is refused
(`relay.key_unproven`), as is one whose `previous.key` is not the key pinned
now, or a key another relay here holds. Answered with `{ fingerprint, until }`,
the new key's fingerprint and the moment, never more than seven days on,
until which PALUGADA takes the old key beside it.

## 10. Content a relay holds

An envelope's **address** is its `v`, `id`, `type`, `at`, `deployment`,
`relay` and `to`; everything else -- `company`, `text`, `link`, `data`,
`offers` and any field added later -- is its **content**.

- A relay MUST drop the content of an envelope a retraction names
  (`inbox_closed`, `room_activity_retracted`) as soon as it is told, and
  everything that names a company it is told is forgotten
  (`company_forgotten`).
- A relay MUST drop every envelope's content no later than fourteen days
  after its `at`, and MUST NOT show or forward the content of an envelope
  already older than that when it arrives. PALUGADA deletes what it sent
  fourteen days after sending it (section 7), so it cannot retract anything
  later than that: the fortnight is the relay's to keep, not a courtesy.
- A relay MAY keep an envelope's address longer, to drop a repeat by its id.

A retraction reaches only what the relay holds. Content a relay has already
handed to a push service, shown on a lock screen, or written to a log is
beyond it, and beyond PALUGADA. A relay SHOULD therefore hand a push service
as little as it can -- at most what the share allows, and only for as long as
the notice is useful, by an expiring push where the service has one -- and
SHOULD NOT write content to its logs. A topic on a public ntfy server is
readable by anyone who knows its name: a relay that forwards to ntfy SHOULD
use a self-hosted or token-protected ntfy for any share above `signal`.

## 11. Versioning

- `v` is an integer, and paths carry `/v1/`. Every envelope, outbound and
  inbound, carries `"v": 1`; PALUGADA refuses an inbound body whose `v` is
  anything else, or missing (`relay.unknown_version`), and a relay SHOULD
  ignore an outbound envelope whose `v` it does not speak.
- Within v1, fields and types are only ever added. Both sides ignore fields
  they do not know; a relay ignores outbound types it does not know;
  PALUGADA refuses inbound types it does not know (`relay.unknown_type`).
  The outbound types of v1 are those of section 6.3, and none is ever taken
  away.
- What a device signs is fixed for v1: the fields of section 8, under the
  prefix `palugada-device/v1`. A field a device must also sign takes a new
  prefix (`palugada-device/v2`), offered at pairing in `versions`, never a
  change to what `palugada-device/v1` covers.
- `versions` is exchanged at pairing, and both sides speak the highest they
  share.
- A v2, when there is one, is served beside v1 for at least six months.

## 12. The reference relay

`scripts/relay-reference.ts`, run with `npm run relay:reference`, is a relay
in one file of Node with no dependencies, written apart from PALUGADA's own
code so that it is a second implementation of this document rather than a
copy of the first.

- **Pairing.** It pins the deployment by the fingerprint it is given
  (`--deployment-fingerprint`, required), and takes no other pairing until its
  state file is deleted, except the same deployment pairing it again
  (section 5) under a fingerprint its operator gave it anew. It takes a new
  deployment key only as section 2.3 says, and prints its fingerprint.
- **Pull.** It is pulled from, so it works where the deployment cannot be
  reached. It answers only a pull signed for its own id, refuses a pull id
  it has answered (`409`), signs each envelope as it answers, and answers a
  cursor it does not know from the oldest envelope it holds.
- **State.** Its keys, the pairing, its inbox and cursors, the tokens it was
  sent (as their hashes), the envelope ids it has seen and the companies it
  was told to forget are kept in its state file (`--state`, by default
  `relay-state.json`), written whole each time through a file beside it and
  a rename, so a restart loses nothing a pull still needs.
- **Content.** It verifies every envelope, drops what a retraction names,
  forgets a company it is told to forget, and drops every envelope's content
  fourteen days after its `at` (hourly, and on arrival). It forwards `text`
  and `link` to ntfy (`RELAY_NTFY_URL`, one topic per recipient, with
  `RELAY_NTFY_TOKEN` as a bearer token when set) at priority 5 for
  `interrupt`, 3 for `normal` and 2 for `quiet`. It prints what it is told
  only as far as `signal` -- the type, the recipient and the commands for its
  offers -- unless `--print-content` is given, since whatever keeps its
  output keeps what it prints.
- **Acts.** Its commands `link <code>`, `press <token> [answer]`,
  `reply <token> <text>`, `read <token>`, `mute <token> [hours]` and
  `rotate-key` act as a phone's app would. They are taken on a listener of
  their own, bound to this machine's loopback (`--local-port`, by default
  one above `--port`), never on the public one, so no proxy in front of the
  relay can reach them. It makes a device key for each link and signs every
  act with it; those keys live in its state file beside its own, so a link
  made through the reference relay is only as safe as that file (section 8),
  and it prints each link's device fingerprint for the person to compare
  with the one PALUGADA shows.

What the reference relay leaves to a production relay: an app on the
person's phone that makes the device key there and never sends it away;
push through the phone's own service (APNs, FCM) with expiring messages
rather than ntfy; several deployments and many people on one relay, each
deployment's state apart; a database rather than one state file, with its
inbox kept across replicas; its own throttle in front of the public
listener; monitoring of its pull and push; and rotating its own key on a
schedule (`relay_key_rotated`), with the old key's private half destroyed
once the week is out.

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
  `device` key's signature on it; its `clientId` is a fresh UUID, as
  section 9.3 asks.
- `linkEnded`, `companyForgotten` and `actResult`: one of each type, its
  canonical body, its `v1a` signature with `key` at `timestamp`, and the link
  and subject its id is made from.
- `relayKeyRotated`: a relay's old and new seeds, the keys and fingerprints
  they make, the `relay_key_rotated` it sends, and its `webhook-signature`
  with both keys, the old one first.

Every `link` in the vectors names a notice by its handle alone
(`?notice=` and 32 base64url characters, section 6), never a company, room,
thread, item or task.

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
      "link": "https://palugada.example/?notice=AAECAwQFBgcICQoLDA0ODxAREhMUFRYX",
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
    "canonical": "{\"at\":\"2026-11-08T12:00:00.000Z\",\"company\":{\"name\":\"Toko Kopi\",\"ref\":\"co_SCS6VUU5FYH6FLKQ\"},\"data\":{\"kind\":\"approval\",\"tier\":2,\"title\":\"Kirim email ke 40 pelanggan\"},\"deployment\":\"0b5e4c1d-7a2f-4e6b-9c3d-2f1e0a9b8c7d\",\"id\":\"417d0861-875d-8842-8499-1d3577efc40a\",\"lang\":\"id\",\"link\":\"https://palugada.example/?notice=AAECAwQFBgcICQoLDA0ODxAREhMUFRYX\",\"offers\":[{\"act\":\"approve\",\"label\":\"Setujui\",\"token\":\"pt_AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE\"},{\"act\":\"deny\",\"label\":\"Tolak\",\"token\":\"pt_AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI\"}],\"relay\":\"9d2e8f7a-6b5c-4d3e-8f2a-1b0c9d8e7f6a\",\"share\":\"summary\",\"text\":\"Perlu persetujuan: Kirim email ke 40 pelanggan\",\"to\":{\"recipient\":\"DUO7HGJ6ZVY3R2L2UMWI6IR3IM\"},\"type\":\"inbox_item\",\"urgency\":\"normal\",\"v\":1}",
    "id": "417d0861-875d-8842-8499-1d3577efc40a",
    "timestamp": "1794139200",
    "signature": "v1a,1krw3U+D5lOXt/kvKaYJOZVxT6Np2dUcwBNzY60mSyWlSnT9xrP+vH3vrlvOCZGqkQdUBlC5cHxpmE2SEqK1BA=="
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
    "request": "GET /v1/inbox?after=7&wait=25\n9d2e8f7a-6b5c-4d3e-8f2a-1b0c9d8e7f6a",
    "signature": "v1a,gdxZImQq2F4odj8OKU8B3EJ1X1w+aOJH9ZENR/ECOBbxisY7gr4g4Ipqw0cA8DaaqmrovanDNM57BbYganE/CA=="
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
      "link": "https://palugada.example/?notice=GBkaGxwdHh8gISIjJCUmJygpKissLS4v",
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
    "canonical": "{\"at\":\"2026-11-08T12:05:00.000Z\",\"company\":{\"name\":\"Toko Kopi\",\"ref\":\"co_SCS6VUU5FYH6FLKQ\"},\"data\":{\"authors\":[{\"handle\":\"budi\",\"name\":\"Budi\"}],\"count\":1,\"reasons\":[\"mention\"],\"room\":\"Toko Kopi\"},\"deployment\":\"0b5e4c1d-7a2f-4e6b-9c3d-2f1e0a9b8c7d\",\"id\":\"d95716a2-8d50-8b44-8048-04d19062eebc\",\"lang\":\"id\",\"link\":\"https://palugada.example/?notice=GBkaGxwdHh8gISIjJCUmJygpKissLS4v\",\"offers\":[{\"act\":\"reply\",\"label\":\"Balas\",\"token\":\"pt_AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM\"},{\"act\":\"read\",\"label\":\"Tandai dibaca\",\"token\":\"pt_BAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ\"},{\"act\":\"mute\",\"label\":\"Bisukan\",\"token\":\"pt_BQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU\"}],\"relay\":\"9d2e8f7a-6b5c-4d3e-8f2a-1b0c9d8e7f6a\",\"share\":\"summary\",\"text\":\"Budi (@budi) menyebut Anda di Toko Kopi.\",\"to\":{\"recipient\":\"DUO7HGJ6ZVY3R2L2UMWI6IR3IM\"},\"type\":\"room_activity\",\"urgency\":\"normal\",\"v\":1}",
    "id": "d95716a2-8d50-8b44-8048-04d19062eebc",
    "timestamp": "1794139500",
    "signature": "v1a,alCkVYoZ0D9SPsiNwfQmwue72tNqvin4M/Hdxdf0dj2ijitHj5Ru2x64m0luEV6LF+pReGmwfCo2KG6Ctrk9Ag==",
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
      "clientId": "4f0e6a52-9c1b-4d7e-8a3f-2b6c9d1e0f57"
    },
    "message": "palugada-device/v1\n{\"at\":\"2026-11-08T12:06:00.000Z\",\"clientId\":\"4f0e6a52-9c1b-4d7e-8a3f-2b6c9d1e0f57\",\"deployment\":\"0b5e4c1d-7a2f-4e6b-9c3d-2f1e0a9b8c7d\",\"recipient\":\"DUO7HGJ6ZVY3R2L2UMWI6IR3IM\",\"relay\":\"9d2e8f7a-6b5c-4d3e-8f2a-1b0c9d8e7f6a\",\"sha256\":\"d3026048dedc11ee3e713418cfebcb45e2519eebaa3f34d1c70f6da0adb1d808\",\"token\":\"pt_AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM\",\"type\":\"reply\"}",
    "signature": "0iewhXuOgJ6S6U8Zl0d4zMTMuVZzw2HjBQ21DwP0FgJdP1DjTqSDo0N4Q7CYmVaJF6Nn5MjzcXZXoFfr6MEgAg"
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
      "link": "https://palugada.example/?notice=MDEyMzQ1Njc4OTo7PD0-P0BBQkNERUZH",
      "data": {
        "room": "Dapur",
        "startsAt": "2026-11-08T14:00:00.000Z",
        "minutes": 30
      },
      "offers": []
    },
    "canonical": "{\"at\":\"2026-11-08T13:50:00.000Z\",\"company\":{\"name\":\"Toko Kopi\",\"ref\":\"co_SCS6VUU5FYH6FLKQ\"},\"data\":{\"minutes\":30,\"room\":\"Dapur\",\"startsAt\":\"2026-11-08T14:00:00.000Z\"},\"deployment\":\"0b5e4c1d-7a2f-4e6b-9c3d-2f1e0a9b8c7d\",\"id\":\"a9246138-de3d-84ce-909a-3c6a7335a2e9\",\"lang\":\"id\",\"link\":\"https://palugada.example/?notice=MDEyMzQ1Njc4OTo7PD0-P0BBQkNERUZH\",\"offers\":[],\"relay\":\"9d2e8f7a-6b5c-4d3e-8f2a-1b0c9d8e7f6a\",\"share\":\"summary\",\"text\":\"Rapat dimulai sepuluh menit lagi di Dapur.\",\"to\":{\"recipient\":\"DUO7HGJ6ZVY3R2L2UMWI6IR3IM\"},\"type\":\"meeting_soon\",\"urgency\":\"normal\",\"v\":1}",
    "id": "a9246138-de3d-84ce-909a-3c6a7335a2e9",
    "timestamp": "1794145800",
    "signature": "v1a,/DFjp8+8gHxbRy1o5vBpxpzK5KaDGkkmAzo6w/45m/weEYWl6SfVhaxVC6nt0ZdZmxptzgfYuE1R2ul4+apJBQ==",
    "subject": "8a7b6c5d-4e3f-4a2b-9c1d-0e9f8a7b6c5d",
    "link": "5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d"
  },
  "linkEnded": {
    "value": {
      "v": 1,
      "type": "link_ended",
      "at": "2026-11-09T08:00:00.000Z",
      "deployment": "0b5e4c1d-7a2f-4e6b-9c3d-2f1e0a9b8c7d",
      "relay": "9d2e8f7a-6b5c-4d3e-8f2a-1b0c9d8e7f6a",
      "to": {
        "recipient": "DUO7HGJ6ZVY3R2L2UMWI6IR3IM"
      },
      "lang": "id",
      "text": "Ponsel ini tidak lagi ditautkan ke PALUGADA.",
      "data": {
        "claim": "in_2f6a1b9c-0d3e-4f5a-8b7c-6d5e4f3a2b1c",
        "reason": "replaced"
      },
      "id": "21f591e9-9465-8898-b675-799d87adb7f6"
    },
    "canonical": "{\"at\":\"2026-11-09T08:00:00.000Z\",\"data\":{\"claim\":\"in_2f6a1b9c-0d3e-4f5a-8b7c-6d5e4f3a2b1c\",\"reason\":\"replaced\"},\"deployment\":\"0b5e4c1d-7a2f-4e6b-9c3d-2f1e0a9b8c7d\",\"id\":\"21f591e9-9465-8898-b675-799d87adb7f6\",\"lang\":\"id\",\"relay\":\"9d2e8f7a-6b5c-4d3e-8f2a-1b0c9d8e7f6a\",\"text\":\"Ponsel ini tidak lagi ditautkan ke PALUGADA.\",\"to\":{\"recipient\":\"DUO7HGJ6ZVY3R2L2UMWI6IR3IM\"},\"type\":\"link_ended\",\"v\":1}",
    "id": "21f591e9-9465-8898-b675-799d87adb7f6",
    "timestamp": "1794211200",
    "signature": "v1a,/q5OhlNR93c4+MBz63O5MEjEB4Qe2zsf/75rO1N36RGc0R7wRWQ0EWzzb+uGHuXOvt3N10pAHPQh3aXuNF5GAw==",
    "subject": "5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d",
    "link": "5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d"
  },
  "companyForgotten": {
    "value": {
      "v": 1,
      "type": "company_forgotten",
      "at": "2026-11-09T09:00:00.000Z",
      "deployment": "0b5e4c1d-7a2f-4e6b-9c3d-2f1e0a9b8c7d",
      "relay": "9d2e8f7a-6b5c-4d3e-8f2a-1b0c9d8e7f6a",
      "company": {
        "ref": "co_SCS6VUU5FYH6FLKQ"
      },
      "data": {},
      "id": "3480cbf2-d898-8045-b897-cc081ebb8975"
    },
    "canonical": "{\"at\":\"2026-11-09T09:00:00.000Z\",\"company\":{\"ref\":\"co_SCS6VUU5FYH6FLKQ\"},\"data\":{},\"deployment\":\"0b5e4c1d-7a2f-4e6b-9c3d-2f1e0a9b8c7d\",\"id\":\"3480cbf2-d898-8045-b897-cc081ebb8975\",\"relay\":\"9d2e8f7a-6b5c-4d3e-8f2a-1b0c9d8e7f6a\",\"type\":\"company_forgotten\",\"v\":1}",
    "id": "3480cbf2-d898-8045-b897-cc081ebb8975",
    "timestamp": "1794214800",
    "signature": "v1a,wdK9BN6DGXAr5oW1LDJ/9OL0JAtEQOz+HT/GWo81nFpJYrvqETQZS3+4v9XsD+NgSwf478zMWkfRcqI+2LWUBg==",
    "subject": "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
    "link": null
  },
  "actResult": {
    "value": {
      "v": 1,
      "type": "act_result",
      "at": "2026-11-08T12:02:00.000Z",
      "deployment": "0b5e4c1d-7a2f-4e6b-9c3d-2f1e0a9b8c7d",
      "relay": "9d2e8f7a-6b5c-4d3e-8f2a-1b0c9d8e7f6a",
      "data": {
        "ref": "in_7c6b5a49-3827-4615-9504-f3e2d1c0b9a8",
        "status": 200,
        "answer": {
          "ok": true,
          "result": {
            "act": "approve"
          },
          "text": "Diputuskan lewat Relay Toko."
        }
      },
      "id": "1861b606-a9b4-8dcc-9034-1bb2f4e300c1"
    },
    "canonical": "{\"at\":\"2026-11-08T12:02:00.000Z\",\"data\":{\"answer\":{\"ok\":true,\"result\":{\"act\":\"approve\"},\"text\":\"Diputuskan lewat Relay Toko.\"},\"ref\":\"in_7c6b5a49-3827-4615-9504-f3e2d1c0b9a8\",\"status\":200},\"deployment\":\"0b5e4c1d-7a2f-4e6b-9c3d-2f1e0a9b8c7d\",\"id\":\"1861b606-a9b4-8dcc-9034-1bb2f4e300c1\",\"relay\":\"9d2e8f7a-6b5c-4d3e-8f2a-1b0c9d8e7f6a\",\"type\":\"act_result\",\"v\":1}",
    "id": "1861b606-a9b4-8dcc-9034-1bb2f4e300c1",
    "timestamp": "1794139320",
    "signature": "v1a,9LIbWxOJMNbCASqb6FGvgwxEbm/UdKlbigFeonSVBlr77+NTfXHUDrHX8j+o447f2P9PGktaU5TIa9BPieGTAA==",
    "subject": "in_7c6b5a49-3827-4615-9504-f3e2d1c0b9a8",
    "link": null
  },
  "relayKeyRotated": {
    "previousSeed": "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",
    "previousKey": "LGoolcSz_OiTymYmwVydCNz0qaGz99Qtk0bo3UIDr9E",
    "previousFingerprint": "VSQW3IRUXLBJ5LOKRN2JTSNI",
    "seed": "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0",
    "key": "KYdIeQCHlfe8zbUuUyNRO7koBCsBvI7S2_T63g9oz7c",
    "fingerprint": "MEDC2ESCRTACYF4UHEKYVCFP",
    "value": {
      "v": 1,
      "type": "relay_key_rotated",
      "at": "2026-11-10T10:00:00.000Z",
      "key": "KYdIeQCHlfe8zbUuUyNRO7koBCsBvI7S2_T63g9oz7c",
      "previous": {
        "key": "LGoolcSz_OiTymYmwVydCNz0qaGz99Qtk0bo3UIDr9E",
        "until": "2026-11-17T10:00:00.000Z"
      }
    },
    "canonical": "{\"at\":\"2026-11-10T10:00:00.000Z\",\"key\":\"KYdIeQCHlfe8zbUuUyNRO7koBCsBvI7S2_T63g9oz7c\",\"previous\":{\"key\":\"LGoolcSz_OiTymYmwVydCNz0qaGz99Qtk0bo3UIDr9E\",\"until\":\"2026-11-17T10:00:00.000Z\"},\"type\":\"relay_key_rotated\",\"v\":1}",
    "id": "in_9a8b7c6d-5e4f-4321-8fed-cba987654321",
    "timestamp": "1794304800",
    "signature": "v1a,w6sy8OiT64L3h1C35T7Vjm7QkGcPo/4xOv94ag5k0stkz35uZNCDKKPTkn18qsN7GiYqciLuKBYLTnDpeGdQBA== v1a,6JpphOD2s71pNW9cjoDcFTam0zx21LN5ahzEI4dfNOYj++Ey1COX4rIEUu9t2vHGzMzhF4E/8Mhl6pv+gxbVCg=="
  }
}
```

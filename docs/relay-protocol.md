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
- A company is `ref = "co_" + base32(HMAC-SHA256(salt, company id))[:16]`.

So a relay sees the same person as the same recipient every time, and two
relays cannot join what each knows.

### 2.3 Rotating the deployment's key

The owner may give the deployment a new key. For seven days after, every
envelope carries two signatures, the new key's and the old one's, and every
paired relay is sent a `keys_rotated` envelope that both sign. A relay that
pinned the old key verifies it with that key and pins the new one from it. A
relay MUST keep accepting the old key until the `until` the envelope names,
and SHOULD stop after.

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
| `webhook-id` | the message id |
| `webhook-timestamp` | the time of signing, in seconds |
| `webhook-signature` | `v1a,<base64 signature>`, and while a key is rotated a second one after a space |
| `palugada-key` | the `kid` of the deployment's current key (deployment to relay only) |
| `palugada-relay-version` | `1` (deployment to relay only) |
| `content-type` | `application/json` |

A receiver MUST refuse a message whose signature does not verify with a key
it holds for the sender, and one signed more than 300 seconds from its own
clock, either way. A receiver MUST NOT take an HMAC (`v1`) signature in place
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
| `link` | for a person | where it opens in PALUGADA, or `null`; it carries `?company=&item=` or `&task=` |
| `data` | per type | what the share level allows, below |
| `offers` | `inbox_item` | `[{ "token", "act", "label" }]`: what the person may press (section 8) |

A relay MUST ignore a field it does not know, and SHOULD ignore an envelope
type it does not know.

### 6.1 Share levels

What a person is told is the lower of the relay's level and their own:

- `signal`: that something happened, how urgent, and where it opens. No
  company name, no title, nothing to press.
- `summary`: adds the company's name, the title (with any secret in it
  redacted), and the buttons the person may press.
- `content`: adds what the item says: the action, the question and its
  choices, a digest's or a finished task's text.

### 6.2 Urgency

| Value | When | The relay may |
|---|---|---|
| `interrupt` | an incident, or an approval at tier 3 | ring the phone |
| `normal` | something the person may decide or answer | show a notification |
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
signed with both keys.

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

## 7. The outbox and delivery

- **The id is fixed.** An envelope's id is a UUID made from the SHA-256 of
  `deployment`, `relay`, the link, the type, what it is about and a version,
  joined by line feeds; the first 16 bytes, with the version nibble set to 8
  and the RFC 4122 variant. The same notice is the same id however often it
  is sent, so a relay drops a repeat by its `webhook-id`.
- **Delivered** is a `2xx` answer, or `409`, which a relay MAY answer for an
  id it already has.
- **Anything else is tried again** under the same id, after 30 seconds, then
  1, 2, 4, 8, 16 and 32 minutes. After eight attempts the envelope is given
  up and shown to the owner, who may send it again.
- **A send cut off** -- the deployment stopped before it learned the answer --
  is sent again after ten minutes, under the same id.
- **Order** is kept for each person: a later envelope for one link waits
  behind an earlier one still owed.
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
carry `device_sig`: the device's Ed25519 signature, base64url, over the bytes

```
palugada-device/v1\n<canonical JSON of the fields>
```

where the fields are `deployment`, `relay`, `recipient`, `type`, `at` (the
act's own `at`), and, where they apply, `token`, `sha256` (the hex SHA-256 of
the free text the act carries: an answer, or a reply's words) and `clientId`.
A relay holding only its own key therefore cannot make an act.

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

`after` is omitted on the first pull. Each envelope is taken exactly as if it
were pushed, and the next pull names the cursor.

### 9.1 The checks, in order

1. The relay exists and is paired; otherwise `401`.
2. The signature verifies with the relay's pinned key (`401`), within 300
   seconds (`408`). Nothing is written for an unknown relay or a bad
   signature; it is only counted.
3. The envelope id is new. A repeat is answered as the first one was.
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
| `200` | `{ "ok": true, "result": … }` | taken |
| `401` | `{ "ok": false, "code" }` | unknown or revoked relay, bad signature |
| `408` | `{ "ok": false, "code": "relay.stale" }` | signed more than 300 seconds from now |
| `409` | `{ "ok": false, "code": "inbox.not_open", "text" }` | a press for an item that has closed: `text` says how, in the person's language, and nothing changes |
| `410` | `{ "ok": false, "code": "relay.link_ended" }` | the link has ended |
| `422` | `{ "ok": false, "code" }` | refused, by one of the codes below, or by the inbox's own rule (such as `approval.own_instigation`: four eyes) |
| `429` | `{ "ok": false, "code": "relay.throttled" }` | too many |

The `422` codes: `relay.unknown_type`, `relay.press_off`, `relay.press_unknown`,
`relay.press_spent`, `relay.press_tier3`, `relay.device_sig`,
`relay.owner_device`, `relay.not_member`, `relay.seat_changed`,
`relay.post_off`, `relay.link_unknown`. An answer never repeats what an item
says.

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
room. Known, and refused (`relay.post_off`) until people's notices offer it;
when they do it is always a plain message from that person, and never the
owner's words given as work.

#### `read`

`{ token, device_sig? }`: a read mark. Refused (`relay.post_off`) until
people's notices offer it.

#### `mute`

`{ token, until, device_sig? }`: a room muted until a time, or `null`. Refused
(`relay.post_off`) until people's notices offer it.

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
(`inbox_closed`), and SHOULD keep content no longer than fourteen days. A
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
envelope, prints it, drops retracted content, and forwards `text` and `link`
to ntfy (`RELAY_NTFY_URL`, `RELAY_NTFY_TOKEN`) at priority 5 for `interrupt`,
3 for `normal` and 2 for `quiet`. Its commands `link <code>`,
`press <token> [answer]` and `reply <token> <text>` act as a phone's app
would, with a device key for each link.

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
  }
}
```

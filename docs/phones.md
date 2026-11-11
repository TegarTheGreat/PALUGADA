# Telling your staff's phones

PALUGADA tells a person's phone what is theirs -- someone wrote to them,
mentioned them or replied in a thread they follow, a run's question was put
to them, an approval waits that they may decide, work they asked for ended, a
meeting they were asked to starts in ten minutes --
through a **relay**: a small service, run by you or someone you trust, that
receives signed notices from your deployment and passes them on. The
protocol is `docs/relay-protocol.md`. Until a hosted relay exists, the one
that ships with PALUGADA, `scripts/relay-reference.ts`, is the supported way
to do it, with [ntfy](https://ntfy.sh) putting the notices on each phone.

This page is for the owner. It takes about twenty minutes the first time.

## What a person is told, and what they are not

- A notice says **who and where**: "Budi (@budi) mentioned you in Kitchen."
  The words themselves go only when you set a relay's share to `content`, and
  only to a person who did not lower their own share.
- A person is told only about rooms they can still see, never of their own
  words, at most once a room every ten minutes (the rest are counted on that
  one notice), at most their **Notices a day** (30 for staff, 10 for you), and
  never in their **Quiet hours**. Each person sets both in their profile.
- **You** hear people only after you turn on *Hear from people outside the
  inbox* in your profile, and only inside your window. A person's notice is
  never an inbox item: your day is what your inbox counts.
- Nothing is sent about a person who has not linked a phone. The mention
  picker marks such a person "not told outside PALUGADA", and you too until
  you hear from people, on a phone or in your Telegram.
- A relay is never sent a room list, a room's history, who is in a room,
  anyone else's notices, or the id of a company, room, thread, item or task.
  A notice's link opens PALUGADA, and shows what it is about only to the
  person it was for, once they have signed in.
- A person taken out of a private room is not told of it, even of a notice
  written before. A deleted message, or one whose time was up under your
  retention, is withdrawn from the relay, and one not yet sent is never sent.
  A relay drops everything it was told after fourteen days, as the protocol
  requires, because PALUGADA can withdraw nothing older. What a relay already
  handed to ntfy, showed on a phone's lock screen, or wrote to a log, no
  withdrawal reaches: keep shares low where that matters.
- You can tell a relay less about one company than about the rest (its
  **What each company's notices may say**, in the relay's settings). A
  person is told the lowest of the relay's share, their company's, and their
  own.

## 1. Run the reference relay

On a machine that can reach your deployment, or that your deployment can
reach (the relay is pulled from, so it may sit behind NAT):

```sh
# The 24 characters PALUGADA shows under This deployment, Relays.
npm run relay:reference -- serve --deployment-fingerprint ABCD1234EFGH5678IJKL9012 \
  --public-url https://relay.example.com --state relay-state.json
```

It prints its own fingerprint. It pairs only with the deployment whose
fingerprint you gave it, and once paired it takes no other pairing until you
delete its state file by hand, except your deployment pairing it again
(below).

Its state file keeps everything it must across a restart: its key, the
pairing, what it still owes your deployment, and the key of each phone
linked through it. **Whoever has that file can act as everyone linked
through this relay**, you included: keep it as you keep a password, readable
only by the user that runs the relay.

It prints only that something arrived and for whom, and the commands for
each notice's buttons, never the words or the links, so a log of its output
holds nothing a share hides. Add `--print-content` only to try it out.

The commands below reach the relay on a second port of its own, bound to
this machine alone (`--local-port`, one above `--port` unless you say);
nothing in front of the relay can forward to it.

## 2. Give it ntfy, privately

Set `RELAY_NTFY_URL` to your ntfy server and, unless it is your own server on
a private network, `RELAY_NTFY_TOKEN` to an access token for it, before you
start the relay. Each person gets **one topic of their own**,
`palugada-<their recipient id in lower case>`; the relay prints the recipient
when their phone is linked (`link_confirmed for …`).

Topics on the public ntfy.sh are readable by anyone who guesses their name.
Use a self-hosted ntfy, or one that needs a token, for any share above
`signal`; the relay warns you at start when it has no token.

## 3. Pair it in PALUGADA

In the console, **This deployment, Relays**:

1. Add the relay by its address. PALUGADA shows its fingerprint.
2. Type at least the first sixteen characters of the fingerprint the relay
   printed, choose the companies it may hear about, and give your code.
3. Choose what it is told. Start at `signal` ("something new in PALUGADA");
   raise it to `summary` (who and where) or `content` (the words) only with a
   private ntfy. Presses and replies stay off until you turn them on;
   your own phone needs a key of its own before a press or a reply of yours
   counts. Under **What each company's notices may say** you can hold a
   company below the relay's share.

If the relay ever cannot verify what PALUGADA sends -- it lost its state
file, or was given PALUGADA's fingerprint wrong -- it refuses every envelope,
and its card says "The relay answered 401." and, after eight tries, counts
what it gave up on; a relay still owed PALUGADA's new key says so too, and
PALUGADA keeps trying that one hourly for as long as the relay is paired.
(Only a relay that answers 410 shows "The relay forgot this deployment: pair it again.")
Start the relay with the fingerprint PALUGADA shows now, then press **Pair
again** on its card and type the relay's fingerprint as the first time.
Everyone's links and your settings stay as they are, and the new key it
missed is taken from the pairing. The companies you name then are the ones
it hears about from then on: leave one out and that company's people's
phones are unlinked from this relay.

PALUGADA's own key changes with **New key**, on the same page; a second one
waits until every relay has taken the first. The reference relay changes its
own key with `npm run relay:reference -- rotate-key`, which PALUGADA takes
because the old key and the new both sign it.

## 4. Each person links their phone

Each person opens **Your profile, Phones**, and presses **Link a phone**
beside the relay. They get eight characters, good for ten minutes. With the
reference relay, whoever runs it enters the code on the relay's machine:

```sh
npm run relay:reference -- link ABCD2345
```

The relay makes a key for that link and signs everything sent for it, and
prints the key's fingerprint; PALUGADA shows the same fingerprint beside the
link under **Your profile, Phones**. Compare the two: if they differ,
unlink. The key lives on the relay, in its state file, so it protects a
person against someone who later steals the relay's key, not against
whoever runs the relay. The person then subscribes to their own topic in the
ntfy app.

A person has one link through a relay: linking again ends the earlier one.
Unlinking is in the same place, and ending a seat ends its links at once;
either way the relay is told, and forgets that phone's key.

## 5. What can come back

From a notice about a room, the reference relay's operator can send back, for
that person and that room alone:

```sh
npm run relay:reference -- reply <token> On my way.   # only when replies are on
npm run relay:reference -- read <token>
npm run relay:reference -- mute <token> 8              # hours
```

A reply is a plain message from that person, in the room and thread the
notice named, marked as having come through the relay. It never becomes work,
and it is never the owner's words. A press decides an approval at tier 2 or
below for someone who may decide it now; tier 3 is decided in the app.

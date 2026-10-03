/**
 * Nederlands: what the platform itself says to the owner outside the console
 * (src/owner/say.ts), keyed by its English.
 *
 * The words are the console's (console/src/locales/nl.ts): the owner is
 * "je/jij"; Goedkeuren, Afwijzen and Vraag stellen on the buttons; “Deze
 * installatie, Tools, Spraakherkenning” for the screens it points at.
 * WhatsApp cuts a reply button's title at 20 characters and a list row's at
 * 24, so those stay short.
 */
export const SENTENCES: Readonly<Record<string, string>> = {
  'Incident: {title}': 'Incident: {title}',
  'Done: {goal}': 'Klaar: {goal}',
  'Stopped before finishing: {goal}': 'Gestopt voor het klaar was: {goal}',
  'Not done: {goal}': 'Niet gedaan: {goal}',
  'Why: {reason}': 'Reden: {reason}',
  'a task': 'een taak',
  'Approval needed: {title}': 'Goedkeuring nodig: {title}',
  '{summary} — if denied: {consequence}': '{summary} – bij afwijzing: {consequence}',
  '{role} asks:': '{role} vraagt:',
  'If denied:': 'Bij afwijzing:',
  'Expires:': 'Verloopt:',
  'This one is decided in the app.': 'Hierover wordt in de app beslist.',
  'Open in PALUGADA': 'Openen in PALUGADA',
  'Approve': 'Goedkeuren',
  'Deny': 'Afwijzen',
  'Ask': 'Vraag stellen',
  'Approved. Nothing left to press here.': 'Goedgekeurd. Hier valt niets meer aan te tikken.',
  'Denied. Nothing left to press here.': 'Afgewezen. Hier valt niets meer aan te tikken.',
  'Expired unanswered. Silence is a refusal, so nothing was done.':
    'Onbeantwoord verlopen. Stilte is een weigering, dus er is niets gedaan.',
  'This bot only answers to its owner.': 'Deze bot antwoordt alleen zijn eigenaar.',
  'That one has to be approved in the app.': 'Dit moet in de app worden goedgekeurd.',
  'That could not be recorded.': 'Dat kon niet worden vastgelegd.',
  'That item no longer exists.': 'Dat item bestaat niet meer.',
  'What do you want to ask about "{title}"? Reply to this message.':
    'Wat wil je vragen over “{title}”? Antwoord op dit bericht.',
  'Your question': 'Je vraag',
  'Type your question as a reply.': 'Typ je vraag als antwoord op dit bericht.',
  'Asked. The answer will be on the item in the app.': 'Gevraagd. Het antwoord verschijnt bij het item in de app.',
  'Answer': 'Antwoorden',
  'Answer in words': 'Met eigen woorden',
  'That choice is not on this question.': 'Die keuze hoort niet bij deze vraag.',
  'Chosen: {choice}.': 'Gekozen: {choice}.',
  'Stop the task': 'Taak stoppen',
  'Your answer to "{question}"? Reply to this message.': 'Je antwoord op “{question}”? Antwoord op dit bericht.',
  'Your answer': 'Je antwoord',
  'Type your answer as a reply.': 'Typ je antwoord als reactie op dit bericht.',
  'Answered. The task carries on with it.': 'Beantwoord. De taak gaat ermee verder.',
  'That is too long for one question; keep it under {max} characters.':
    'Dat is te lang voor één vraag; blijf onder de {max} tekens.',
  '[a key, not kept]': '[een sleutel, niet bewaard]',
  'That looks like a key, so I did not keep it or send it anywhere. Keys go in the sealed field on a card, or on their page in This deployment: tell me what it is for and I will put the card in front of you.':
    'Dat lijkt op een sleutel, dus ik heb hem niet bewaard en nergens heen gestuurd. Sleutels horen in het verzegelde veld op een kaart, of op hun pagina onder “Deze installatie”: vertel me waar hij voor is en ik leg de kaart aan je voor.',
  'No model is set up yet, so I cannot think. Choose one under This deployment, Model; then I can help with everything else.':
    'Er is nog geen model ingesteld, dus ik kan niet denken. Kies er een onder “Deze installatie, Model”; dan kan ik met al het andere helpen.',
  'The model did not answer: {reason}': 'Het model antwoordde niet: {reason}',
  'Here is what I propose.': 'Dit stel ik voor.',
  'I have nothing to add.': 'Ik heb niets toe te voegen.',
  '{name}, CEO of {company}': '{name}, CEO van {company}',
  'That could not be answered: {reason}': 'Daar kon geen antwoord op worden gegeven: {reason}',
  'I read text and voice notes.': 'Ik lees tekst en spraakberichten.',
  'Now talking to {name}.': 'Je praat nu met {name}.',
  'Choose whom to talk to.': 'Kies met wie je wilt praten.',
  'Choose whom to talk to': 'Kiezen met wie je praat',
  'Talk to PALUGADA about the whole deployment': 'Met PALUGADA praten over de hele installatie',
  'Who you are talking to, and how': 'Met wie je praat, en hoe',
  'Stopped.': 'Gestopt.',
  'Write here to talk to {name}.': 'Schrijf hier om met {name} te praten.',
  'You are talking to {name}. Write, or send a voice note. /ceo chooses whom you talk to; /palugada talks to PALUGADA about the whole deployment.':
    'Je praat met {name}. Schrijf, of stuur een spraakbericht. Met /ceo kies je met wie je praat; met /palugada praat je met PALUGADA over de hele installatie.',
  'You said: "{words}"': 'Je zei: “{words}”',
  'in the app': 'in de app',
  'Apply: {summary}': 'Toepassen: {summary}',
  'Nothing hears speech yet: choose a provider in the app, under This deployment, Tools, Listening.':
    'Er luistert nog niets naar spraak: kies in de app een aanbieder onder “Deze installatie, Tools, Spraakherkenning”.',
  'That recording is too long; keep a voice note under {max} MB.': 'Die opname is te lang; houd een spraakbericht onder de {max} MB.',
  'I could not make out any words in that.': 'Ik kon daar geen woorden in verstaan.',
  'Done: {summary}': 'Gedaan: {summary}',
  'That one is applied in the app.': 'Deze kaart wordt in de app toegepast.',
  'That card no longer exists.': 'Die kaart bestaat niet meer.',
  'That card was already applied.': 'Die kaart is al toegepast.',
  'That card was dismissed.': 'Die kaart is genegeerd.',
  'That card failed when it was applied.': 'Die kaart is mislukt bij het toepassen.',
  'That could not be done: {reason}': 'Dat kon niet worden gedaan: {reason}',
  'Choose': 'Kiezen',
  'What do you want to ask about "{title}"? Reply to this message with your question.':
    'Wat wil je vragen over “{title}”? Antwoord op dit bericht met je vraag.',
  'Your answer to "{question}"? Reply to this message with your answer.':
    'Je antwoord op “{question}”? Reageer op dit bericht met je antwoord.',
  'I read text messages here.': 'Hier lees ik tekstberichten.',
  'Apply one of these here:': 'Pas hier een van deze toe:',
  'Apply {number}': '{number} toepassen',
  'Signed in to {provider} for the {alias} key': 'Ingelogd bij {provider} voor de sleutel {alias}',
  'Go back to PALUGADA: the division holds this key now, and it is renewed before it runs out. This tab can be closed.':
    'Ga terug naar PALUGADA: de afdeling heeft deze sleutel nu, en hij wordt vernieuwd voordat hij verloopt. Je kunt dit tabblad sluiten.',
  'Signed in to {name}': 'Ingelogd bij {name}',
  'Go back to PALUGADA to choose which of its tools roles may use. This tab can be closed.':
    'Ga terug naar PALUGADA om te kiezen welke tools rollen mogen gebruiken. Je kunt dit tabblad sluiten.',
  'Not signed in': 'Niet ingelogd',
  'Recorded: approved.': 'Vastgelegd: goedgekeurd.',
  'Recorded: denied.': 'Vastgelegd: afgewezen.',
  'Recorded: asked.': 'Vastgelegd: vraag gesteld.',
  'Asked. Nothing left to press here.': 'Vraag gesteld. Hier valt niets meer aan te tikken.',
  'Withdrawn: the task it was asking about has finished.': 'Ingetrokken: de taak waar het om ging, is afgerond.',
  'Withdrawn: the task it was asking about has failed.': 'Ingetrokken: de taak waar het om ging, is mislukt.',
  'Withdrawn: the task it was asking about was stopped.': 'Ingetrokken: de taak waar het om ging, is stilgezet.',
  'Withdrawn: the task it was asking about was cancelled.': 'Ingetrokken: de taak waar het om ging, is geannuleerd.',
  'Decided. Nothing left to press here.': 'Beslist. Hier valt niets meer aan te tikken.',
  'Withdrawn: the agent changed what it proposes and asked again about the new one.': 'Ingetrokken: de agent stelt nu iets anders voor en heeft daar opnieuw om gevraagd.',
  'Withdrawn: the company is no longer at the stage this proposal would move it from.': 'Ingetrokken: het bedrijf zit niet meer in de fase waaruit dit voorstel het zou verplaatsen.',
  'Withdrawn: it was already decided in the app.': 'Ingetrokken: hierover is al in de app beslist.',
  'Withdrawn. Nothing left to press here.': 'Ingetrokken. Hier valt niets meer aan te tikken.',
  'company': 'bedrijf',
  'Work stopped: the {account} account is out of tokens': 'Werk gestopt: het account {account} heeft geen tokens meer',
  '"{work}" stopped because the {account} account has used {spent} of its {max} tokens. Raise its ceiling under Money, then open the task and press Continue: it carries on from where it stopped.': '‘{work}’ is gestopt omdat het account {account} {spent} van zijn {max} tokens heeft gebruikt. Verhoog het plafond onder Financiën, open dan de taak en druk op Doorgaan: die gaat verder waar hij stopte.',
  'Withdrawn: you continued the task it was about.': 'Ingetrokken: u hebt de taak waar het over ging voortgezet.',
};

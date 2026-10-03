/**
 * Français: what the platform itself says to the owner outside the console
 * (src/owner/say.ts), keyed by its English.
 *
 * The words are the console's (console/src/locales/fr.ts): the owner is
 * « vous »; Approuver, Refuser and Poser une question on the buttons;
 * « Cette instance, Outils, Écoute » for the screens it points at; a
 * non-breaking space before : ; ? ! and inside « ». WhatsApp cuts a reply
 * button's title at 20 characters and a list row's at 24, so those stay short.
 */
export const SENTENCES: Readonly<Record<string, string>> = {
  "Incident: {title}": "Incident : {title}",
  "Done: {goal}": "Terminée : {goal}",
  "Stopped before finishing: {goal}": "Arrêtée avant la fin : {goal}",
  "Not done: {goal}": "Pas faite : {goal}",
  "Why: {reason}": "Motif : {reason}",
  "a task": "une tâche",
  "Approval needed: {title}": "Approbation requise : {title}",
  "{summary} — if denied: {consequence}": "{summary} — en cas de refus : {consequence}",
  "{role} asks:": "{role} demande :",
  "If denied:": "En cas de refus :",
  "Expires:": "Expire :",
  "This one is decided in the app.": "Cette décision se prend dans l’application.",
  "Open in PALUGADA": "Ouvrir dans PALUGADA",
  "Approve": "Approuver",
  "Deny": "Refuser",
  "Ask": "Poser une question",
  "Approved. Nothing left to press here.": "Approuvé. Il n’y a plus rien à faire ici.",
  "Denied. Nothing left to press here.": "Refusé. Il n’y a plus rien à faire ici.",
  "Expired unanswered. Silence is a refusal, so nothing was done.":
    "Expiré sans réponse. Le silence vaut refus : rien n’a été fait.",
  "This bot only answers to its owner.": "Ce bot ne répond qu’à son propriétaire.",
  "That one has to be approved in the app.": "Celui-ci doit être approuvé dans l’application.",
  "That could not be recorded.": "Impossible d’enregistrer cela.",
  'That item no longer exists.': 'Cet élément n’existe plus.',
  "What do you want to ask about \"{title}\"? Reply to this message.":
    "Que voulez-vous demander à propos de « {title} » ? Répondez à ce message.",
  "Your question": "Votre question",
  "Type your question as a reply.": "Écrivez votre question en réponse à ce message.",
  "Asked. The answer will be on the item in the app.":
    "Question posée. La réponse apparaîtra sur l’élément, dans l’application.",
  "Answer": "Répondre",
  "Answer in words": "Répondre par écrit",
  "That choice is not on this question.": "Ce choix ne fait pas partie de cette question.",
  "Chosen: {choice}.": "Choisi : {choice}.",
  "Stop the task": "Arrêter la tâche",
  "Your answer to \"{question}\"? Reply to this message.":
    "Votre réponse à « {question} » ? Répondez à ce message.",
  "Your answer": "Votre réponse",
  "Type your answer as a reply.": "Écrivez votre réponse en répondant à ce message.",
  "Answered. The task carries on with it.": "Réponse envoyée. La tâche continue avec elle.",
  "That is too long for one question; keep it under {max} characters.":
    "C’est trop long pour une seule question ; restez sous les {max} caractères.",
  "[a key, not kept]": "[une clé, non conservée]",
  "That looks like a key, so I did not keep it or send it anywhere. Keys go in the sealed field on a card, or on their page in This deployment: tell me what it is for and I will put the card in front of you.":
    "Cela ressemble à une clé : je ne l’ai donc ni conservée ni envoyée nulle part. Les clés vont dans le champ scellé d’une carte, ou sur leur page dans Cette instance : dites-moi à quoi elle sert et je vous présenterai la carte.",
  "No model is set up yet, so I cannot think. Choose one under This deployment, Model; then I can help with everything else.":
    "Aucun modèle n’est encore configuré, je ne peux donc pas réfléchir. Choisissez-en un dans Cette instance, Modèle ; ensuite, je pourrai vous aider pour tout le reste.",
  "The model did not answer: {reason}": "Le modèle n’a pas répondu : {reason}",
  "Here is what I propose.": "Voici ce que je propose.",
  "I have nothing to add.": "Je n’ai rien à ajouter.",
  "{name}, CEO of {company}": "{name}, CEO de {company}",
  "That could not be answered: {reason}": "Impossible de répondre : {reason}",
  "I read text and voice notes.": "Je lis les textes et les notes vocales.",
  "Now talking to {name}.": "Vous parlez maintenant à {name}.",
  "Choose whom to talk to.": "Choisissez votre interlocuteur.",
  "Choose whom to talk to": "Choisir son interlocuteur",
  "Talk to PALUGADA about the whole deployment": "Parler à PALUGADA de toute l’instance",
  "Who you are talking to, and how": "À qui vous parlez, et comment",
  "Stopped.": "Arrêté.",
  "Write here to talk to {name}.": "Écrivez ici pour parler à {name}.",
  "You are talking to {name}. Write, or send a voice note. /ceo chooses whom you talk to; /palugada talks to PALUGADA about the whole deployment.":
    "Vous parlez à {name}. Écrivez, ou envoyez une note vocale. /ceo choisit votre interlocuteur ; /palugada parle à PALUGADA de toute l’instance.",
  "You said: \"{words}\"": "Vous avez dit : « {words} »",
  "in the app": "dans l’application",
  "Apply: {summary}": "Appliquer : {summary}",
  "Nothing hears speech yet: choose a provider in the app, under This deployment, Tools, Listening.":
    "Rien n’écoute encore la voix : choisissez un fournisseur dans l’application, dans Cette instance, Outils, Écoute.",
  "That recording is too long; keep a voice note under {max} MB.":
    "Cet enregistrement est trop long ; une note vocale doit faire moins de {max} Mo.",
  "I could not make out any words in that.": "Je n’y ai distingué aucun mot.",
  "Done: {summary}": "Fait : {summary}",
  "That one is applied in the app.": "Celle-ci s’applique dans l’application.",
  "That card no longer exists.": "Cette carte n’existe plus.",
  "That card was already applied.": "Cette carte a déjà été appliquée.",
  "That card was dismissed.": "Cette carte a été ignorée.",
  "That card failed when it was applied.": "Cette carte a échoué lors de son application.",
  "That could not be done: {reason}": "Impossible de le faire : {reason}",
  "Choose": "Choisir",
  "What do you want to ask about \"{title}\"? Reply to this message with your question.":
    "Que voulez-vous demander à propos de « {title} » ? Répondez à ce message avec votre question.",
  "Your answer to \"{question}\"? Reply to this message with your answer.":
    "Votre réponse à « {question} » ? Répondez à ce message avec votre réponse.",
  "I read text messages here.": "Ici, je lis les messages texte.",
  "Apply one of these here:": "Appliquez-en une ici :",
  "Apply {number}": "Appliquer {number}",
  "Signed in to {provider} for the {alias} key": "Connecté à {provider} pour la clé {alias}",
  "Go back to PALUGADA: the division holds this key now, and it is renewed before it runs out. This tab can be closed.":
    "Revenez à PALUGADA : le département détient désormais cette clé, et elle est renouvelée avant son expiration. Vous pouvez fermer cet onglet.",
  "Signed in to {name}": "Connecté à {name}",
  "Go back to PALUGADA to choose which of its tools roles may use. This tab can be closed.":
    "Revenez à PALUGADA pour choisir lesquels de ses outils les rôles peuvent utiliser. Vous pouvez fermer cet onglet.",
  "Not signed in": "Non connecté",
  "Recorded: approved.": "Enregistré : approuvé.",
  "Recorded: denied.": "Enregistré : refusé.",
  "Recorded: asked.": "Enregistré : question posée.",
  "Asked. Nothing left to press here.": "Question posée. Il n’y a plus rien à faire ici.",
  "Withdrawn: the task it was asking about has finished.": "Retiré : la tâche concernée est terminée.",
  "Withdrawn: the task it was asking about has failed.": "Retiré : la tâche concernée a échoué.",
  "Withdrawn: the task it was asking about was stopped.": "Retiré : la tâche concernée a été arrêtée.",
  "Withdrawn: the task it was asking about was cancelled.": "Retiré : la tâche concernée a été annulée.",
  'Decided. Nothing left to press here.': 'Tranché. Il n’y a plus rien à faire ici.',
  'Withdrawn: the agent changed what it proposes and asked again about the new one.': 'Retiré : l’agent a modifié sa proposition et a soumis la nouvelle à votre décision.',
  'Withdrawn: the company is no longer at the stage this proposal would move it from.': 'Retiré : l’entreprise n’est plus dans la phase dont cette proposition devait la faire sortir.',
  'Withdrawn: it was already decided in the app.': 'Retiré : c’était déjà tranché dans l’application.',
  'Withdrawn. Nothing left to press here.': 'Retiré. Il n’y a plus rien à faire ici.',
  'Work stopped: the {account} account is out of tokens': 'Le travail s’est arrêté : le compte {account} n’a plus de jetons',
  '"{work}" stopped because the {account} account has used {spent} of its {max} tokens. Raise its ceiling under Money, then open the task and press Continue: it carries on from where it stopped.': '« {work} » s’est arrêté parce que le compte {account} a utilisé {spent} de ses {max} jetons. Relevez son plafond dans Argent, puis ouvrez la tâche et appuyez sur Continuer : elle reprend là où elle s’était arrêtée.',
  'Withdrawn: you continued the task it was about.': 'Retiré : vous avez poursuivi la tâche qu’il concernait.',
};

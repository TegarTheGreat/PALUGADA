/**
 * The owner's console (PRD v2 §5 principle 1, F10).
 *
 * No framework and no build step. This page is where a person approves things
 * that cannot be undone, and a dependency tree is a set of things that can
 * change what the button under their finger does.
 *
 * **It holds no rules.** Whether an item may be approved, whether a second
 * factor is needed, what a chat may put a button on -- none of that is decided
 * here. The API asks `decide`, which is where every surface meets the same
 * gate, and this page's job is to show what came back. A console that decided
 * any of it for itself would be a second implementation to get wrong, and the
 * one that mattered would be the one nobody re-read.
 *
 * **The token lives in memory.** Not `localStorage`: a token there survives a
 * closed tab, is readable by anything that manages to run script on this
 * origin, and buys the owner nothing but skipping one code a day. Closing the
 * tab signs out, which is the behaviour a person already expects from anything
 * that guards money.
 */
'use strict';

const state = {
  token: null,
  companies: [],
  companyId: null,
  items: [],
};

const el = (id) => document.getElementById(id);

/* ------------------------------------------------------------------ wire --- */

async function api(method, path, body) {
  const response = await fetch(path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(state.token ? { authorization: `Bearer ${state.token}` } : {}),
    },
    ...(body === undefined || method === 'GET' ? {} : { body: JSON.stringify(body) }),
  });
  const answer = await response.json().catch(() => ({}));
  if (!response.ok) {
    // A refusal is an answer, and the platform always says which one. Passing
    // the code through means the page can tell "sign in again" from "that code
    // is wrong" from "not over this channel" -- three things an owner would
    // otherwise see as one shrug.
    const error = new Error(answer.error || `HTTP ${response.status}`);
    error.code = answer.code;
    error.status = response.status;
    throw error;
  }
  return answer;
}

/* -------------------------------------------------------------- signing in --- */

el('sign-in-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const error = el('sign-in-error');
  error.hidden = true;
  try {
    const session = await api('POST', '/api/auth/sign-in', { totp: el('code').value.trim() });
    state.token = session.token;
    el('device').textContent = session.device;
    el('who').hidden = false;
    el('sign-in').hidden = true;
    el('console').hidden = false;
    el('code').value = '';
    await refresh();
  } catch (failure) {
    error.textContent = failure.message;
    error.hidden = false;
  }
});

el('sign-out').addEventListener('click', async () => {
  await api('POST', '/api/auth/sign-out', {}).catch(() => undefined);
  state.token = null;
  el('who').hidden = true;
  el('console').hidden = true;
  el('sign-in').hidden = false;
});

/* ---------------------------------------------------------------- the queue --- */

async function refresh() {
  const [{ companies }, control] = await Promise.all([
    api('GET', '/api/companies'),
    api('GET', '/api/control'),
  ]);

  state.companies = companies;
  state.companyId = state.companyId && companies.some((c) => c.id === state.companyId)
    ? state.companyId
    : companies[0]?.id ?? null;

  drawControls(control);
  drawCompanies();
  await drawInbox();
}

function drawControls(control) {
  const button = el('stop-all');
  button.textContent = control.stopAll ? 'Resume everything' : 'Stop everything';
  button.classList.toggle('danger', !control.stopAll);
  el('control-note').textContent = control.stopAll
    ? 'Every company is halted. Nothing is running.'
    : '';
  button.onclick = async () => {
    // Reversible, and both directions are the same button. A stop the owner
    // cannot lift without a database console is one they hesitate to press,
    // and hesitating is the failure F10.7 exists to remove.
    await api('POST', '/api/control/stop-all', { on: !control.stopAll });
    await refresh();
  };
}

function drawCompanies() {
  const nav = el('companies');
  nav.replaceChildren();
  for (const company of state.companies) {
    const button = document.createElement('button');
    button.textContent = company.name + (company.frozen ? ' (frozen)' : '');
    button.className = company.id === state.companyId ? 'tab current' : 'tab';
    button.onclick = async () => {
      state.companyId = company.id;
      drawCompanies();
      await drawInbox();
    };
    nav.append(button);
  }
}

async function drawInbox() {
  const list = el('inbox');
  list.replaceChildren();
  el('digest').replaceChildren();
  if (!state.companyId) return;

  const [{ items }, digest] = await Promise.all([
    api('GET', `/api/companies/${state.companyId}/inbox`),
    api('GET', `/api/companies/${state.companyId}/digest`),
  ]);
  state.items = items;

  drawDigest(digest);
  el('empty').hidden = items.length > 0;
  for (const item of items) list.append(card(item));
}

function drawDigest(digest) {
  // F10.6's limit is one screen, and it is the API that enforces it. The page
  // draws what it is given rather than deciding what fits, so the requirement
  // has one home.
  const box = el('digest');
  const line = document.createElement('p');
  line.textContent =
    `${digest.tasksCompleted} done · ${digest.tasksFailed} failed · `
    + `${digest.tasksHalted} halted · ${money(digest.moneySpentCents)} spent today`;
  box.append(line);
  for (const highlight of digest.highlights ?? []) {
    const item = document.createElement('p');
    item.className = 'muted';
    item.textContent = highlight;
    box.append(item);
  }
}

/**
 * One decision, with everything F10.2 asks for on it.
 *
 * Built with `textContent` throughout and never with HTML. Every string here
 * came from an agent -- a title, a rationale, a consequence -- and an agent is
 * a third party writing into the owner's browser. `textContent` makes that
 * structurally impossible to exploit; a template string would make it a
 * question of escaping, and escaping is a thing people get right until they do
 * not.
 */
function card(item) {
  const li = document.createElement('li');
  li.className = `card kind-${item.kind}`;

  const head = document.createElement('div');
  head.className = 'head';
  const title = document.createElement('strong');
  title.textContent = item.title;
  head.append(title);
  if (item.tier !== null) {
    const tier = document.createElement('span');
    tier.className = `tier tier-${item.tier}`;
    tier.textContent = `tier ${item.tier}`;
    head.append(tier);
  }
  const kind = document.createElement('span');
  kind.className = 'kind';
  kind.textContent = item.kind;
  head.append(kind);
  li.append(head);

  for (const [label, value] of [
    ['Why', item.rationale],
    ['If refused', item.consequenceIfDenied],
  ]) {
    if (!value) continue;
    const row = document.createElement('p');
    const strong = document.createElement('em');
    strong.textContent = `${label}: `;
    row.append(strong, document.createTextNode(value));
    li.append(row);
  }

  if (item.estimatedCostCents > 0) {
    const cost = document.createElement('p');
    cost.className = 'muted';
    cost.textContent = `Estimated cost ${money(item.estimatedCostCents)}`;
    li.append(cost);
  }

  const actions = document.createElement('div');
  actions.className = 'actions';
  for (const decision of ['approve', 'deny', 'ask']) {
    const button = document.createElement('button');
    button.textContent = decision === 'ask' ? 'Ask a question' : decision;
    button.className = decision;
    button.onclick = () => decide(item, decision);
    actions.append(button);
  }
  const why = document.createElement('button');
  why.className = 'link';
  why.textContent = 'What happened';
  why.onclick = () => showTrace(item);
  actions.append(why);
  li.append(actions);

  const failure = document.createElement('p');
  failure.className = 'error';
  failure.hidden = true;
  li.append(failure);
  li.dataset.itemId = item.id;
  return li;
}

/* ------------------------------------------------------------ the decision --- */

async function decide(item, decision) {
  const note = decision === 'ask'
    ? window.prompt('What do you want to ask?') ?? ''
    : '';
  if (decision === 'ask' && !note) return;

  // Tried without a factor first, deliberately. The page does not read the
  // tier to decide whether one is needed -- `decide` decides, and asking it is
  // how the console stays out of the business of implementing F10.10.
  try {
    await send(item, decision, note);
    await drawInbox();
  } catch (failure) {
    if (failure.code === 'approval.channel_forbidden') {
      await confirmWithFactor(item, decision, note);
      return;
    }
    showCardError(item, failure.message);
  }
}

async function send(item, decision, note, proof) {
  await api('POST', `/api/companies/${state.companyId}/inbox/${item.id}/decide`, {
    decision,
    note,
    ...(proof ? { proof } : {}),
  });
}

function confirmWithFactor(item, decision, note) {
  const dialog = el('factor');
  const error = el('factor-error');
  const input = el('factor-code');
  el('factor-what').textContent = item.title;
  error.hidden = true;
  input.value = '';
  dialog.showModal();
  input.focus();

  return new Promise((resolve) => {
    const cancel = () => {
      dialog.close();
      cleanup();
      resolve();
    };
    const submit = async (event) => {
      event.preventDefault();
      error.hidden = true;
      try {
        await send(item, decision, note, { totp: input.value.trim() });
        dialog.close();
        cleanup();
        await drawInbox();
        resolve();
      } catch (failure) {
        // Shown here rather than on the card, because the owner is looking at
        // this box: "that code is wrong" and "that has been used" and "locked
        // out" are three different next actions.
        error.textContent = failure.message;
        error.hidden = false;
        input.value = '';
        input.focus();
      }
    };
    const cleanup = () => {
      el('factor-form').removeEventListener('submit', submit);
      el('factor-cancel').removeEventListener('click', cancel);
    };
    el('factor-form').addEventListener('submit', submit);
    el('factor-cancel').addEventListener('click', cancel);
  });
}

function showCardError(item, message) {
  const card = document.querySelector(`[data-item-id="${CSS.escape(item.id)}"] .error`);
  if (!card) return;
  card.textContent = message;
  card.hidden = false;
}

/* ------------------------------------------------------------------ F11.2 --- */

async function showTrace(item) {
  const dialog = el('trace');
  const body = el('trace-body');
  body.textContent = 'Loading…';
  dialog.showModal();
  try {
    const trace = await api(
      'GET', `/api/companies/${state.companyId}/inbox/${item.id}/trace`,
    );
    body.textContent = trace.reason
      ? trace.reason
      : JSON.stringify({ runs: trace.runs, calls: trace.calls }, null, 2);
  } catch (failure) {
    body.textContent = failure.message;
  }
}

el('trace-close').addEventListener('click', () => el('trace').close());

/* ------------------------------------------------------------------ small --- */

function money(cents) {
  return `${(cents / 100).toFixed(2)}`;
}

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
  tab: 'decisions',
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
  drawTabs();
  await drawTab();
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
    try {
      await api('POST', '/api/control/stop-all', { on: !control.stopAll });
      el('control-note').textContent = '';
    } catch (failure) {
      // Said out loud. A stop that silently did not happen is worse than one
      // that refused, because the owner walks away believing the platform is
      // halted -- and this is the button they press when something is on fire.
      el('control-note').textContent = `That did not take effect: ${failure.message}`;
      return;
    }
    await refresh();
  };

  // The other half of F10.7, and a separate button because it is a separate
  // decision: this one ends the tasks rather than pausing them, and nothing
  // resumes afterwards. Irreversible, so it asks for the authenticator.
  el('cancel-all').onclick = async () => {
    const done = await withFactor(
      'cancel every task on the platform',
      (proof) => api('POST', '/api/control/cancel-everything', { proof }),
    );
    if (done) await refresh();
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
      await drawTab();
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
  // F10.3's other direction: an agent asked something, and this is the answer
  // going back. It puts the task back on the queue rather than deciding it,
  // which is why it is not one of the three decisions above.
  const answer = document.createElement('button');
  answer.className = 'link';
  answer.textContent = 'Answer';
  answer.onclick = async () => {
    const text = window.prompt('Your answer') ?? '';
    if (!text.trim()) return;
    try {
      await api('POST', `${company()}/inbox/${item.id}/answer`, { answer: text });
      await drawInbox();
    } catch (failure) {
      showCardError(item, failure.message);
    }
  };
  actions.append(answer);

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

/**
 * Asks for the factor, for *this* action and no other.
 *
 * `attempt(proof)` is what the caller wants done; this returns once it has
 * either succeeded or the owner has backed out. Written this way rather than
 * "return a code" because a code is single-use: handing one back and letting
 * the caller decide when to spend it is how one ends up spent on a request
 * that was never sent, leaving the owner locked out of the thing they meant
 * to do.
 *
 * The listeners are torn down by an `AbortController` tied to the dialog's own
 * `close` event, which fires however the dialog closes -- the Cancel button,
 * the form, or Escape. Removing them by hand in each exit path was the first
 * version and it missed Escape, and the consequence was not cosmetic: the
 * listener stayed bound to the *cancelled* action, so the next confirmation
 * submitted the owner's valid code against the previous one and did it. A
 * dialog that does the thing the owner just backed out of is the worst failure
 * this page could have.
 */
function withFactor(what, attempt) {
  const dialog = el('factor');
  const error = el('factor-error');
  const input = el('factor-code');
  el('factor-what').textContent = what;
  error.hidden = true;
  input.value = '';

  const scope = new AbortController();
  const { signal } = scope;

  return new Promise((resolve) => {
    let done = false;
    // Fires for every way out, including Escape and `dialog.close()`. One
    // place to release everything means there is no exit path to forget.
    dialog.addEventListener('close', () => {
      scope.abort();
      input.value = '';
      resolve(done);
    }, { once: true });

    el('factor-cancel').addEventListener('click', () => dialog.close(), { signal });

    el('factor-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      error.hidden = true;
      try {
        await attempt({ totp: input.value.trim() });
        done = true;
        dialog.close();
      } catch (failure) {
        // Shown here rather than on the page behind, because the owner is
        // looking at this box: "that code is wrong" and "that has been used"
        // and "locked out" are three different next actions.
        error.textContent = failure.message;
        error.hidden = false;
        input.value = '';
        input.focus();
      }
    }, { signal });

    dialog.showModal();
    input.focus();
  });
}

/** The inbox's use of it: confirm this decision, then redraw the queue. */
async function confirmWithFactor(item, decision, note) {
  const done = await withFactor(item.title, (proof) => send(item, decision, note, proof));
  if (done) await drawInbox();
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

/**
 * An amount, with no currency symbol.
 *
 * The platform stores cents and does not know which currency they are: a
 * company's ledger decides that, and this console serves every company at
 * once. Printing a symbol would be inventing one, and a figure labelled in the
 * wrong currency is worse than a figure labelled in none.
 */
function money(cents) {
  return (cents / 100).toFixed(2);
}

/* ------------------------------------------------------------- the panels --- */

/**
 * Everything the owner does that is not a decision waiting on them.
 *
 * One page with tabs rather than several pages, because the owner is one
 * person switching between "what needs me" and "what is this costing" every
 * few minutes, and a page load between those two is a page load they stop
 * making.
 *
 * Each entry is a title and a function that fills a `<div>`. The rules stay
 * where they were: every one of these calls an API route and draws what came
 * back, and the ones that need a second factor ask for it because the API
 * refuses without it -- not because this list says so.
 */
const TABS = [
  ['decisions', 'Decisions', drawInbox],
  ['money', 'Money', drawMoney],
  ['health', 'Health', drawHealth],
  ['settings', 'Settings', drawSettings],
  ['structure', 'Structure', drawStructure],
  ['skills', 'Skills', drawSkills],
  ['supply', 'Bundles', drawSupply],
  ['devices', 'Devices', drawDevices],
];

function drawTabs() {
  const nav = el('tabs');
  nav.replaceChildren();
  for (const [id, label] of TABS) {
    const button = document.createElement('button');
    button.textContent = label;
    button.className = id === state.tab ? 'tab current' : 'tab';
    button.onclick = async () => {
      state.tab = id;
      drawTabs();
      await drawTab();
    };
    nav.append(button);
  }
}

async function drawTab() {
  for (const [id] of TABS) el(`panel-${id}`).hidden = id !== state.tab;
  const entry = TABS.find(([id]) => id === state.tab);
  if (!entry) return;
  const panel = el(`panel-${entry[0]}`);
  if (entry[0] !== 'decisions') panel.replaceChildren(loading());
  try {
    await entry[2]();
  } catch (failure) {
    // Said on the panel rather than swallowed. A tab that silently draws
    // nothing looks exactly like a company with nothing in it.
    panel.replaceChildren(note(failure.message, 'error'));
  }
}

/* --------------------------------------------------------- small builders --- */

function loading() {
  return note('Loading…', 'muted');
}

function note(text, className = 'muted') {
  const p = document.createElement('p');
  p.className = className;
  p.textContent = text;
  return p;
}

function heading(text) {
  const h = document.createElement('h2');
  h.textContent = text;
  return h;
}

/** A row of label/value pairs, which is most of what these panels show. */
function facts(pairs) {
  const list = document.createElement('dl');
  list.className = 'facts';
  for (const [label, value] of pairs) {
    const term = document.createElement('dt');
    term.textContent = label;
    const detail = document.createElement('dd');
    detail.textContent = value;
    list.append(term, detail);
  }
  return list;
}

/** A table, built from arrays. `textContent` throughout, like everything here. */
function table(columns, rows) {
  const element = document.createElement('table');
  const head = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const column of columns) {
    const cell = document.createElement('th');
    cell.textContent = column;
    headRow.append(cell);
  }
  head.append(headRow);
  const body = document.createElement('tbody');
  for (const row of rows) {
    const line = document.createElement('tr');
    for (const value of row) {
      const cell = document.createElement('td');
      if (value instanceof Node) cell.append(value);
      else cell.textContent = String(value ?? '');
      line.append(cell);
    }
    body.append(line);
  }
  element.append(head, body);
  return element;
}

/**
 * A form, from a list of fields.
 *
 * `factor` marks the ones the API will refuse without a second factor. The
 * page does not decide that -- the route does, and asking first is only so the
 * owner is not told "no" after typing everything. A form marked `factor` that
 * the API happened not to gate would simply ask for a code it did not need,
 * which is the harmless direction of being wrong.
 */
function form(fields, submit, options = {}) {
  const element = document.createElement('form');
  element.className = 'panel-form';
  const inputs = new Map();

  for (const field of fields) {
    const label = document.createElement('label');
    label.textContent = field.label;
    const input = document.createElement(field.type === 'textarea' ? 'textarea' : 'input');
    if (field.type && field.type !== 'textarea') input.type = field.type;
    if (field.placeholder) input.placeholder = field.placeholder;
    if (field.value !== undefined && field.value !== null) input.value = String(field.value);
    if (field.required) input.required = true;
    inputs.set(field.name, input);
    label.append(input);
    element.append(label);
  }

  const submitButton = document.createElement('button');
  submitButton.type = 'submit';
  submitButton.textContent = options.action ?? 'Save';
  element.append(submitButton);

  const failure = document.createElement('p');
  failure.className = 'error';
  failure.hidden = true;
  element.append(failure);

  element.addEventListener('submit', async (event) => {
    event.preventDefault();
    failure.hidden = true;
    const values = {};
    for (const [name, input] of inputs) {
      const field = fields.find((one) => one.name === name);
      const raw = input.value.trim();
      if (raw === '' && !field.required) continue;
      values[name] = field.type === 'number' ? Number(raw) : raw;
    }
    try {
      if (options.factor) {
        const done = await withFactor(options.factor, (proof) => submit(values, proof));
        if (!done) return;
      } else {
        await submit(values);
      }
      await drawTab();
    } catch (error) {
      failure.textContent = error.message;
      failure.hidden = false;
    }
  });

  return element;
}

/** A button that does one thing, with an optional factor in front of it. */
function action(label, run, options = {}) {
  const button = document.createElement('button');
  button.textContent = label;
  if (options.danger) button.className = 'danger';
  button.onclick = async () => {
    try {
      if (options.factor) {
        const done = await withFactor(options.factor, (proof) => run(proof));
        if (!done) return;
      } else {
        await run();
      }
      await drawTab();
    } catch (failure) {
      el(`panel-${state.tab}`).append(note(failure.message, 'error'));
    }
  };
  return button;
}

function group(...children) {
  const box = document.createElement('div');
  box.className = 'group';
  box.append(...children.filter(Boolean));
  return box;
}

const company = () => `/api/companies/${state.companyId}`;

/* --------------------------------------------------- F1.5, F1.7-F1.9, F11.5 --- */

async function drawMoney() {
  const panel = el('panel-money');
  if (!state.companyId) return panel.replaceChildren(note('No company.'));

  const [spend, cost, platform] = await Promise.all([
    api('GET', `${company()}/spend`),
    api('GET', `${company()}/cost`),
    api('GET', '/api/control/cost'),
  ]);

  panel.replaceChildren(
    heading('This period'),
    facts([
      ['Spent', money(spend.spentCents)],
      ['Ceiling', money(spend.limitCents)],
      ['Period', `${spend.periodStart.slice(0, 10)} to ${spend.periodEnd.slice(0, 10)}`],
      ['Paused', spend.pausedAt ? `${spend.pausedAt.slice(0, 16)} — ${spend.pauseReason}` : 'no'],
      ['Override until', spend.overrideUntil ? spend.overrideUntil.slice(0, 16) : 'none'],
    ]),
    form(
      [{ name: 'moneyMaxCents', label: 'Ceiling, in cents', type: 'number',
        value: spend.limitCents, required: true }],
      (values) => api('POST', `${company()}/spend/limit`, values),
      { action: 'Set the ceiling' },
    ),
    // Both directions of F1.9 on one row, because they are one decision: an
    // override says "past the ceiling until then", and lifting says "the
    // ceiling was wrong".
    spend.pausedAt
      ? group(
        action('Lift the pause', () => api('POST', `${company()}/spend/resume`, {})),
        form(
          [{ name: 'until', label: 'Or override until', type: 'datetime-local', required: true }],
          (values) => api('POST', `${company()}/spend/resume`, {
            until: new Date(values.until).toISOString(),
          }),
          { action: 'Override' },
        ),
      )
      : note('Not paused.'),
    heading('Cost, last thirty days'),
    table(['Day', 'Cost', 'Tokens'],
      cost.timeline.map((row) => [row.period, money(row.costCents), row.tokens])),
    heading('Every company'),
    table(['Company', 'Cost', 'Tokens'],
      platform.companies.map((row) => [row.slug, money(row.costCents), row.tokens])),
  );
}

/* ---------------------------------------------------- F8.12, F3.11, F7.5 --- */

async function drawHealth() {
  const panel = el('panel-health');
  if (!state.companyId) return panel.replaceChildren(note('No company.'));

  const [governance, reviews] = await Promise.all([
    api('GET', `${company()}/governance`),
    api('GET', `${company()}/reviews`),
  ]);

  panel.replaceChildren(
    heading('Capability health'),
    // A division id rather than a picker, because this page has no list of
    // divisions to pick from yet and inventing one here would be a second
    // place that decides what a division is.
    form(
      [{ name: 'divisionId', label: 'Division id', required: true }],
      async (values) => {
        const health = await api('GET', `${company()}/divisions/${values.divisionId}/health`);
        panel.append(
          heading('Last reading'),
          table(['Capability', 'Status', 'Detail', 'Checked'],
            health.health.map((row) => [
              row.capabilityName, row.status, row.detail,
              String(row.checkedAt).slice(0, 16),
            ])),
        );
      },
      { action: 'Read' },
    ),
    heading('Reviews waiting'),
    reviews.reviews.length === 0
      ? note('None.')
      : table(['Reviewer', 'Task'],
        reviews.reviews.map((row) => [row.reviewerRoleSlug, row.reviewTaskId])),
    heading('Governance log'),
    table(['Subject', 'Action', 'Actor'],
      governance.log.map((row) => [row.subject, row.action, row.actor])),
  );
}

/* ------------------------------------------------- F1.5, F9.5, F9.6, F11.6 --- */

async function drawSettings() {
  const panel = el('panel-settings');
  const [window_, retention] = await Promise.all([
    api('GET', '/api/control/owner-window'),
    state.companyId ? api('GET', `${company()}/retention`) : Promise.resolve(null),
  ]);

  panel.replaceChildren(
    heading('Your hours'),
    note('Nothing that is not an incident reaches you outside them (F9.5).'),
    form(
      [
        { name: 'timezone', label: 'Timezone', value: window_.timezone, required: true },
        { name: 'startHour', label: 'From (hour)', type: 'number',
          value: window_.startHour, required: true },
        { name: 'endHour', label: 'To (hour)', type: 'number',
          value: window_.endHour, required: true },
      ],
      (values) => api('POST', '/api/control/owner-window', values),
    ),
  );

  if (!state.companyId) return;

  panel.append(
    heading('Cheap hours for this company'),
    note('Work that can wait runs in this window (F9.6).'),
    form(
      [
        { name: 'timezone', label: 'Timezone', value: 'UTC', required: true },
        { name: 'startHour', label: 'From (hour)', type: 'number', value: 2, required: true },
        { name: 'endHour', label: 'To (hour)', type: 'number', value: 5, required: true },
      ],
      (values) => api('POST', `${company()}/batch-window`, values),
    ),
    heading('Retention'),
    form(
      [
        { name: 'eventDays', label: 'Events, days', type: 'number',
          value: retention.policy.eventDays },
        { name: 'traceDays', label: 'Traces, days', type: 'number',
          value: retention.policy.traceDays },
        { name: 'promptDays', label: 'Prompts, days', type: 'number',
          value: retention.policy.promptDays },
      ],
      (values) => api('POST', `${company()}/retention`, values),
    ),
    retention.log.length === 0
      ? note('Nothing has been purged yet.')
      : table(['What', 'Rows', 'Through'],
        retention.log.map((row) => [row.action, row.rowsAffected, String(row.throughAt).slice(0, 10)])),
    heading('Alert thresholds'),
    form(
      [
        { name: 'dailyCostCents', label: 'Daily cost, cents', type: 'number' },
        { name: 'taskFailureRate', label: 'Task failure rate, 0 to 1', type: 'number' },
        { name: 'policyDenialsPerDay', label: 'Policy denials a day', type: 'number' },
      ],
      (values) => api('POST', `${company()}/alert-thresholds`, values),
    ),
    heading('Export'),
    action('Download this company as JSON', async () => {
      const dump = await api('GET', `${company()}/export`);
      const blob = new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `${state.companyId}.json`;
      link.click();
      URL.revokeObjectURL(link.href);
    }),
  );
}

/* ------------------------------------------------- F2.7, F2.9, F3.4, F3.9 --- */

async function drawStructure() {
  const panel = el('panel-structure');
  if (!state.companyId) return panel.replaceChildren(note('No company.'));

  panel.replaceChildren(
    heading('The goal ladder'),
    note('A mission, the objectives under it, and the key results under those (F2.7).'),
    form(
      [
        { name: 'kind', label: 'Kind (mission, objective, key_result)', required: true },
        { name: 'slug', label: 'Slug', required: true },
        { name: 'statement', label: 'Statement', type: 'textarea', required: true },
        { name: 'parentGoalId', label: 'Parent goal id' },
      ],
      (values) => api('POST', `${company()}/goals`, values),
      { action: 'Add a goal' },
    ),
    form(
      [
        { name: 'goalId', label: 'Goal id', required: true },
        { name: 'statement', label: 'New statement', type: 'textarea' },
        { name: 'status', label: 'Status (active, met, abandoned)' },
      ],
      ({ goalId, ...rest }, proof) =>
        api('POST', `${company()}/goals/${goalId}`, { ...rest, proof }),
      { action: 'Change it', factor: 'change a goal' },
    ),

    heading('Grants'),
    note('A grant may tighten and never loosen; the database is what says so (F8.3).'),
    form(
      [
        { name: 'divisionId', label: 'Division id', required: true },
        { name: 'capabilityName', label: 'Capability', required: true },
        { name: 'tierOverride', label: 'Tier (blank to revoke)', type: 'number' },
      ],
      (values, proof) => api('POST', `${company()}/structure/grant`, {
        ...values,
        ...(values.tierOverride === undefined ? { revoke: true } : {}),
        proof,
      }),
      { action: 'Apply', factor: 'change a grant' },
    ),

    heading('A role'),
    form(
      [
        { name: 'roleId', label: 'Role id', required: true },
        { name: 'systemPrompt', label: 'Charter', type: 'textarea' },
        { name: 'modelPrimary', label: 'Primary model' },
      ],
      ({ roleId, ...rest }, proof) =>
        api('POST', `${company()}/roles/${roleId}`, { ...rest, proof }),
      { action: 'Change it', factor: 'change a role' },
    ),

    heading('Escalation'),
    note('Blank means it comes straight to you rather than waiting on a role (F2.6).'),
    form(
      [
        { name: 'divisionId', label: 'Division id', required: true },
        { name: 'roleSlug', label: 'Escalate to (blank for nobody)' },
        { name: 'afterMinutes', label: 'After, minutes', type: 'number' },
      ],
      ({ divisionId, roleSlug, afterMinutes }) => api(
        'POST', `${company()}/divisions/${divisionId}/escalation`,
        {
          roleSlug: roleSlug === undefined ? null : roleSlug,
          ...(afterMinutes === undefined ? {} : { afterMinutes }),
        },
      ),
    ),

    heading('A policy'),
    note('The condition is JSON, and the engine is what validates it (F3.4).'),
    form(
      [
        { name: 'slug', label: 'Slug', required: true },
        { name: 'effect', label: 'Effect (allow, require_review, require_approval, deny)',
          required: true },
        { name: 'condition', label: 'Condition, as JSON', type: 'textarea', required: true },
      ],
      (values) => api('POST', '/api/policies', {
        slug: values.slug,
        effect: values.effect,
        companyId: state.companyId,
        condition: JSON.parse(values.condition),
      }),
      { action: 'Write it' },
    ),

    heading('A schedule'),
    form(
      [
        { name: 'projectId', label: 'Project id', required: true },
        { name: 'divisionId', label: 'Division id', required: true },
        { name: 'roleId', label: 'Role id', required: true },
        { name: 'slug', label: 'Slug', required: true },
        { name: 'cronExpression', label: 'Cron', placeholder: '0 3 * * *', required: true },
        { name: 'timezone', label: 'Timezone', value: 'UTC' },
      ],
      (values) => api('POST', `${company()}/schedules`, values),
      { action: 'Schedule it' },
    ),
  );
}

/* ------------------------------------------------------------------ F15 --- */

async function drawSkills() {
  const panel = el('panel-skills');
  if (!state.companyId) return panel.replaceChildren(note('No company.'));

  const { skills } = await api('GET', `${company()}/skills`);

  panel.replaceChildren(
    heading('Skills'),
    skills.length === 0
      ? note('None active.')
      : table(['Slug', 'Scope', 'Version', 'Quarantined', 'Origin', ''],
        skills.map((skill) => [
          skill.slug,
          skill.scopeType,
          skill.activeVersion ?? '',
          skill.quarantined ? 'yes' : 'no',
          skill.origin ?? 'here',
          skill.quarantined
            ? action('Lift', (proof) =>
              api('POST', `${company()}/skills/${skill.id}/quarantine/lift`, { proof }),
            { factor: `lift the quarantine on ${skill.slug}` })
            : '',
        ])),

    heading('Widen or narrow a scope'),
    note('Widening vouches for a skill somewhere it has not been used (F15.5).'),
    form(
      [
        { name: 'skillId', label: 'Skill id', required: true },
        { name: 'scopeType', label: 'Scope (company, platform, division)', required: true },
        { name: 'scopeId', label: 'Division id, for a division scope' },
      ],
      ({ skillId, ...rest }, proof) =>
        api('POST', `${company()}/skills/${skillId}/scope`, { ...rest, proof }),
      { action: 'Set the scope', factor: 'change a skill\'s scope' },
    ),

    heading('Review a version'),
    form(
      [
        { name: 'versionId', label: 'Version id', required: true },
        { name: 'reason', label: 'Reason, if rejecting' },
      ],
      () => Promise.reject(new Error('use one of the buttons')),
      { action: 'Use the buttons below' },
    ),
    group(
      form(
        [{ name: 'versionId', label: 'Version id', required: true }],
        (values) => api(
          'POST', `${company()}/skills/versions/${values.versionId}/review`, { approved: true },
        ).then(() => api('POST', `${company()}/skills/versions/${values.versionId}/approve`, {})),
        { action: 'Approve and activate' },
      ),
      form(
        [
          { name: 'versionId', label: 'Version id', required: true },
          { name: 'reason', label: 'Why not', required: true },
        ],
        (values) => api(
          'POST', `${company()}/skills/versions/${values.versionId}/review`,
          { approved: false, reason: values.reason },
        ),
        { action: 'Reject' },
      ),
    ),

    heading('Import one from outside'),
    note('Unsigned means quarantined, and quarantine means one division (F15.8, F12.10).'),
    form(
      [
        { name: 'slug', label: 'Slug', required: true },
        { name: 'origin', label: 'Where from', required: true },
        { name: 'divisionId', label: 'Division id', required: true },
        { name: 'source', label: 'SKILL.md', type: 'textarea', required: true },
        { name: 'signature', label: 'Signature, base64' },
        { name: 'publisherKey', label: 'Publisher key, PEM' },
      ],
      (values) => api('POST', `${company()}/skills/import`, values),
      { action: 'Import' },
    ),
  );
}

/* ------------------------------------------------------------------ F16 --- */

async function drawSupply() {
  const panel = el('panel-supply');
  const { publishers } = await api('GET', '/api/publishers');

  panel.replaceChildren(
    heading('Trusted publishers'),
    note('Trusting one vouches for everything it will ever sign (F16.2).'),
    publishers.length === 0
      ? note('None.')
      : table(['Label', 'Fingerprint', 'Revoked', ''],
        publishers.map((publisher) => [
          publisher.label,
          publisher.fingerprint.slice(0, 16),
          publisher.revokedAt ? String(publisher.revokedAt).slice(0, 10) : 'no',
          publisher.revokedAt
            ? ''
            : action('Revoke', () =>
              api('POST', `/api/publishers/${publisher.fingerprint}/revoke`, {}),
            { danger: true }),
        ])),
    form(
      [
        { name: 'label', label: 'Label', required: true },
        { name: 'publicKeyPem', label: 'Public key, PEM', type: 'textarea', required: true },
      ],
      (values, proof) => api('POST', '/api/publishers', { ...values, proof }),
      { action: 'Trust it', factor: 'trust a publisher' },
    ),
  );

  if (!state.companyId) return;

  panel.append(
    heading('Install a bundle'),
    note('An install writes divisions, roles and grants, so it is the owner\'s (F16.3).'),
    form(
      [
        { name: 'slug', label: 'Slug', required: true },
        { name: 'version', label: 'Version', required: true },
      ],
      (values, proof) => api('POST', `${company()}/bundles`, { ...values, proof }),
      { action: 'Install', factor: 'install a bundle' },
    ),
    heading('Is what is installed still what was signed?'),
    form(
      [{ name: 'slug', label: 'Slug', required: true }],
      async (values) => {
        const answer = await api('GET', `${company()}/bundles/${values.slug}/verify`);
        panel.append(note(
          answer.intact
            ? `${values.slug} is unchanged since it was installed.`
            : `${values.slug} has been changed since it was installed.`,
          answer.intact ? 'muted' : 'error',
        ));
      },
      { action: 'Check' },
    ),
  );
}

/* --------------------------------------------------------- F12.7, F12.10 --- */

async function drawDevices() {
  const panel = el('panel-devices');
  if (!state.companyId) return panel.replaceChildren(note('No company.'));

  panel.replaceChildren(
    heading('Register a device'),
    note('A device speaks to this platform by signing, so what it registers is a key (F12.7).'),
    form(
      [
        { name: 'name', label: 'Name', required: true },
        { name: 'runtime', label: 'Runtime', required: true },
        { name: 'publicKeyPem', label: 'Public key, PEM', type: 'textarea', required: true },
      ],
      async (values) => {
        const device = await api('POST', `${company()}/devices`, values);
        panel.append(note(`Registered. Its id is ${device.id}.`));
      },
      { action: 'Register' },
    ),
    heading('Pair one'),
    note('Pairing is what makes its signature count, so it takes your authenticator.'),
    form(
      [{ name: 'deviceId', label: 'Device id', required: true },
        { name: 'liftQuarantine', label: 'Also lift its quarantine (yes/no)' }],
      ({ deviceId, liftQuarantine }, proof) => api(
        'POST', `${company()}/devices/${deviceId}/pair`,
        { liftQuarantine: liftQuarantine === 'yes', proof },
      ),
      { action: 'Pair', factor: 'pair a device' },
    ),
    heading('Give one a challenge'),
    // The route needs the owner's session, so a device cannot ask for its own
    // nonce: the owner takes one here and hands it over. Shown rather than
    // copied silently, because the owner is the one carrying it across.
    form(
      [{ name: 'deviceId', label: 'Device id', required: true }],
      async (values) => {
        const { nonce } = await api(
          'POST', `${company()}/devices/${values.deviceId}/challenge`, {},
        );
        const shown = note(nonce);
        shown.className = 'nonce';
        panel.append(shown);
      },
      { action: 'Issue' },
    ),
    heading('Revoke one'),
    form(
      [{ name: 'deviceId', label: 'Device id', required: true }],
      (values) => api('POST', `${company()}/devices/${values.deviceId}/revoke`, {}),
      { action: 'Revoke' },
    ),
  );
}

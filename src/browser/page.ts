/**
 * What runs inside a page: how it is read, and how a step finds what it
 * acts on.
 *
 * In a world of its own (`worldName`, an isolated world): the page's
 * scripts share its document but not its JavaScript, so a page that
 * replaces `getBoundingClientRect` or `innerText` to tell a visitor one
 * thing and a script another cannot reach these. The refs a reading gives
 * -- `e1`, `e2` -- are kept here too, in a map the page cannot see, rather
 * than written onto its elements where it could move them; they last as
 * long as the document, and a reading of a new one starts them again.
 *
 * Read as a person sees it: the text the page shows (`innerText`, which
 * leaves out what is hidden), and the things on it a person can use -- a
 * link, a button, a field, a list to choose from, a box to tick -- each
 * named as a screen reader would name it, near enough: its label, else its
 * own words, else what it says it is for. A field's value is read, except a
 * password's.
 */

/** The most of a page's text a reading returns, and the most things on it. */
export const TEXT_MAX = 12_000;
export const ELEMENTS_MAX = 150;

/** The world the script lives in. */
export const WORLD = 'palugada';

export const PAGE_SCRIPT = `(() => {
  if (globalThis.__palugada) return;
  const USABLE = 'a[href], area[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=link], '
    + '[role=checkbox], [role=radio], [role=switch], [role=tab], [role=menuitem], [role=option], [role=textbox], [role=combobox], '
    + '[contenteditable=""], [contenteditable=true], [onclick]';
  const CLICKABLE = 'a[href], button, [role=button], [role=link]';
  let refs = new Map();

  // A link or a form that asks for a new tab is followed in this one: a tab
  // the role cannot see is work it cannot finish.
  addEventListener('click', (event) => {
    const link = event.target instanceof Element ? event.target.closest('a[target], area[target]') : null;
    if (link) link.removeAttribute('target');
  }, true);
  addEventListener('submit', (event) => {
    if (event.target instanceof HTMLFormElement) event.target.removeAttribute('target');
  }, true);

  const clean = (text) => String(text || '').replace(/\\s+/g, ' ').trim().slice(0, 120);
  const textOf = (node) => clean(node.innerText ?? node.textContent ?? '');
  const labelText = (label) => {
    const copy = label.cloneNode(true);
    for (const control of copy.querySelectorAll('input, select, textarea, button')) control.remove();
    return clean(copy.textContent);
  };
  const shown = (el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0;
  };
  const isBox = (el) => el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio');
  // A box drawn by the page over a hidden one is used through its label.
  const face = (el) => (isBox(el) && !shown(el) ? [...(el.labels || [])].find(shown) || null : shown(el) ? el : null);
  const nameOf = (el) => {
    const aria = el.getAttribute('aria-label');
    if (aria && aria.trim()) return clean(aria);
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const said = by.split(/\\s+/).map((id) => document.getElementById(id)).filter(Boolean).map(textOf).join(' ');
      if (said) return clean(said);
    }
    if (el.labels && el.labels.length > 0) {
      const said = [...el.labels].map(labelText).filter(Boolean).join(' ');
      if (said) return clean(said);
    }
    if (el instanceof HTMLInputElement && ['submit', 'button', 'reset'].includes(el.type)) return clean(el.value || el.type);
    if (el instanceof HTMLInputElement && el.type === 'image') return clean(el.alt || 'image');
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
      return clean(el.getAttribute('placeholder') || el.title || el.name || '');
    }
    const own = textOf(el);
    if (own) return own;
    const picture = el.querySelector('img[alt]');
    return clean((picture && picture.alt) || el.title || '');
  };
  const kindOf = (el) => {
    const role = el.getAttribute('role');
    if (el instanceof HTMLAnchorElement || el instanceof HTMLAreaElement || role === 'link') return 'link';
    if (el instanceof HTMLSelectElement) return 'choice';
    if (el instanceof HTMLInputElement) {
      if (el.type === 'checkbox') return 'checkbox';
      if (el.type === 'radio') return 'radio';
      if (['submit', 'button', 'reset', 'image'].includes(el.type)) return 'button';
      return 'field';
    }
    if (el instanceof HTMLTextAreaElement || el.isContentEditable || role === 'textbox' || role === 'combobox') return 'field';
    if (role === 'checkbox' || role === 'switch') return 'checkbox';
    if (role === 'radio') return 'radio';
    return 'button';
  };
  const checkedOf = (el) => (isBox(el) ? el.checked : el.getAttribute('aria-checked') === 'true');
  const every = function* (root) {
    for (const el of root.querySelectorAll('*')) {
      yield el;
      if (el.shadowRoot) yield* every(el.shadowRoot);
    }
  };
  const describe = (el, ref) => {
    const kind = kindOf(el);
    const found = { ref, kind, name: nameOf(el) };
    if (kind === 'link' && el.href) found.href = String(el.href);
    if (kind === 'field') {
      if (el instanceof HTMLInputElement && el.type === 'password') found.password = true;
      else if ('value' in el) found.value = clean(el.value);
      else found.value = textOf(el);
    }
    if (kind === 'choice') {
      found.options = [...el.options].slice(0, 50).map((option) => clean(option.text));
      const chosen = el.options[el.selectedIndex];
      if (chosen) found.value = clean(chosen.text);
    }
    if (kind === 'checkbox' || kind === 'radio') found.checked = checkedOf(el);
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') found.disabled = true;
    return found;
  };

  globalThis.__palugada = {
    read(maxText, maxElements) {
      refs = new Map();
      const elements = [];
      let more = 0;
      for (const el of every(document)) {
        if (!el.matches(USABLE)) continue;
        // A span inside a link is the link.
        if (el.parentElement && el.parentElement.closest(CLICKABLE) && !(el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement)) continue;
        if (!face(el)) continue;
        if (elements.length >= maxElements) { more += 1; continue; }
        const ref = 'e' + (elements.length + 1);
        refs.set(ref, el);
        elements.push(describe(el, ref));
      }
      const whole = document.body ? document.body.innerText.replace(/\\n{3,}/g, '\\n\\n').trim() : '';
      const text = whole.length > maxText
        ? whole.slice(0, maxText) + '\\n… (cut here: ' + (whole.length - maxText) + ' more characters)'
        : whole;
      return { url: location.href, title: document.title, text, elements, moreElements: more };
    },
    /**
     * What the page says, without what is around it: its menu, its header
     * and footer, what it suggests reading next. Those are hidden for the
     * moment it takes to read the rest as a person sees it, and put back.
     */
    article(maxText) {
      const articles = document.querySelectorAll('article');
      const root = articles.length === 1 ? articles[0] : (document.querySelector('main, [role=main]') || document.body);
      if (!root) return { url: location.href, title: document.title, text: '', more: 0 };
      const around = 'nav, aside, form, dialog, [role=navigation], [role=complementary], [role=search], [role=dialog], [aria-hidden=true]'
        + (root === document.body ? ', header, footer, [role=banner], [role=contentinfo]' : '');
      const hidden = [];
      let whole = '';
      try {
        for (const el of root.querySelectorAll(around)) {
          hidden.push([el, el.getAttribute('style')]);
          el.style.setProperty('display', 'none', 'important');
        }
        whole = root.innerText.replace(/\\n{3,}/g, '\\n\\n').trim();
      } finally {
        for (const [el, style] of hidden.reverse()) {
          if (style === null) el.removeAttribute('style');
          else el.setAttribute('style', style);
        }
      }
      return { url: location.href, title: document.title, text: whole.slice(0, maxText), more: Math.max(0, whole.length - maxText) };
    },
    /** The element a ref names, as it is now; or why there is none. */
    check(ref) {
      const el = refs.get(ref);
      if (!el || !el.isConnected) return { missing: true };
      return describe(el, ref);
    },
    /** Where to click: the middle of the element, scrolled into view, unless something else is on top of it. */
    point(ref) {
      const el = refs.get(ref);
      if (!el || !el.isConnected) return { missing: true };
      const target = face(el);
      if (!target) return { hidden: true };
      target.scrollIntoView({ block: 'center', inline: 'center' });
      const rect = target.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const root = target.getRootNode();
      const hit = (root.elementFromPoint ? root : document).elementFromPoint(x, y);
      if (hit && hit !== target && !target.contains(hit) && !(target instanceof HTMLLabelElement && hit === el)) {
        return { covered: nameOf(hit) || hit.tagName.toLowerCase() };
      }
      return { x, y };
    },
    /** Focuses a field with what is in it selected, so what is typed replaces it. */
    focus(ref) {
      const el = refs.get(ref);
      if (!el || !el.isConnected) return { missing: true };
      el.scrollIntoView({ block: 'center' });
      el.focus();
      if (typeof el.select === 'function') el.select();
      else if (el.isContentEditable) {
        const range = document.createRange();
        range.selectNodeContents(el);
        const selection = getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      }
      return { focused: document.activeElement === el || (el.getRootNode().activeElement === el) };
    },
    /** Says a field changed, for a page that listens for that rather than for typing. */
    changed(ref) {
      const el = refs.get(ref);
      if (el && el.isConnected) el.dispatchEvent(new Event('change', { bubbles: true }));
      return {};
    },
    choose(ref, option) {
      const el = refs.get(ref);
      if (!el || !el.isConnected) return { missing: true };
      if (!(el instanceof HTMLSelectElement)) return { notChoice: true };
      const wanted = clean(option).toLowerCase();
      const index = [...el.options].findIndex((one) => clean(one.text).toLowerCase() === wanted || one.value === option);
      if (index < 0) return { options: [...el.options].map((one) => clean(one.text)) };
      el.selectedIndex = index;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { chosen: clean(el.options[index].text) };
    },
    href(ref) {
      const el = refs.get(ref);
      if (!el || !el.isConnected) return { missing: true };
      return el.href ? { href: String(el.href) } : { kind: kindOf(el) };
    },
    where() {
      return { url: location.href };
    },
  };
})();`;

/** The keys a step may press, as Chromium's input wants them. */
export const KEYS: Record<string, { key: string; code: string; keyCode: number; text?: string }> = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
};

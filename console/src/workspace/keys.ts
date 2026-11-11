/**
 * The rooms' keys that are heard where the cursor usually is (STATUS 2.207,
 * 2.218): Esc from the page and from a composer, and the composer that takes
 * the focus when a room is opened from the keyboard.
 *
 * Esc closes a thread, or reads the room when none is open. A composer is
 * where a person's cursor is nearly always, so Esc is heard there too; but
 * not from any other field -- the edit box, a search box, a dialog's -- whose
 * Esc is its own, nor when something already took it, such as the mention
 * list closing or a menu.
 */
import { useEffect, useRef } from 'react';

/** Whether an Esc pressed here is the rooms' to hear. */
function heardHere(event: KeyboardEvent): boolean {
  if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return false;
  const target = event.target instanceof HTMLElement ? event.target : null;
  if (!target) return true;
  if (target.closest('[role="dialog"], [role="menu"], [role="listbox"]')) return false;
  return !target.matches('input, textarea, select, [contenteditable="true"]') || target.matches('[data-composer]');
}

/** Hears Esc on the page and from a composer, while mounted. */
export function useEscape(handler: () => void): void {
  const wanted = useRef(handler);
  wanted.current = handler;
  useEffect(() => {
    const heard = (event: KeyboardEvent) => {
      if (heardHere(event)) wanted.current();
    };
    document.addEventListener('keydown', heard);
    return () => document.removeEventListener('keydown', heard);
  }, []);
}

/** When a room was last opened from the keyboard, so the composer drawn for it takes the focus. */
let focusAsked = 0;
/** How long after the keyboard opens a room its composer still takes the focus: the room is read first. */
const FOCUS_WITHIN_MS = 5_000;

/** A room is being opened from the keyboard: its composer, once drawn, takes the focus. */
export function focusNextComposer(): void {
  focusAsked = Date.now();
}

/** Whether a composer drawn now should take the focus; asked once, by the first composer drawn. */
export function takeComposerFocus(): boolean {
  const asked = focusAsked > 0 && Date.now() - focusAsked < FOCUS_WITHIN_MS;
  focusAsked = 0;
  return asked;
}

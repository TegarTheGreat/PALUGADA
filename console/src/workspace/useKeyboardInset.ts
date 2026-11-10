/**
 * How much of a phone's screen its keyboard covers, as `--keyboard-inset`
 * on the page, while a room is open on a phone (F19.16).
 *
 * iOS lays a page out under the keyboard rather than above it: the window
 * keeps its height and only the visual viewport shrinks, so a composer
 * pinned to the foot of the window is hidden behind the keys. The page's
 * full-height layout subtracts this inset, which puts the composer just
 * above the keyboard. Read from `visualViewport`, and gone when the room
 * closes; nothing is stored.
 */
import { useEffect } from 'react';

export function useKeyboardInset(on: boolean): void {
  useEffect(() => {
    const viewport = window.visualViewport;
    const root = document.documentElement;
    if (!on || !viewport) return undefined;
    const measure = () => {
      const covered = window.innerHeight - viewport.height - viewport.offsetTop;
      root.style.setProperty('--keyboard-inset', `${Math.max(0, Math.round(covered))}px`);
    };
    measure();
    viewport.addEventListener('resize', measure);
    viewport.addEventListener('scroll', measure);
    return () => {
      viewport.removeEventListener('resize', measure);
      viewport.removeEventListener('scroll', measure);
      root.style.removeProperty('--keyboard-inset');
    };
  }, [on]);
}

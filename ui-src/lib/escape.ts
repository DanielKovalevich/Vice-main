import {useEffect} from 'react';

/**
 * One Escape dispatcher for the whole app, because Escape has to mean exactly
 * one thing per press and the old UI got that by hand-ordering the surfaces:
 * playlist modal, then viewer, then trim, then the player bar.
 *
 * Registering a document listener per surface does not reproduce that. Capture
 * listeners fire in registration order, not in stacking order, so a trim modal
 * opened from the viewer would be closed second rather than first. Here the
 * most recently opened surface is the one that answers, which is the same
 * order without anyone having to maintain the list.
 */
const stack: Array<() => void> = [];

function onKeyDown(e: KeyboardEvent) {
  if (e.key !== 'Escape' || stack.length === 0) return;
  // A field's own Escape handler cancels the edit in progress. Closing the
  // surface underneath it as well would throw the edit away and the surface
  // with it, so typing wins and the press stops here.
  const tag = (e.target as HTMLElement | null)?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  e.preventDefault();
  e.stopPropagation();
  stack[stack.length - 1]?.();
}

/** Take the top of the Escape stack while `active`. */
export function useEscape(active: boolean, handler: () => void): void {
  useEffect(() => {
    if (!active) return;
    if (stack.length === 0) document.addEventListener('keydown', onKeyDown, true);
    stack.push(handler);
    return () => {
      const at = stack.lastIndexOf(handler);
      if (at >= 0) stack.splice(at, 1);
      if (stack.length === 0) document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [active, handler]);
}

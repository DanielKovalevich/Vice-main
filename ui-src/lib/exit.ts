import {useEffect, useState} from 'react';

/**
 * Keeps a surface mounted long enough to animate itself out.
 *
 * Overlays used to unmount the moment `open` went false, so everything had an
 * entrance and nothing had an exit: they arrived on a spring and then vanished
 * mid-frame. This holds the element for the length of its exit and flags it as
 * closing so the stylesheet can play the animation in reverse.
 *
 * Returns immediately when the user has asked for less motion, or when the
 * effects probe has put the app in its low mode, so neither path waits for an
 * animation that is not going to run.
 */
export function useExitTransition(open: boolean, ms: number): {mounted: boolean; closing: boolean} {
  const [mounted, setMounted] = useState(open);
  const [closing, setClosing] = useState(false);

  // Opening has to take effect in this render, not in an effect afterwards.
  // A surface that mounts one render late has no DOM on the render its owner
  // thinks it opened, so any layout effect keyed on the thing being shown runs
  // against nothing and never runs again. That is what stopped the viewer
  // attaching its video source.
  if (open && !mounted) {
    setMounted(true);
    setClosing(false);
  }

  useEffect(() => {
    if (open) {
      setClosing(false);
      return;
    }
    if (!mounted) return;

    const skip =
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ||
      document.documentElement.classList.contains('perf-low');
    if (skip) {
      setMounted(false);
      return;
    }

    setClosing(true);
    const timer = window.setTimeout(() => {
      setMounted(false);
      setClosing(false);
    }, ms);
    return () => window.clearTimeout(timer);
  }, [open, mounted, ms]);

  return {mounted, closing};
}

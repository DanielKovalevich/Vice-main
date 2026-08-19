import {useEffect, useRef, type ReactNode} from 'react';

import {useEscape} from '../lib/escape';
import {useExitTransition} from '../lib/exit';
import {IconClose} from './Icons';

/**
 * A dialog with a scrim. Escape closes, focus moves in on open and returns to
 * whatever opened it on close.
 */
export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
  wide,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const returnFocusTo = useRef<Element | null>(null);

  useEscape(open, onClose);
  // Held open for the length of the exit so it animates away rather than
  // disappearing between frames. Matches --duration-medium.
  const {mounted, closing} = useExitTransition(open, 320);

  useEffect(() => {
    if (!open) return;
    returnFocusTo.current = document.activeElement;
    boxRef.current?.focus();
    return () => {
      (returnFocusTo.current as HTMLElement | null)?.focus?.();
    };
  }, [open]);

  if (!mounted) return null;

  return (
    <div
      className="scrim"
      data-closing={closing || undefined}
      onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div
        className="modal"
        data-closing={closing || undefined}
        data-wide={wide || undefined}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={boxRef}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">
            <IconClose size={15} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </div>
  );
}

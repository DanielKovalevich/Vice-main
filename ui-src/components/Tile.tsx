import type {ReactNode} from 'react';

/**
 * A quick-settings tile: the control itself rather than a label with a switch
 * parked beside it. Filled means on, which is what makes state readable
 * without hunting for a toggle knob.
 */
export function Tile({
  label,
  detail,
  icon,
  on,
  busy,
  onToggle,
}: {
  label: string;
  detail?: string;
  icon: ReactNode;
  on: boolean;
  busy?: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className="tile"
      aria-pressed={on}
      aria-busy={busy || undefined}
      disabled={busy}
      onClick={onToggle}>
      <span className="tile-badge" aria-hidden="true">
        {icon}
      </span>
      <span className="tile-text">
        <b>{label}</b>
        {detail ? <span>{detail}</span> : null}
      </span>
    </button>
  );
}

/** A tile that runs an action instead of holding a state. */
export function ActionTile({
  label,
  icon,
  onClick,
  disabled,
}: {
  label: string;
  icon: ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className="tile tile-action"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}>
      <span className="tile-badge" aria-hidden="true">
        {icon}
      </span>
      <span className="tile-action-label">{label}</span>
    </button>
  );
}

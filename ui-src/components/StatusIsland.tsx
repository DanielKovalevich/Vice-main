import {useEffect, useLayoutEffect, useRef, useState} from 'react';

import {useStore, type IslandTone} from '../state/store';
import {formatDuration} from '../lib/format';
import {IconCheck, IconWarning} from './Icons';
import {t} from '../lib/i18n';

/**
 * One object for everything the recorder is doing: the standing state, and the
 * transient notices that used to be a separate toast stack.
 *
 * This exists because a "clip saved" signal is allowed to be a lie. The tone
 * fires the moment the hotkey is pressed, because flushing a long buffer takes
 * seconds and waiting in silence is worse, so a clip announced as saved can
 * still fail afterwards (#154). Something that stays on screen and changes
 * shape can carry the correction; a toast that has already faded cannot.
 *
 * The island measures whichever layer is showing and animates to that size, so
 * a long clip name is not clipped and a short one leaves no dead space.
 */
export function StatusIsland() {
  const {state} = useStore();
  const {status, event, sessionStartedAt, ready, loadError} = state;

  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!sessionStartedAt) {
      setElapsed(0);
      return;
    }
    const tick = () => setElapsed(Math.floor((Date.now() - sessionStartedAt) / 1000));
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [sessionStartedAt]);

  const bufferSeconds = (state.config?.recording?.buffer_duration as number | undefined) ?? null;

  let tone: IslandTone = 'neutral';
  let title: string;
  let detail: string | undefined;
  let kind: 'idle' | 'buffer' | 'session' | 'saving' | 'saved' | 'error' | 'info' = 'idle';

  if (event) {
    kind = event.kind;
    tone = event.tone;
    title = event.title;
    detail = event.detail;
  } else if (loadError) {
    kind = 'error';
    tone = 'error';
    title = t('island.cannotReach');
    detail = loadError;
  } else if (!ready) {
    kind = 'idle';
    title = t('island.starting');
  } else if (status.ready === false && status.recorder_error) {
    kind = 'error';
    tone = 'error';
    title = t('island.notRecording');
    detail = t('island.keepsRetrying');
  } else if (status.session_active) {
    kind = 'session';
    tone = 'live';
    title = t('island.sessionRecording');
    detail = formatDuration(elapsed);
  } else if (status.recording) {
    kind = 'buffer';
    tone = 'accent';
    title = t('island.bufferRunning');
    detail = bufferSeconds ? formatDuration(bufferSeconds, true) : undefined;
  } else {
    kind = 'idle';
    title = t('island.notRecording');
  }

  // Measure the visible content and let the shell animate to it.
  const contentRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{w: number; h: number} | null>(null);

  useLayoutEffect(() => {
    const node = contentRef.current;
    if (!node) return;
    // offsetWidth/offsetHeight, not getBoundingClientRect: the content plays a
    // scale() entry animation, and a client rect reports the transformed box,
    // so the island would size itself to 86% of its content and settle wrong.
    const measure = () => {
      const w = node.offsetWidth;
      const h = node.offsetHeight;
      setSize(prev => (prev && prev.w === w && prev.h === h ? prev : {w, h}));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [title, detail, kind]);

  const wide = kind === 'saved' || kind === 'error' || kind === 'info';

  return (
    <div
      className="island"
      data-tone={tone}
      data-wide={wide || undefined}
      style={size ? {width: size.w, height: size.h} : undefined}
      role="status"
      aria-live="polite">
      {/* Keyed so a state change remounts and replays the entry animation. */}
      <div className="island-content" ref={contentRef} key={`${kind}-${title}`}>
        <IslandGlyph kind={kind} />
        <div className="island-text">
          <span className="island-title">{title}</span>
          {detail ? <span className="island-detail">{detail}</span> : null}
        </div>
      </div>
    </div>
  );
}

function IslandGlyph({kind}: {kind: string}) {
  if (kind === 'saving') return <span className="island-spinner" aria-hidden="true" />;
  if (kind === 'saved')
    return (
      <span className="island-badge" aria-hidden="true">
        <IconCheck size={13} />
      </span>
    );
  if (kind === 'error')
    return (
      <span className="island-glyph" aria-hidden="true">
        <IconWarning size={17} />
      </span>
    );
  if (kind === 'idle') return <span className="island-dot" data-idle="true" aria-hidden="true" />;
  return <span className="island-dot" data-live={kind === 'session' || undefined} aria-hidden="true" />;
}

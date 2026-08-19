import {useCallback, useEffect, useRef, useState} from 'react';

import {api} from '../lib/api';
import {onWsMessage} from '../lib/ws';
import {openExternal} from '../lib/env';
import {
  clipTitle,
  type Clip,
  type YouTubeConnector,
  type YouTubeConnectorStatus,
  type YouTubePrivacy,
  type YouTubeUploadJob,
  type YouTubeUploadState,
} from '../lib/types';
import {YOUTUBE_PRIVACY_LABELS} from '../lib/settingsDraft';
import {elapsedLabel, pickConnector, renderTitleTemplate} from '../lib/youtube';
import {useStore} from '../state/store';
import {Modal} from './Modal';

/** Remembers the connector last used, so the common case is one click. */
const LAST_CONNECTOR_KEY = 'vice-youtube-connector';

const readLastConnector = (): string => {
  try {
    return localStorage.getItem(LAST_CONNECTOR_KEY) ?? '';
  } catch {
    return '';
  }
};

const rememberConnector = (id: string): void => {
  try {
    localStorage.setItem(LAST_CONNECTOR_KEY, id);
  } catch {
    // Losing the preference is not worth an error.
  }
};

type Phase = 'form' | 'busy' | 'result';

export function YouTubeModal({clip, onClose}: {clip: Clip | null; onClose: () => void}) {
  const {state: store, notify} = useStore();

  const connectors = ((store.config?.youtube as Record<string, unknown> | undefined)?.connectors ??
    []) as YouTubeConnector[];

  const [statuses, setStatuses] = useState<YouTubeConnectorStatus[]>([]);
  const [otherJob, setOtherJob] = useState<YouTubeUploadJob | null>(null);

  const [connectorId, setConnectorId] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [privacy, setPrivacy] = useState<YouTubePrivacy>('unlisted');
  const [tags, setTags] = useState('');
  const [playlistIds, setPlaylistIds] = useState('');
  const [notify_, setNotify] = useState(false);

  const [phase, setPhase] = useState<Phase>('form');
  const [job, setJob] = useState<YouTubeUploadJob | null>(null);
  const [now, setNow] = useState(Date.now());

  const jobRef = useRef<string | null>(null);
  // One auto-copy per job: a re-render must not re-copy and re-toast.
  const copiedRef = useRef<Set<string>>(new Set());

  const connector = connectors.find(c => c.id === connectorId) ?? null;

  useEffect(() => {
    if (!clip || !connectors.length) return;
    const chosen = pickConnector(connectors, readLastConnector(), clip.game);
    setConnectorId(chosen?.id ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clip?.slug, connectors.length]);

  // Seed the form from the chosen connector's defaults.
  useEffect(() => {    if (!clip || !connector) return;
    setTitle(renderTitleTemplate(connector.title_template, clip));
    setDescription(connector.description ?? '');
    setPrivacy(connector.privacy ?? 'unlisted');
    setTags((connector.tags ?? []).join(', '));
    setPlaylistIds((connector.playlist_ids ?? []).join('\n'));
    setNotify(Boolean(connector.notify));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clip?.slug, connectorId]);

  useEffect(() => {
    if (!clip) return;
    setPhase('form');
    setJob(null);
    jobRef.current = null;
    void api
      .youtubeStatus()
      .then(result => {
        setStatuses(result.connectors ?? []);
        // The daemon allows one upload at a time, so another clip's job
        // blocks this one.
        setOtherJob(result.active && result.active.slug !== clip.slug ? result.active : null);
      })
      .catch(() => setStatuses([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clip?.slug]);

  // The elapsed clock only ticks while an upload is actually running.
  useEffect(() => {
    if (phase !== 'busy') return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [phase]);

  const finish = useCallback(
    (next: YouTubeUploadJob) => {
      jobRef.current = null;
      setJob(next);
      setPhase('result');

      // Auto-copy the URL once, which is almost always what is wanted next.
      if (next.url && !copiedRef.current.has(next.job_id)) {
        copiedRef.current.add(next.job_id);
        void navigator.clipboard
          ?.writeText(next.url)
          .then(() =>
            notify({
              kind: 'info',
              title: 'YouTube link copied',
              tone: 'accent',
              holdMs: 2500,
            }),
          )
          .catch(() => undefined);
      }
    },
    [notify],
  );

  useEffect(() => {
    if (!clip) return;
    return onWsMessage(msg => {
      const event = msg as unknown as YouTubeUploadJob & {type: string};
      // Another clip's upload must not drive this modal.
      if (event.slug !== clip.slug) return;
      if (jobRef.current && event.job_id !== jobRef.current) return;

      if (event.type === 'youtube_upload_started') {
        jobRef.current = event.job_id;
        setJob(event);
        setPhase('busy');
      } else if (event.type === 'youtube_upload_done' || event.type === 'youtube_upload_error') {
        finish(event);
      }
    });
  }, [clip, finish]);

  if (!clip) return null;

  const status = statuses.find(s => s.id === connectorId);
  const blocked = Boolean(otherJob);
  const canStart =
    Boolean(connector) && title.trim().length > 0 && !blocked && phase !== 'busy';

  const start = () => {
    if (!connector) return;
    if (!title.trim()) {
      notify({kind: 'error', title: 'Give the video a title', tone: 'error', holdMs: 4000});
      return;
    }
    setPhase('busy');
    setNow(Date.now());
    rememberConnector(connector.id);
    void api
      .uploadToYoutube(clip.slug, {
        connector_id: connector.id,
        title: title.trim(),
        description,
        privacy,
        tags: tags
          .split(',')
          .map(t => t.trim())
          .filter(Boolean),
        playlist_ids: playlistIds
          .split('\n')
          .map(t => t.trim())
          .filter(Boolean),
        notify: notify_,
      })
      .then(result => {
        if (result.ok === false) {
          if (result.active) setOtherJob(result.active);
          throw new Error(result.error || 'Upload could not start');
        }
        jobRef.current = result.job?.job_id ?? null;
        setJob(result.job ?? null);
      })
      .catch((err: Error) => {
        setPhase('form');
        notify({
          kind: 'error',
          title: 'YouTube upload could not start',
          detail: err.message,
          tone: 'error',
          holdMs: 7000,
        });
      });
  };

  const cancel = () => {
    const id = jobRef.current;
    if (!id) return;
    void api.cancelYoutubeUpload(id).catch((err: Error) =>
      notify({
        kind: 'error',
        title: 'Could not cancel the upload',
        detail: err.message,
        tone: 'error',
        holdMs: 6000,
      }),
    );
  };

  const resultTone = (state: YouTubeUploadState | undefined, canceled?: boolean) =>
    canceled ? 'canceled' : state === 'done' ? 'done' : state === 'partial' ? 'partial' : 'error';

  return (
    <Modal
      open={clip !== null}
      title="Upload to YouTube"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-quiet" onClick={onClose}>
            Close
          </button>
          {phase === 'busy' ? (
            <button type="button" className="btn" onClick={cancel}>
              Cancel upload
            </button>
          ) : phase === 'result' ? (
            <button type="button" className="btn" onClick={() => setPhase('form')}>
              {job?.status === 'done' ? 'Upload another' : 'Try again'}
            </button>
          ) : (
            <button type="button" className="btn" disabled={!canStart} onClick={start}>
              Upload
            </button>
          )}
        </>
      }>
      <p className="meta-clip-name">{clipTitle(clip)}</p>

      {!connectors.length ? (
        <p className="fs-hint">
          No YouTube connectors yet. Add one under Settings, YouTube uploads.
        </p>
      ) : null}

      {blocked && otherJob ? (
        <p className="fs-error" role="status">
          An upload is already running for {otherJob.slug}. Only one runs at a time.
        </p>
      ) : null}

      {phase === 'form' && connectors.length ? (
        <>
          <label className="meta-field">
            <span>Connector</span>
            <select
              className="select"
              value={connectorId}
              onChange={e => setConnectorId(e.target.value)}>
              {connectors.map(c => (
                <option key={c.id} value={c.id}>
                  {c.name || c.id}
                </option>
              ))}
            </select>
            {status && !status.available ? (
              <span className="fs-error">{status.error || 'This connector is not ready.'}</span>
            ) : null}
          </label>

          <label className="meta-field">
            <span>Title</span>
            <input
              className="text-input"
              value={title}
              maxLength={100}
              onChange={e => setTitle(e.target.value)}
            />
          </label>

          <label className="meta-field">
            <span>Description</span>
            <textarea
              className="text-area"
              rows={3}
              maxLength={5000}
              value={description}
              onChange={e => setDescription(e.target.value)}
            />
          </label>

          <label className="meta-field">
            <span>Privacy</span>
            <select
              className="select"
              value={privacy}
              onChange={e => setPrivacy(e.target.value as YouTubePrivacy)}>
              {YOUTUBE_PRIVACY_LABELS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>

          <label className="meta-field">
            <span>Tags</span>
            <input
              className="text-input"
              value={tags}
              placeholder="Comma separated"
              onChange={e => setTags(e.target.value)}
            />
          </label>

          <label className="meta-field">
            <span>Playlist IDs</span>
            <textarea
              className="text-area"
              rows={2}
              value={playlistIds}
              placeholder="One per line"
              onChange={e => setPlaylistIds(e.target.value)}
            />
          </label>

          <label className="meta-check">
            <input
              type="checkbox"
              checked={notify_}
              onChange={e => setNotify(e.target.checked)}
            />
            <span>Notify subscribers</span>
          </label>
        </>
      ) : null}

      {phase === 'busy' ? (
        <div className="meta-field">
          <span>Uploading</span>
          <div className="fs-status">
            <span className="fs-state">{job?.title || title}</span>
            <span className="fs-pct">{elapsedLabel(job?.started_at, now)}</span>
          </div>
          <span className="fs-hint">
            youtubeuploader does not report progress, so this is elapsed time, not a percentage.
          </span>
        </div>
      ) : null}

      {phase === 'result' && job ? (
        <div className="meta-field">
          <span>Result</span>
          <span className="fs-state" data-yt={resultTone(job.status, job.canceled)}>
            {job.canceled
              ? 'Upload canceled'
              : job.status === 'done'
                ? 'Uploaded'
                : job.status === 'partial'
                  ? 'Uploaded, with a problem afterwards'
                  : 'Upload failed'}
          </span>
          {job.warning ? <span className="fs-hint">{job.warning}</span> : null}
          {job.error ? (
            <span className="fs-error" role="alert">
              {job.error}
            </span>
          ) : null}
          {job.url ? (
            <>
              <input className="text-input" readOnly value={job.url} />
              <div className="field-row">
                <button
                  type="button"
                  className="btn btn-quiet btn-sm"
                  onClick={() => job.url && openExternal(job.url)}>
                  Watch on YouTube
                </button>
              </div>
            </>
          ) : null}
        </div>
      ) : null}
    </Modal>
  );
}

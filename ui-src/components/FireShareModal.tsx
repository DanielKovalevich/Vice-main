import {useCallback, useEffect, useRef, useState} from 'react';

import {api} from '../lib/api';
import {onWsMessage} from '../lib/ws';
import {openExternal} from '../lib/env';
import {
  clipTitle,
  fireSharePrivacyFromBool,
  fireSharePrivacyToBool,
  isFireSharePublishMessage,
  type Clip,
  type FireSharePrivacy,
  type FireShareState,
} from '../lib/types';
import {FIRESHARE_PRIVACY_LABELS} from '../lib/settingsDraft';
import {applyPublishEvent, isTerminal} from '../lib/fireshare';
import {useStore} from '../state/store';
import {Modal} from './Modal';

/** Matches the daemon's validate_folder_name(). */
const FOLDER_RE = /^[A-Za-z0-9_-]{1,128}$/;

const STATE_LABEL: Record<FireShareState, string> = {
  idle: 'Not published',
  uploading: 'Uploading',
  processing: 'Processing',
  ready: 'Ready',
  failed: 'Failed',
  stale: 'Superseded',
  canceled: 'Canceled',
};

/**
 * Publish one clip to FireShare.
 *
 * Progress is taken straight off the socket rather than through the store,
 * following the same reasoning as the editor's export modal: it arrives many
 * times a second and belongs to whoever opened this modal, so routing it
 * through a dispatch would re-render the whole app for a bar nobody else is
 * watching.
 *
 * Two guards keep that stream honest, and both matter:
 *
 *   * `attempt_id` - events for a previous attempt are dropped outright, so a
 *     retry is never scribbled on by the attempt it replaced.
 *   * `seq` - the daemon coalesces progress, but ticks can still arrive late
 *     or out of order. Anything not newer than what is already held is
 *     dropped, otherwise the bar walks backwards and, worse, a stale progress
 *     tick can overwrite a terminal state that arrived first.
 */
export function FireShareModal({clip, onClose}: {clip: Clip | null; onClose: () => void}) {
  const {state: store, notify} = useStore();

  const [title, setTitle] = useState('');
  const [folder, setFolder] = useState('');
  const [privacy, setPrivacy] = useState<FireSharePrivacy>('server_default');
  const [folders, setFolders] = useState<string[]>([]);
  const [foldersError, setFoldersError] = useState('');
  const [creatingFolder, setCreatingFolder] = useState(false);

  const [publishState, setPublishState] = useState<FireShareState>('idle');
  const [progress, setProgress] = useState(0);
  const [publicUrl, setPublicUrl] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [cancelPending, setCancelPending] = useState(false);

  const attemptRef = useRef<string | null>(null);
  const seqRef = useRef<number>(-1);
  // The socket handler is installed once per clip, so it cannot read state
  // through a closure without going stale. These mirror what is rendered.
  const publishStateRef = useRef<FireShareState>('idle');
  const progressRef = useRef(0);
  const urlRef = useRef('');
  const errorRef = useRef('');

  const defaultPrivacy = ((store.config?.fireshare as Record<string, unknown> | undefined)
    ?.default_privacy ?? 'server_default') as FireSharePrivacy;
  const defaultFolder = ((store.config?.fireshare as Record<string, unknown> | undefined)
    ?.default_folder ?? '') as string;

  const slug = clip?.slug ?? '';

  // Seed from the clip and from any attempt it already carries.
  useEffect(() => {
    if (!clip) return;
    const existing = clip.fireshare?.current ?? clip.fireshare?.last_ready ?? null;

    setTitle(clipTitle(clip));
    setError(existing?.error_message ?? '');
    setPublicUrl(existing?.public_url ?? '');
    setPublishState(existing?.state ?? 'idle');
    setProgress(existing?.progress_pct ?? 0);
    setFolder(existing?.folder || defaultFolder);
    setBusy(false);
    setCancelPending(false);

    // Republishing reuses the previous choice only when it was explicit.
    // A previous "server default" is not a preference, so it falls back to
    // whatever the global default is now.
    setPrivacy(
      existing && existing.requested_private !== null && existing.requested_private !== undefined
        ? fireSharePrivacyFromBool(existing.requested_private)
        : defaultPrivacy,
    );

    attemptRef.current = existing?.attempt_id ?? null;
    seqRef.current = -1;
    publishStateRef.current = existing?.state ?? 'idle';
    progressRef.current = existing?.progress_pct ?? 0;
    urlRef.current = existing?.public_url ?? '';
    errorRef.current = existing?.error_message ?? '';
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clip?.slug]);

  // Folder list. A FireShare that is not set up yet answers with an error, and
  // that is a normal state, not a failure worth a toast.
  useEffect(() => {
    if (!clip) return;
    let cancelled = false;
    void api
      .fireshareFolders()
      .then(result => {
        if (cancelled) return;
        if (result.ok === false) {
          setFolders([]);
          setFoldersError(result.error ?? 'Folders unavailable');
          return;
        }
        setFolders(result.folders ?? []);
        setFoldersError('');
      })
      .catch((err: Error) => !cancelled && setFoldersError(err.message));
    return () => {
      cancelled = true;
    };
  }, [clip?.slug]);

  const apply = useCallback(
    (msg: {
      attempt_id: string;
      seq: number;
      state?: FireShareState;
      progress_pct?: number;
      public_url?: string;
      error_message?: string;
    }) => {
      const result = applyPublishEvent(
        {state: publishStateRef.current, progress: progressRef.current, publicUrl: urlRef.current, error: errorRef.current},
        msg,
        attemptRef.current,
        seqRef.current,
      );
      if (!result) return;
      seqRef.current = result.seq;

      publishStateRef.current = result.view.state;
      progressRef.current = result.view.progress;
      urlRef.current = result.view.publicUrl;
      errorRef.current = result.view.error;

      setPublishState(result.view.state);
      setProgress(result.view.progress);
      setPublicUrl(result.view.publicUrl);
      setError(result.view.error);

      if (isTerminal(result.view.state)) {
        setBusy(false);
        setCancelPending(false);
      }
    },
    [],
  );

  useEffect(() => {
    if (!clip) return;
    return onWsMessage(msg => {
      if (!isFireSharePublishMessage(msg)) return;
      if (msg.slug !== slug) return;
      apply(msg);
    });
  }, [clip, slug, apply]);

  if (!clip) return null;

  const folderInvalid = folder.trim() !== '' && !FOLDER_RE.test(folder.trim());
  const active = publishState === 'uploading' || publishState === 'processing';

  const publish = () => {
    if (folderInvalid) return;
    setBusy(true);
    setError('');
    setProgress(0);
    setPublicUrl('');
    // A fresh attempt starts a fresh sequence, so the guard must be reset or
    // the new attempt's early ticks look stale.
    seqRef.current = -1;
    progressRef.current = 0;
    urlRef.current = '';
    errorRef.current = '';
    void api
      .publishToFireshare(slug, {
        title: title.trim() || clipTitle(clip),
        folder: folder.trim(),
        private: fireSharePrivacyToBool(privacy),
      })
      .then(result => {
        if (result.ok === false) throw new Error(result.error || 'Publish failed');
        attemptRef.current = result.attempt?.attempt_id ?? null;
        publishStateRef.current = result.attempt?.state ?? 'uploading';
        setPublishState(publishStateRef.current);
      })
      .catch((err: Error) => {
        setBusy(false);
        setPublishState('failed');
        setError(err.message);
        notify({
          kind: 'error',
          title: 'Could not publish to FireShare',
          detail: err.message,
          tone: 'error',
          holdMs: 7000,
        });
      });
  };

  const cancel = () => {
    const attemptId = attemptRef.current;
    if (!attemptId) return;
    setCancelPending(true);
    void api
      .cancelFireshare(attemptId)
      .then(result => {
        // cancelled:false is not a failure. It means the upload reached a
        // terminal state before the cancel landed, which is worth saying
        // plainly rather than reporting as an error.
        if (result.cancelled === false) {
          notify({
            kind: 'info',
            title: 'Upload already finished',
            detail: 'It completed before the cancel reached it.',
            tone: 'neutral',
            holdMs: 5000,
          });
          return;
        }
        setPublishState('canceled');
      })
      .catch((err: Error) =>
        notify({
          kind: 'error',
          title: 'Could not cancel',
          detail: err.message,
          tone: 'error',
          holdMs: 6000,
        }),
      )
      .finally(() => setCancelPending(false));
  };

  const retry = () => {
    const attemptId = attemptRef.current;
    if (!attemptId) {
      publish();
      return;
    }
    setBusy(true);
    setError('');
    seqRef.current = -1;
    errorRef.current = '';
    void api
      .retryFireshare(attemptId)
      .then(result => {
        if (result.ok === false) throw new Error(result.error || 'Retry failed');
        attemptRef.current = result.attempt?.attempt_id ?? attemptId;
        publishStateRef.current = result.attempt?.state ?? 'uploading';
        setPublishState(publishStateRef.current);
      })
      .catch((err: Error) => {
        setBusy(false);
        setError(err.message);
      });
  };

  const copyLink = () => {
    if (!publicUrl) return;
    void navigator.clipboard
      ?.writeText(publicUrl)
      .then(() =>
        notify({kind: 'info', title: 'FireShare link copied', tone: 'accent', holdMs: 2500}),
      )
      .catch(() => undefined);
  };

  return (
    <Modal
      open={clip !== null}
      title="Publish to FireShare"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-quiet" onClick={onClose}>
            Close
          </button>
          {active ? (
            <button type="button" className="btn" disabled={cancelPending} onClick={cancel}>
              {cancelPending ? 'Canceling' : 'Cancel upload'}
            </button>
          ) : publishState === 'failed' ? (
            <button type="button" className="btn" disabled={busy} onClick={retry}>
              {busy ? 'Retrying' : 'Try again'}
            </button>
          ) : (
            <button type="button" className="btn" disabled={busy || folderInvalid} onClick={publish}>
              {publishState === 'ready' ? 'Publish again' : busy ? 'Publishing' : 'Publish'}
            </button>
          )}
        </>
      }>
      <p className="meta-clip-name">{clipTitle(clip)}</p>

      <label className="meta-field">
        <span>Title</span>
        <input
          className="text-input"
          value={title}
          maxLength={200}
          spellCheck={false}
          onChange={e => setTitle(e.target.value)}
        />
      </label>

      <div className="meta-field">
        <span>Folder</span>
        {folders.length && !creatingFolder ? (
          <select className="select" value={folder} onChange={e => setFolder(e.target.value)}>
            <option value="">(FireShare default)</option>
            {folders.map(name => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        ) : (
          <input
            className="text-input"
            value={folder}
            placeholder="(FireShare default)"
            maxLength={128}
            spellCheck={false}
            onChange={e => setFolder(e.target.value)}
          />
        )}
        {folders.length ? (
          <button
            type="button"
            className="btn btn-quiet btn-sm"
            onClick={() => setCreatingFolder(v => !v)}>
            {creatingFolder ? 'Pick an existing folder' : 'Use a new folder'}
          </button>
        ) : null}
        {folderInvalid ? (
          <span className="fs-error" role="alert">
            Letters, numbers, dashes and underscores only.
          </span>
        ) : null}
        {foldersError && !folders.length ? (
          <span className="fs-hint">{foldersError}</span>
        ) : null}
      </div>

      <label className="meta-field">
        <span>Privacy</span>
        <select
          className="select"
          value={privacy}
          onChange={e => setPrivacy(e.target.value as FireSharePrivacy)}>
          {FIRESHARE_PRIVACY_LABELS.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>

      <div className="meta-field">
        <span>Status</span>
        <div className="fs-status">
          <span className="fs-state" data-state={publishState}>
            {STATE_LABEL[publishState]}
          </span>
          {active ? <span className="fs-pct">{Math.round(progress)}%</span> : null}
        </div>
        {active ? (
          <div className="fs-bar" role="progressbar" aria-valuenow={Math.round(progress)}>
            <div className="fs-bar-fill" style={{width: `${Math.min(100, progress)}%`}} />
          </div>
        ) : null}
        {error ? (
          <span className="fs-error" role="alert">
            {error}
          </span>
        ) : null}
      </div>

      {publicUrl ? (
        <div className="meta-field">
          <span>Link</span>
          <input className="text-input" readOnly value={publicUrl} />
          <div className="field-row">
            <button type="button" className="btn btn-quiet btn-sm" onClick={copyLink}>
              Copy link
            </button>
            <button
              type="button"
              className="btn btn-quiet btn-sm"
              onClick={() => openExternal(publicUrl)}>
              Open in FireShare
            </button>
          </div>
        </div>
      ) : null}
    </Modal>
  );
}

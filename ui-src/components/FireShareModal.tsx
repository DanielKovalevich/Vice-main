import {useCallback, useEffect, useRef, useState} from 'react';

import {api} from '../lib/api';
import {onWsMessage} from '../lib/ws';
import {openExternal} from '../lib/env';
import {
  clipTitle,
  isFireSharePublishMessage,
  type Clip,
  type FireShareState,
} from '../lib/types';
import {applyPublishEvent, isTerminal, suggestDestination, validUploadFolder} from '../lib/fireshare';
import {useStore} from '../state/store';
import {Modal} from './Modal';

const STATE_LABEL: Record<FireShareState, string> = {
  idle: 'Not published',
  uploading: 'Uploading',
  processing: 'Processing',
  ready: 'Ready',
  uploaded: 'Uploaded',
  retryable_ambiguous: 'Upload not confirmed',
  failed: 'Failed',
  stale: 'Superseded',
  canceled: 'Canceled',
};

/**
 * Publish one clip to FireShare.
 *
 * Progress comes off the socket rather than the store, following the editor's
 * export modal: it arrives many times a second and belongs only to this modal,
 * so dispatching it would re-render the whole app.
 */
export function FireShareModal({clip, onClose}: {clip: Clip | null; onClose: () => void}) {
  const {state: store, notify} = useStore();

  const [title, setTitle] = useState('');
  const [folder, setFolder] = useState('');
  const [gameId, setGameId] = useState('choose');
  const [needsFolderChoice, setNeedsFolderChoice] = useState(false);
  const [games, setGames] = useState<{id: number; name: string}[]>([]);
  const [folderRules, setFolderRules] = useState<{folder: string; game_id: number}[]>([]);
  const [serverFolder, setServerFolder] = useState('');
  const [optionsLoaded, setOptionsLoaded] = useState(false);
  const destinationTouched = useRef(false);
  const [folders, setFolders] = useState<string[]>([]);
  const [foldersError, setFoldersError] = useState('');
  const [creatingFolder, setCreatingFolder] = useState(false);

  const [publishState, setPublishState] = useState<FireShareState>('idle');
  const [progress, setProgress] = useState(0);
  const [publicUrl, setPublicUrl] = useState('');
  const [deduplicated, setDeduplicated] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [cancelPending, setCancelPending] = useState(false);

  const attemptRef = useRef<string | null>(null);
  const seqRef = useRef<number>(-1);
  // The socket handler is installed once per clip, so it cannot read state
  // through a closure without going stale.
  const publishStateRef = useRef<FireShareState>('idle');
  const progressRef = useRef(0);
  const urlRef = useRef('');
  const errorRef = useRef('');

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
    setDeduplicated(Boolean(existing?.deduplicated));
    setPublishState(existing?.state ?? 'idle');
    setProgress(existing?.progress_pct ?? 0);
    setFolder(existing?.folder || defaultFolder);
    setBusy(false);
    setCancelPending(false);

    setGameId(existing?.game_id ? String(existing.game_id) : 'choose');
    setOptionsLoaded(false);
    destinationTouched.current = false;

    attemptRef.current = existing?.attempt_id ?? null;
    seqRef.current = -1;
    publishStateRef.current = existing?.state ?? 'idle';
    progressRef.current = existing?.progress_pct ?? 0;
    urlRef.current = existing?.public_url ?? '';
    errorRef.current = existing?.error_message ?? '';
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clip?.slug]);

  // A FireShare that is not set up yet answers with an error, which is a
  // normal state rather than a failure worth a toast.
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
        const availableGames = result.games ?? [];
        const rules = result.folder_rules ?? [];
        setFolders(result.folders ?? []);
        setGames(availableGames);
        setFolderRules(rules);
        setServerFolder(result.default_folder ?? '');
        setOptionsLoaded(true);
        setFoldersError('');
        if (!destinationTouched.current) {
          const suggested = suggestDestination(clip.game, {
            default_folder: result.default_folder ?? '', folders: result.folders ?? [],
            games: availableGames, folder_rules: rules,
          }, defaultFolder, clip.fireshare?.current);
          setGameId(suggested.gameId);
          setFolder(suggested.folder);
          setNeedsFolderChoice(suggested.needsFolderChoice);
          setCreatingFolder(Boolean(suggested.folder && !result.folders?.includes(suggested.folder)));
        }
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
      deduplicated?: boolean;
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
      if (msg.deduplicated !== undefined) setDeduplicated(msg.deduplicated);

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

  const folderInvalid = folder !== '' && !validUploadFolder(folder);
  const effectiveFolder = folder || serverFolder;
  const mappedGames = new Set(folderRules.filter(r => r.folder === effectiveFolder).map(r => r.game_id));
  const destinationConflict = mappedGames.size > 1 ||
    (gameId !== '' && gameId !== 'choose' && mappedGames.size > 0 && !mappedGames.has(Number(gameId)));
  const destinationInvalid = folderInvalid || needsFolderChoice || destinationConflict || !optionsLoaded || gameId === 'choose';
  const effectiveGame = gameId !== '' && gameId !== 'choose' ? Number(gameId) : [...mappedGames][0];
  const active = publishState === 'uploading' || publishState === 'processing';

  const publish = () => {
    if (destinationInvalid) return;
    setBusy(true);
    setError('');
    setProgress(0);
    setPublicUrl('');
    setDeduplicated(false);
    // A fresh attempt restarts the sequence, so the guard must be reset.
    seqRef.current = -1;
    progressRef.current = 0;
    urlRef.current = '';
    errorRef.current = '';
    void api
      .publishToFireshare(slug, {
        title: title.trim() || clipTitle(clip),
        folder: effectiveFolder,
        game_id: effectiveGame ?? null,
      })
      .then(result => {
        if (result.ok === false) throw new Error(result.error || 'Publish failed');
        attemptRef.current = result.attempt?.attempt_id ?? null;
        publishStateRef.current = result.attempt?.state ?? 'uploading';
        setPublishState(publishStateRef.current);
        const attemptId = attemptRef.current;
        void api.clipFireshare(slug).then(snapshot => {
          const current = snapshot.fireshare?.current;
          if (!current || current.attempt_id !== attemptId || attemptRef.current !== attemptId
              || !isTerminal(current.state)) return;
          seqRef.current = Number.MAX_SAFE_INTEGER;
          publishStateRef.current = current.state;
          urlRef.current = current.public_url || '';
          setPublishState(current.state);
          setPublicUrl(urlRef.current);
          setDeduplicated(Boolean(current.deduplicated));
          setError(current.error_message || '');
          if (current.state === 'uploaded' || current.state === 'ready') setProgress(100);
          setBusy(false);
        }).catch(() => undefined);
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
        // cancelled:false means the upload reached a terminal state first,
        // which is worth saying plainly rather than reporting as an error.
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
          ) : (publishState === 'failed' || publishState === 'retryable_ambiguous') ? (
            <>
              <button type="button" className="btn" disabled={busy} onClick={retry}>
                {busy ? 'Retrying' : 'Try again'}
              </button>
              <button type="button" className="btn" disabled={busy || destinationInvalid} onClick={publish}>
                Publish with these choices
              </button>
            </>
          ) : (
            <button type="button" className="btn" disabled={busy || destinationInvalid} onClick={publish}>
              {(publishState === 'ready' || publishState === 'uploaded') ? 'Publish again' : busy ? 'Publishing' : 'Publish'}
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
          <select className="select" value={needsFolderChoice ? '?' : folder} onChange={e => {destinationTouched.current = true; setNeedsFolderChoice(false); setFolder(e.target.value);}}>
            <option value="?" disabled>Choose a folder</option>
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
            maxLength={255}
            spellCheck={false}
            onChange={e => {destinationTouched.current = true; setNeedsFolderChoice(false); setFolder(e.target.value);}}
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
            Use a folder name without leading dots, slashes, or surrounding whitespace.
          </span>
        ) : null}
        {foldersError && !folders.length ? (
          <span className="fs-hint">{foldersError}</span>
        ) : null}
      </div>

      <label className="meta-field">
        <span>Game</span>
        <select className="select" value={gameId} disabled={!optionsLoaded}
          onChange={e => {
            destinationTouched.current = true;
            const value = e.target.value;
            setGameId(value);
            const mapped = folderRules.filter(r => r.game_id === Number(value));
            if (mapped.length === 1) setFolder(mapped[0].folder);
            setNeedsFolderChoice(mapped.length > 1 && !mapped.some(r => r.folder === effectiveFolder));
          }}>
          <option value="choose" disabled>Choose a game</option>
          <option value="">Use folder rules only</option>
          {games.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
        </select>
        <span className="fs-hint">Missing games can be added in FireShare, then reopen this dialog.</span>
      </label>
      {destinationConflict ? <p className="fs-error" role="alert">
        This folder is assigned to another game. Choose a matching folder and game.
      </p> : optionsLoaded && gameId !== 'choose' ? <p className="fs-hint">
        Selected destination: {effectiveFolder} · {games.find(g => g.id === effectiveGame)?.name ?? 'No game assignment'}
      </p> : null}
      <p className="fs-hint">Uploads use FireShare’s configured privacy defaults.</p>

      <div className="meta-field">
        <span>Status</span>
        <div className="fs-status">
          <span className="fs-state" data-state={publishState}>
            {publishState === 'uploaded' && deduplicated ? 'Already uploaded' : STATE_LABEL[publishState]}
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

      {publishState === 'uploaded' ? <p className="fs-hint">
        {deduplicated ? 'This clip already exists in FireShare. Its existing folder and game were retained.'
          : 'Upload accepted. You can copy the link now; playback may take a moment while FireShare processes it.'}
      </p> : null}
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

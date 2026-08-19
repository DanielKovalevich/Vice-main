import {useEffect, useState} from 'react';

import {api} from '../lib/api';
import {copyToClipboard} from '../lib/clipboard';
import {openExternal} from '../lib/env';
import {useStore} from '../state/store';
import {Modal} from './Modal';

const DISMISSED_KEY = 'vice_update_dismissed';

/**
 * The "a new version is out" notice.
 *
 * It appears once per release. "Later" retires that version for good, stored
 * on the daemon as well as locally because the native window's localStorage
 * does not survive a restart on every QtWebEngine build. The chip in the
 * sidebar stays either way, so the update is still findable.
 */
export function UpdateNotice({
  forceOpen,
  onClose,
}: {
  forceOpen: boolean;
  onClose: () => void;
}) {
  const {state, notify} = useStore();
  const update = state.update;
  const [auto, setAuto] = useState(false);
  const [manualCopy, setManualCopy] = useState<string | null>(null);

  useEffect(() => {
    if (!update?.version) return;
    let cancelled = false;
    if (localStorage.getItem(DISMISSED_KEY) === update.version) return;
    void api
      .getAppState()
      .then(s => {
        if (cancelled) return;
        if (s.update_dismissed_version === update.version) {
          localStorage.setItem(DISMISSED_KEY, update.version);
          return;
        }
        setAuto(true);
      })
      .catch(() => !cancelled && setAuto(true));
    return () => {
      cancelled = true;
    };
  }, [update?.version]);

  if (!update?.version) return null;

  const command = update.install?.command ?? '';
  const open = auto || forceOpen;

  const close = () => {
    setAuto(false);
    onClose();
  };

  const dismiss = () => {
    localStorage.setItem(DISMISSED_KEY, update.version);
    void api.setAppState({update_dismissed_version: update.version}).catch(err => {
      console.debug('Recording the dismissed update failed', err);
    });
    close();
  };

  const copyCommand = async () => {
    if (!command) return;
    if (await copyToClipboard(command)) {
      notify({
        kind: 'info',
        title: 'Command copied, paste it into a terminal',
        tone: 'accent',
        holdMs: 4000,
      });
    } else {
      setManualCopy(command);
    }
  };

  return (
    <>
      <Modal
        open={open}
        title={`Vice ${update.version} is available`}
        onClose={close}
        footer={
          <>
            <button type="button" className="btn btn-quiet" onClick={dismiss}>
              Later
            </button>
            <button
              type="button"
              className="btn btn-quiet"
              onClick={() => openExternal(update.url)}>
              Release notes
            </button>
            {command ? (
              <button type="button" className="btn" onClick={() => void copyCommand()}>
                Copy command
              </button>
            ) : null}
          </>
        }>
        <p>
          You are on {state.status.version || 'an older release'}.
          {command ? ' Update with:' : ''}
        </p>
        {command ? <code className="update-cmd mono">{command}</code> : null}
        {update.notes?.length ? (
          <ul className="update-notes">
            {update.notes.map(note => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        ) : null}
      </Modal>

      <Modal open={manualCopy !== null} title="Copy this command" onClose={() => setManualCopy(null)}>
        <p>The clipboard was not available, so here is the command to copy by hand.</p>
        <textarea className="manual-copy" readOnly value={manualCopy ?? ''} rows={2} />
      </Modal>
    </>
  );
}

import {useStore, type BannerId} from '../state/store';
import {H264_SUPPORTED} from '../lib/env';
import {IconClose, IconWarning} from './Icons';

/**
 * The four states worth interrupting for. Wording is carried over from the
 * releases that introduced each one: it took real back and forth with the
 * reporters to land on text that says what happened and what to do about it.
 */
export function Banners() {
  const {state, dispatch} = useStore();
  const {status, dismissed} = state;

  const showing = (id: BannerId) => !dismissed.includes(id);
  const dismiss = (banner: BannerId) => () => dispatch({type: 'dismiss', banner});

  const recorderDown = status.ready === false && Boolean(status.recorder_error);

  return (
    <div className="banners">
      {/* Not dismissible: the daemon is up but nothing is being recorded, so
          the window exists mainly to say this and keep Settings reachable. */}
      {recorderDown ? (
        <Banner tone="error">
          <strong>Vice is not recording.</strong>
          <span className="banner-mono">{status.recorder_error}</span>
          <span>
            Vice keeps retrying on its own. If it is an encoder problem, a reboot after a driver
            update usually clears it, or pick a different encoder under Settings, Recording.
          </span>
        </Banner>
      ) : null}

      {status.cpu_fallback && showing('cpu') ? (
        <Banner tone="warning" onDismiss={dismiss('cpu')}>
          <strong>Recording on the CPU.</strong>
          <span>
            Your GPU encoder would not open, so Vice fell back to CPU encoding to keep clipping.
            That costs frames in games. This is usually a driver that needs a reboot after an
            update. Vice tries the GPU first every time it starts, so once that is sorted this goes
            away on its own.
          </span>
        </Banner>
      ) : null}

      {status.codec_fallback && showing('codec-gpu') ? (
        <Banner tone="warning" onDismiss={dismiss('codec-gpu')}>
          <strong>Recording with a different codec.</strong>
          <span>
            Your GPU would not encode the codec picked under Settings, Recording, so
            gpu-screen-recorder chose one it can handle. Recording is still on the GPU and clips
            are unaffected. Choosing a different encoder yourself stops this notice, and H.264 in
            particular tops out at 4096 pixels wide on NVIDIA, so HEVC or AV1 is the one to pick on
            a wide monitor.
          </span>
        </Banner>
      ) : null}

      {!H264_SUPPORTED && showing('codec-h264') ? (
        <Banner tone="warning" onDismiss={dismiss('codec-h264')}>
          <strong>Clips cannot play inside this window.</strong>
          <span>
            The installed Qt WebEngine build has no H.264 decoder. Recording still works, and clips
            open fine in your system player. To fix in-app playback, install your distro's
            WebEngine package and reinstall Vice:
          </span>
          <span className="banner-mono">sudo apt install python3-pyqt6.qtwebengine</span>
          <span className="banner-mono">sudo dnf install python3-pyqt6-webengine</span>
          <span className="banner-mono">sudo zypper install python3-qt6-webengine</span>
        </Banner>
      ) : null}
    </div>
  );
}

function Banner({
  tone,
  onDismiss,
  children,
}: {
  tone: 'error' | 'warning';
  onDismiss?: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="banner" data-tone={tone} role={tone === 'error' ? 'alert' : 'status'}>
      <IconWarning size={17} className="banner-icon" />
      <div className="banner-text">{children}</div>
      {onDismiss ? (
        <button type="button" className="banner-close" onClick={onDismiss} aria-label="Dismiss">
          <IconClose size={14} />
        </button>
      ) : null}
    </div>
  );
}

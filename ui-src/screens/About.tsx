import {useMemo, useState} from 'react';

import {useStore} from '../state/store';
import {copyToClipboard} from '../lib/clipboard';
import {formatBytes, formatLengthLong} from '../lib/format';
import {Wordmark} from '../components/Wordmark';
import {Modal} from '../components/Modal';
import {IconMark} from '../components/Icons';

const UNINSTALL_CMD = 'vice uninstall';

export function About() {
  const {state, notify} = useStore();
  const {status, config, clips} = state;
  const [manualCopy, setManualCopy] = useState<string | null>(null);

  const totals = useMemo(() => {
    const seconds = clips.reduce((sum, c) => sum + (c.duration ?? 0), 0);
    const bytes = clips.reduce((sum, c) => sum + (c.size ?? 0), 0);
    return {
      count: clips.length,
      bytes,
      footage:
        seconds < 60
          ? `${Math.round(seconds)}s`
          : `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`,
    };
  }, [clips]);

  const recording = (config?.recording ?? {}) as Record<string, unknown>;
  const version = status.version || '';

  const rows: Array<[string, string]> = [
    ['Version', version || 'unknown'],
    ['Backend', status.backend || (recording.backend as string) || 'auto'],
    ['Buffer', formatLengthLong((recording.buffer_duration as number) ?? 120)],
    ['Frame rate', `${(recording.fps as number) ?? 60} fps`],
    ['Clips on disk', `${totals.count} · ${formatBytes(totals.bytes)}`],
    ['Total footage', totals.footage],
  ];

  const copyUninstall = async () => {
    if (await copyToClipboard(UNINSTALL_CMD)) {
      notify({
        kind: 'info',
        title: 'Command copied, paste it into a terminal',
        tone: 'accent',
        holdMs: 4000,
      });
    } else {
      setManualCopy(UNINSTALL_CMD);
    }
  };

  return (
    <div className="about">
      <header className="about-head">
        <h1>About</h1>
        <p>Vice, the game clip recorder for Linux</p>
      </header>

      <section className="about-hero">
        <span className="about-mark">
          <IconMark size={30} />
        </span>
        <div>
          <h2>
            <Wordmark height={26} />
          </h2>
          <p>Linux-first, open source game clipping.</p>
          <div className="about-chips">
            <span className="about-chip mono">{version || 'unknown'}</span>
            <span className="about-chip mono">GPL-3.0</span>
            <span className="about-chip mono">Wayland and X11</span>
          </div>
        </div>
      </section>

      <div className="about-grid">
        <section className="about-card">
          <h3 className="eyebrow">System</h3>
          {rows.map(([label, value]) => (
            <div className="about-row" key={label}>
              <span>{label}</span>
              <b className="mono">{value}</b>
            </div>
          ))}
        </section>

        <section className="about-card">
          <h3 className="eyebrow">Credits</h3>
          <div className="credit">
            <span className="credit-avatar">A</span>
            <div>
              <b>Andrew Marin</b>
              <span>Creator and maintainer</span>
            </div>
          </div>
          <div className="credit">
            <span className="credit-avatar credit-avatar-dim">C</span>
            <div>
              <b>Community contributors</b>
              <span>Bug reports, translations, patches</span>
            </div>
          </div>
        </section>
      </div>

      <section className="about-danger">
        <h3 className="eyebrow">Danger zone</h3>
        <p>
          Uninstalling removes Vice, its systemd units and the udev rules. Your clips stay where
          they are.
        </p>
        <div className="about-cmd">
          <code className="mono">{UNINSTALL_CMD}</code>
          <button type="button" className="btn btn-quiet btn-sm" onClick={() => void copyUninstall()}>
            Copy
          </button>
        </div>
      </section>

      <Modal open={manualCopy !== null} title="Copy this command" onClose={() => setManualCopy(null)}>
        <p>The clipboard was not available, so here is the command to copy by hand.</p>
        <textarea className="manual-copy" readOnly value={manualCopy ?? ''} rows={2} />
      </Modal>
    </div>
  );
}

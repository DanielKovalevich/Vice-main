import {useState} from 'react';

import {api} from '../lib/api';
import {useStore} from '../state/store';
import {Modal} from '../components/Modal';
import {t} from '../lib/i18n';
import {IconCheck} from './Icons';
import {ACCENTS, ACCENT_NAMES, type AccentName} from '../theme/accents';

/**
 * The first-run quick start. Three pages. Picking an accent comes first,
 * because it retints the window underneath the modal, so the rest of the
 * tutorial is read in the colours the user just chose rather than in defaults
 * they have not agreed to yet.
 *
 * The copy carries the user's own hotkey and clip length rather than the
 * defaults, so nothing on screen is wrong for the person reading it.
 */
export function Tutorial({open, onClose}: {open: boolean; onClose: () => void}) {
  const {state, dispatch, hotkey} = useStore();
  const [page, setPage] = useState(1);
  const duration = (state.config?.recording?.clip_duration as number | undefined) ?? 20;
  const accent = state.accent;

  // Same behaviour as the Settings picker: applied at once, saved locally, and
  // pushed to the daemon so shared clips carry the colour too.
  const setAccent = (name: AccentName) => {
    dispatch({type: 'setAccent', accent: name});
    localStorage.setItem('vice-theme', name);
    void api
      .saveConfig({sharing: {embed_color: ACCENTS[name].base}})
      .catch(err => console.debug('Saving the embed colour failed', err));
  };

  const finish = () => {
    // Stored on the daemon as well as locally: the native window's
    // localStorage does not survive a restart on every QtWebEngine build,
    // which made the tutorial reappear on every launch.
    localStorage.setItem('vice_tutorial_shown', '1');
    void api.setAppState({tutorial_seen: true}).catch(err => {
      console.debug('Recording that the tutorial was seen failed', err);
    });
    setPage(1);
    onClose();
  };

  return (
    <Modal
      open={open}
      title={
        page === 1
          ? t('tutorial.pickColour')
          : page === 2
            ? t('tutorial.startClipping')
            : t('tutorial.playlistsTitle')
      }
      wide
      onClose={finish}
      footer={
        <>
          <span className="tut-dots" aria-hidden="true">
            <i data-active={page === 1 || undefined} />
            <i data-active={page === 2 || undefined} />
            <i data-active={page === 3 || undefined} />
          </span>
          {page > 1 ? (
            <button type="button" className="btn btn-quiet" onClick={() => setPage(page - 1)}>
              {t('tutorial.back')}
            </button>
          ) : null}
          {page < 3 ? (
            <button type="button" className="btn" onClick={() => setPage(page + 1)}>
              {t('tutorial.next')}
            </button>
          ) : (
            <button type="button" className="btn" onClick={finish}>
              {t('tutorial.gotIt')}
            </button>
          )}
        </>
      }>
      {page === 1 ? (
        <>
          <p>{t('tutorial.colourBody')}</p>
          <div className="tut-accents">
            {ACCENT_NAMES.map(name => (
              <button
                key={name}
                type="button"
                className="swatch swatch-lg"
                data-active={accent === name || undefined}
                style={{background: ACCENTS[name].base}}
                title={t(`accents.${name}`)}
                aria-label={t('tutorial.accentLabel', {name: t(`accents.${name}`)})}
                aria-pressed={accent === name}
                onClick={() => setAccent(name)}>
                {accent === name ? <IconCheck size={16} /> : null}
              </button>
            ))}
          </div>
        </>
      ) : page === 2 ? (
        <>
          <p>{t('tutorial.quickStartBody')}</p>
          <div className="tut-steps">
            <Step badge={hotkey} title={t('tutorial.saveLast', {duration})}>
              {t('tutorial.saveLastHelp', {hotkey})}
            </Step>
            <Step badge={`·${hotkey}·`} title={t('tutorial.sessionTitle', {hotkey})}>
              {t('tutorial.sessionHelp')}
            </Step>
            <Step badge={t('tutorial.badgeClip')} title={t('tutorial.reviewTitle')}>
              {t('tutorial.reviewHelp')}
            </Step>
            <Step badge={t('tutorial.badgeBg')} title={t('tutorial.backgroundTitle')}>
              {t('tutorial.backgroundHelp')}
            </Step>
          </div>
        </>
      ) : (
        <>
          <p>{t('tutorial.playlistsBody')}</p>
          <div className="tut-steps">
            <Step badge={t('tutorial.badgeAuto')} title={t('tutorial.autoTitle')}>
              {t('tutorial.autoHelp')}
            </Step>
            <Step badge={t('tutorial.badgeNew')} title={t('tutorial.customTitle')}>
              {t('tutorial.customHelp')}
            </Step>
            <Step badge={t('tutorial.badgeSafe')} title={t('tutorial.safeTitle')}>
              {t('tutorial.safeHelp')}
            </Step>
          </div>
        </>
      )}
    </Modal>
  );
}

function Step({
  badge,
  title,
  children,
}: {
  badge: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="tut-step">
      <span className="tut-badge mono">{badge}</span>
      <div>
        <b>{title}</b>
        <span>{children}</span>
      </div>
    </div>
  );
}

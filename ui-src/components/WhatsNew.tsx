import {useRef} from 'react';

import {Modal} from './Modal';
import {t} from '../lib/i18n';
import {notesFor, releaseKey} from '../lib/whatsNew';

/**
 * The release notes for one version: opened once on the first launch after
 * an update, and again from the sidebar whenever the user wants them.
 */
export function WhatsNew({
  version,
  open,
  onClose,
}: {
  version: string | null;
  open: boolean;
  onClose: () => void;
}) {
  // Held through the closing animation, or the window would empty itself one
  // frame before it fades.
  const last = useRef<string | null>(null);
  if (version) last.current = version;
  const shown = version ?? last.current;
  const notes = notesFor(shown ?? undefined);
  const key = shown ? releaseKey(shown) : '';
  return (
    <Modal
      open={open && notes !== null}
      title={t('whatsNew.title', {version: shown ?? ''})}
      wide
      onClose={onClose}
      footer={
        <button type="button" className="btn" onClick={onClose}>
          {t('whatsNew.close')}
        </button>
      }>
      {notes ? (
        <>
          <div className="tut-steps whats-new">
            {notes.items.map(id => (
              <div key={id} className="tut-step">
                <div>
                  <b>{t(`whatsNew.${key}.${id}.title`)}</b>
                  <span>{t(`whatsNew.${key}.${id}.body`)}</span>
                </div>
              </div>
            ))}
          </div>
          {notes.thanks?.length ? (
            <p className="tut-note">
              {t('whatsNew.thanks', {names: notes.thanks.map(name => `@${name}`).join(', ')})}
            </p>
          ) : null}
        </>
      ) : null}
    </Modal>
  );
}

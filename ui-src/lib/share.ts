import {copyToClipboard} from './clipboard';
import type {Clip} from './types';
import type {IslandEvent} from '../state/store';
import {t} from './i18n';

/**
 * Copy a clip's share link, saying plainly when the link only works on this
 * network. A LAN address looks identical to a real share link right up until
 * a friend cannot open it (#105).
 *
 * `onManualCopy` is the fallback for windows with no working clipboard: the
 * link has to be put somewhere the user can select it by hand.
 */
export async function copyShareLink(
  clip: Clip,
  notify: (event: Omit<IslandEvent, 'id'>) => void,
  onManualCopy: (url: string) => void,
): Promise<void> {
  if (!clip.share_url) {
    notify({
      kind: 'error',
      title: t('card.noShareLinkYet'),
      tone: 'error',
      holdMs: 4000,
    });
    return;
  }
  if (!(await copyToClipboard(clip.share_url))) {
    onManualCopy(clip.share_url);
    return;
  }
  if (clip.share_is_public === false) {
    notify({
      kind: 'info',
      title: t('card.linkCopiedLocal'),
      detail: t('card.linkCopiedLocalDetail'),
      tone: 'neutral',
      holdMs: 8000,
    });
  } else {
    notify({kind: 'info', title: t('card.shareLinkCopied'), tone: 'accent', holdMs: 3000});
  }
}

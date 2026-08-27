import {useCallback, useMemo, useState, type ReactNode} from 'react';

import {api} from '../lib/api';
import {copyShareLink} from '../lib/share';
import {openExternal} from '../lib/env';
import {clipTitle, type Clip} from '../lib/types';
import type {ClipActions} from '../components/ClipCard';
import {ContextMenu} from '../components/ContextMenu';
import {Modal} from '../components/Modal';
import {ClipMetadataModal} from '../components/ClipMetadataModal';
import {FireShareModal} from '../components/FireShareModal';
import {YouTubeModal} from '../components/YouTubeModal';
import {useStore} from './store';
import {usePlayback} from './playback';
import {t} from '../lib/i18n';

/**
 * A published FireShare link, preferring the live attempt but falling back to
 * the last successful one, so a clip whose newest attempt failed still offers
 * the link that works.
 */
function fireshareUrl(clip: Clip): string {
  return clip.fireshare?.current?.public_url || clip.fireshare?.last_ready?.public_url || '';
}

/**
 * Everything a clip card can do, in one place.
 *
 * Home and All Clips render the same card and are expected to behave the
 * same. Building the handler set on each screen is what let them drift the
 * first time, with Home ending up as a card that could only be opened.
 */
export function useClipActions(): {actions: ClipActions; overlays: ReactNode} {
  const {state, notify, refreshClips, refreshPlaylists} = useStore();
  const {openViewer, openTrim} = usePlayback();
  const {playlists} = state;

  const [menu, setMenu] = useState<{clip: Clip; at: {x: number; y: number}} | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Clip | null>(null);
  const [manualCopy, setManualCopy] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [configuring, setConfiguring] = useState<Clip | null>(null);
  const [publishing, setPublishing] = useState<Clip | null>(null);
  const [uploading, setUploading] = useState<Clip | null>(null);

  const fail = useCallback(
    (title: string) => (err: Error) =>
      notify({kind: 'error', title, detail: err.message, tone: 'error', holdMs: 7000}),
    [notify],
  );

  const say = useCallback(
    (title: string, detail?: string) =>
      notify({kind: 'info', title, detail, tone: 'accent', holdMs: 3500}),
    [notify],
  );

  const copyLink = useCallback(
    (clip: Clip) => void copyShareLink(clip, notify, setManualCopy),
    [notify],
  );

  const reveal = useCallback(
    (clip: Clip) => void api.revealClip(clip.slug).catch(fail(t('viewer.errReveal'))),
    [fail],
  );

  const copyFile = useCallback(
    (clip: Clip) =>
      void api
        .copyClipFile(clip.slug)
        .then(() => say(t('card.videoCopied')))
        .catch(fail(t('card.errCopyVideo'))),
    [fail, say],
  );

  const rename = useCallback(
    async (clip: Clip, name: string) => {
      try {
        const updated = await api.renameClip(clip.slug, name);
        await refreshClips();
        if (updated?.name && clipTitle(updated) !== name) {
          // Punctuation is normalised server side, so say what landed on disk.
          notify({
            kind: 'info',
            title: t('card.savedAs', {name: clipTitle(updated)}),
            tone: 'neutral',
            holdMs: 4000,
          });
        }
      } catch (err) {
        fail(t('card.renameFailed'))(err as Error);
      }
    },
    [fail, notify, refreshClips],
  );

  const copyFireshareLink = useCallback(
    (clip: Clip) => {
      const url = fireshareUrl(clip);
      if (!url) return;
      void navigator.clipboard
        ?.writeText(url)
        .then(() => say('FireShare link copied'))
        .catch(() => setManualCopy(url));
    },
    [say],
  );

  const actions = useMemo<ClipActions>(
    () => ({
      onOpen: clip => openViewer(clip.slug),
      onTrim: clip => openTrim(clip.slug),
      onCopyLink: copyLink,
      onCopyFile: copyFile,
      onReveal: reveal,
      onDelete: setConfirmDelete,
      onRename: rename,
      onContextMenu: (clip, at) => setMenu({clip, at}),
      renamingSlug: renaming,
      onRenameDone: () => setRenaming(null),
    }),
    [openViewer, openTrim, copyLink, copyFile, reveal, rename, renaming],
  );

  const menuClip = menu?.clip;
  const overlays = (
    <>
      {menu && menuClip ? (
        <ContextMenu
          at={menu.at}
          heading={clipTitle(menuClip)}
          emptyLabel={t('common.noActions')}
          onClose={() => setMenu(null)}
          items={[
            {id: 'open', label: t('card.open'), onSelect: () => openViewer(menuClip.slug)},
            {id: 'trim', label: t('card.trim'), onSelect: () => openTrim(menuClip.slug)},
            {id: 'rename', label: t('card.rename'), onSelect: () => setRenaming(menuClip.slug)},
            {
              id: 'copy-link',
              label: menuClip.share_url ? t('card.copyShareLink') : t('card.noShareLink'),
              disabled: !menuClip.share_url,
              onSelect: () => copyLink(menuClip),
            },
            {id: 'copy-file', label: t('card.copyVideoShort'), onSelect: () => copyFile(menuClip)},
            {id: 'reveal', label: t('card.reveal'), onSelect: () => reveal(menuClip)},
            {id: 'sep-fork', separator: true},
            {
              id: 'fireshare-publish',
              label: 'Publish to FireShare',
              onSelect: () => setPublishing(menuClip),
            },
            {
              id: 'youtube-upload',
              label: 'Upload to YouTube',
              onSelect: () => setUploading(menuClip),
            },
            {
              id: 'configure',
              label: 'Configure clip',
              onSelect: () => setConfiguring(menuClip),
            },
            ...(fireshareUrl(menuClip)
              ? [
                  {
                    id: 'copy-fireshare',
                    label: 'Copy FireShare link',
                    onSelect: () => copyFireshareLink(menuClip),
                  },
                  {
                    id: 'open-fireshare',
                    label: 'Open in FireShare',
                    onSelect: () => openExternal(fireshareUrl(menuClip)),
                  },
                ]
              : []),
            ...(playlists.length ? [{id: 'sep-playlists', separator: true} as const] : []),
            // One row per playlist that toggles, so adding and removing are
            // the same gesture in the same place.
            ...playlists.map(playlist => {
              const inIt = playlist.clip_slugs?.includes(menuClip.slug) ?? false;
              return {
                id: playlist.id,
                label: inIt
                  ? t('card.removeFrom', {playlist: playlist.name})
                  : t('card.addTo', {playlist: playlist.name}),
                mark: inIt ? '✓' : (playlist.emoji ?? undefined),
                onSelect: () => {
                  const call = inIt
                    ? api.removeClipFromPlaylist(playlist.id, menuClip.slug)
                    : api.addClipToPlaylist(playlist.id, menuClip.slug);
                  void call
                    .then(async result => {
                      if (result?.ok === false) {
                        throw new Error(result.error || t('card.playlistUnchanged'));
                      }
                      await refreshPlaylists();
                      say(
                        inIt
                          ? t('card.removedFrom', {playlist: playlist.name})
                          : t('card.addedTo', {playlist: playlist.name}),
                      );
                    })
                    .catch(fail(t('clips.errUpdatePlaylist')));
                },
              };
            }),
            {id: 'sep-delete', separator: true},
            {
              id: 'delete',
              label: t('card.deleteClip'),
              danger: true,
              onSelect: () => setConfirmDelete(menuClip),
            },
          ]}
        />
      ) : null}

      <Modal
        open={confirmDelete !== null}
        title={t('viewer.confirmDeleteTitle')}
        onClose={() => setConfirmDelete(null)}
        footer={
          <>
            <button type="button" className="btn btn-quiet" onClick={() => setConfirmDelete(null)}>
              {t('common.keepIt')}
            </button>
            <button
              type="button"
              className="btn btn-danger-solid"
              onClick={() => {
                const clip = confirmDelete;
                setConfirmDelete(null);
                if (!clip) return;
                void api
                  .deleteClip(clip.slug)
                  .then(() => say(t('viewer.clipDeleted')))
                  .catch(fail(t('viewer.errDelete')));
              }}>
              {t('common.delete')}
            </button>
          </>
        }>
        <p>
          {t('viewer.confirmDeleteBody', {
            name: confirmDelete ? clipTitle(confirmDelete) : '',
          })}
        </p>
      </Modal>

      <Modal open={manualCopy !== null} title={t('viewer.copyLinkTitle')} onClose={() => setManualCopy(null)}>
        <p>{t('viewer.copyLinkBody')}</p>
        <textarea className="manual-copy" readOnly value={manualCopy ?? ''} rows={3} />
      </Modal>

      <ClipMetadataModal clip={configuring} onClose={() => setConfiguring(null)} />
      <FireShareModal clip={publishing} onClose={() => setPublishing(null)} />
      <YouTubeModal clip={uploading} onClose={() => setUploading(null)} />
    </>
  );

  return {actions, overlays};
}

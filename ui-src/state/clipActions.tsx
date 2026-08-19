import {useCallback, useMemo, useState, type ReactNode} from 'react';

import {api} from '../lib/api';
import {copyShareLink} from '../lib/share';
import {clipTitle, type Clip} from '../lib/types';
import type {ClipActions} from '../components/ClipCard';
import {ContextMenu} from '../components/ContextMenu';
import {Modal} from '../components/Modal';
import {useStore} from './store';
import {usePlayback} from './playback';

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
    (clip: Clip) => void api.revealClip(clip.slug).catch(fail('Could not open the file manager')),
    [fail],
  );

  const copyFile = useCallback(
    (clip: Clip) =>
      void api
        .copyClipFile(clip.slug)
        .then(() => say('Video copied, paste it anywhere'))
        .catch(fail('Could not copy the video')),
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
            title: `Saved as ${clipTitle(updated)}`,
            tone: 'neutral',
            holdMs: 4000,
          });
        }
      } catch (err) {
        fail('Rename failed')(err as Error);
      }
    },
    [fail, notify, refreshClips],
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
          emptyLabel="No actions"
          onClose={() => setMenu(null)}
          items={[
            {id: 'open', label: 'Open', onSelect: () => openViewer(menuClip.slug)},
            {id: 'trim', label: 'Trim', onSelect: () => openTrim(menuClip.slug)},
            {id: 'rename', label: 'Rename', onSelect: () => setRenaming(menuClip.slug)},
            {
              id: 'copy-link',
              label: menuClip.share_url ? 'Copy share link' : 'No share link yet',
              disabled: !menuClip.share_url,
              onSelect: () => copyLink(menuClip),
            },
            {id: 'copy-file', label: 'Copy video', onSelect: () => copyFile(menuClip)},
            {id: 'reveal', label: 'Reveal in file manager', onSelect: () => reveal(menuClip)},
            ...(playlists.length ? [{id: 'sep-playlists', separator: true} as const] : []),
            // One row per playlist that toggles, so adding and removing are
            // the same gesture in the same place.
            ...playlists.map(playlist => {
              const inIt = playlist.clip_slugs?.includes(menuClip.slug) ?? false;
              return {
                id: playlist.id,
                label: `${inIt ? 'Remove from' : 'Add to'} ${playlist.name}`,
                mark: inIt ? '✓' : (playlist.emoji ?? undefined),
                onSelect: () => {
                  const call = inIt
                    ? api.removeClipFromPlaylist(playlist.id, menuClip.slug)
                    : api.addClipToPlaylist(playlist.id, menuClip.slug);
                  void call
                    .then(async result => {
                      if (result?.ok === false) {
                        throw new Error(result.error || 'The playlist did not change');
                      }
                      await refreshPlaylists();
                      say(`${inIt ? 'Removed from' : 'Added to'} ${playlist.name}`);
                    })
                    .catch(fail('Could not update the playlist'));
                },
              };
            }),
            {id: 'sep-delete', separator: true},
            {
              id: 'delete',
              label: 'Delete clip',
              danger: true,
              onSelect: () => setConfirmDelete(menuClip),
            },
          ]}
        />
      ) : null}

      <Modal
        open={confirmDelete !== null}
        title="Delete this clip?"
        onClose={() => setConfirmDelete(null)}
        footer={
          <>
            <button type="button" className="btn btn-quiet" onClick={() => setConfirmDelete(null)}>
              Keep it
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
                  .then(() => say('Clip deleted'))
                  .catch(fail('Could not delete the clip'));
              }}>
              Delete
            </button>
          </>
        }>
        <p>
          {confirmDelete ? clipTitle(confirmDelete) : ''} will be removed from disk. This cannot be
          undone.
        </p>
      </Modal>

      <Modal open={manualCopy !== null} title="Copy this link" onClose={() => setManualCopy(null)}>
        <p>The clipboard was not available, so here is the link to copy by hand.</p>
        <textarea className="manual-copy" readOnly value={manualCopy ?? ''} rows={3} />
      </Modal>
    </>
  );

  return {actions, overlays};
}

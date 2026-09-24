import {useCallback, useEffect, useRef, useState} from 'react';

import {api} from './api';
import {clipTitle, imageSlug, imageTitle, type Clip, type Image, type Playlist} from './types';
import {t} from './i18n';

/**
 * Dragging a clip onto a playlist, shared by the sidebar rows and the tiles on
 * Home so the two cannot drift apart.
 */

/** How long the target holds its caught state after a successful drop. */
const CAUGHT_MS = 600;

let ghost: HTMLElement | null = null;

/**
 * Hand the drag a small pill instead of the card.
 *
 * Without setDragImage the browser drags a snapshot of the whole card, which
 * at 230px covers whatever you are aiming at. The editor's library has always
 * done this; the same element and the same class are used here.
 */
export function startClipDrag(event: React.DragEvent, clip: Clip): void {
  beginDrag(event, clip.slug, clipTitle(clip), clip.thumb_url);
}

/**
 * The same gesture for a screenshot. The prefixed slug is what travels, so the
 * drop target and the daemon both see the membership key they already expect
 * and no target had to learn what an image is.
 */
export function startImageDrag(event: React.DragEvent, image: Image): void {
  beginDrag(event, imageSlug(image.slug), imageTitle(image), image.thumb_url ?? image.image_url);
}

function beginDrag(event: React.DragEvent, slug: string, label: string, thumb?: string): void {
  event.dataTransfer.effectAllowed = 'copy';
  event.dataTransfer.setData('text/plain', slug);

  clearGhost();
  const el = document.createElement('div');
  el.className = 'clip-drag-ghost';
  if (thumb) {
    const img = document.createElement('img');
    img.src = thumb;
    img.alt = '';
    el.appendChild(img);
  }
  const name = document.createElement('span');
  name.className = 'clip-drag-ghost-name';
  name.textContent = label;
  el.appendChild(name);
  document.body.appendChild(el);
  ghost = el;
  event.dataTransfer.setDragImage(el, 24, 20);
}

export function endClipDrag(): void {
  clearGhost();
}

function clearGhost() {
  ghost?.remove();
  ghost = null;
}

export interface DropTarget {
  /** Spread onto the element that accepts the clip. */
  props: {
    onDragOver: (e: React.DragEvent) => void;
    onDragLeave: () => void;
    onDrop: (e: React.DragEvent) => void;
  };
  /** A clip is hovering over this target right now. */
  over: boolean;
  /** This target just caught a clip, for the length of the animation. */
  caught: boolean;
}

/**
 * Accept clips dropped onto a playlist.
 *
 * A clip already in the playlist is a no-op rather than an error: the drop
 * looks like it worked because as far as the user wanted, it did.
 */
export function usePlaylistDropTarget(
  playlist: Playlist,
  onDone: (message: string, tone: 'accent' | 'error') => void,
): DropTarget {
  const [over, setOver] = useState(false);
  const [caught, setCaught] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const celebrate = useCallback(() => {
    setCaught(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCaught(false), CAUGHT_MS);
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setOver(false);
      const slug = e.dataTransfer.getData('text/plain');
      if (!slug) return;
      if (playlist.clip_slugs?.includes(slug)) {
        celebrate();
        onDone(t('card.alreadyIn', {playlist: playlist.name}), 'accent');
        return;
      }
      void api
        .addClipToPlaylist(playlist.id, slug)
        .then(result => {
          if (result.ok === false) throw new Error(result.error || t('card.errAddClip'));
          celebrate();
          onDone(t('card.addedTo', {playlist: playlist.name}), 'accent');
        })
        .catch((err: Error) => onDone(err.message, 'error'));
    },
    [playlist.id, playlist.name, playlist.clip_slugs, celebrate, onDone],
  );

  return {
    over,
    caught,
    props: {
      onDragOver: e => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        setOver(true);
      },
      onDragLeave: () => setOver(false),
      onDrop,
    },
  };
}

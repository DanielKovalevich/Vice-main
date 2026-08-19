import {useEffect, useState, type RefObject} from 'react';

import {H264_SUPPORTED, HEVC_SUPPORTED} from './env';
import type {Clip} from './types';

/**
 * True when a clip is H.265 and this engine cannot decode it, so playback has
 * to go through the daemon's H.264 preview proxy.
 */
export function clipNeedsProxy(clip: Clip | null | undefined): boolean {
  const codec = (clip?.vcodec ?? '').toLowerCase();
  return (codec === 'hevc' || codec === 'h265') && !HEVC_SUPPORTED;
}

/**
 * What to feed a video element for a clip: the file itself, or the proxy when
 * the codec cannot play in this window. `video_url` already carries a content
 * revision, so it doubles as a cache key.
 */
export function playbackUrl(clip: Clip | null | undefined): string {
  if (!clip?.video_url) return '';
  return clipNeedsProxy(clip) ? `${clip.video_url}&proxy=1` : clip.video_url;
}

/** Frame-accurate enough for a scrub, and cheap on engines that offer it. */
export function seekTo(video: HTMLVideoElement | null, seconds: number): void {
  if (!video) return;
  const target = Math.max(0, Number(seconds) || 0);
  try {
    if (typeof video.fastSeek === 'function') video.fastSeek(target);
    else video.currentTime = target;
  } catch {
    video.currentTime = target;
  }
}

/** Play without treating an interrupted promise as an error worth reporting. */
export function playQuietly(video: HTMLVideoElement | null): void {
  void video?.play().catch(() => {});
}

/** hh:mm:ss.mmm, the timecode format the trim readout uses. */
export function timecode(seconds: number): string {
  const s = Math.max(0, Number(seconds) || 0);
  const pad = (n: number) => String(Math.floor(n)).padStart(2, '0');
  const ms = String(Math.round((s % 1) * 1000)).padStart(3, '0');
  return `${pad(s / 3600)}:${pad((s % 3600) / 60)}:${pad(s % 60)}.${ms}`;
}

export function videoFailureMessage(): string {
  return H264_SUPPORTED
    ? 'Vice could not play this clip in the app window. The file itself is most likely fine.'
    : 'This Qt WebEngine build has no H.264 decoder, so clips cannot play inside Vice. The file itself is fine.';
}

/**
 * Watch a video element for the two shapes playback failure takes.
 *
 * A broken file fires `error`. A WebEngine build missing the codec does not:
 * the audio track plays normally and the video track is dropped in silence,
 * leaving videoWidth at 0. Every Vice clip has a video track, so a zero width
 * after load is a failure (#79). Clearing src on close also fires `error`,
 * which is not one.
 */
export function useVideoFailure(ref: RefObject<HTMLVideoElement | null>): boolean {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    const hasSource = () => Boolean(video.getAttribute('src'));
    const onError = () => hasSource() && setFailed(true);
    const onLoadedData = () => hasSource() && setFailed(video.videoWidth === 0);
    const onLoadStart = () => hasSource() && setFailed(false);
    video.addEventListener('error', onError);
    video.addEventListener('loadeddata', onLoadedData);
    video.addEventListener('loadstart', onLoadStart);
    return () => {
      video.removeEventListener('error', onError);
      video.removeEventListener('loadeddata', onLoadedData);
      video.removeEventListener('loadstart', onLoadStart);
    };
  }, [ref]);

  return failed;
}

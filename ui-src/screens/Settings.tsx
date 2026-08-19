import {useCallback, useEffect, useMemo, useRef, useState} from 'react';

import {api} from '../lib/api';
import {formatLengthLong} from '../lib/format';
import {
  EFFECTS_MODES,
  applyEffects,
  effectsNote,
  isEffectsMode,
  subscribeEffects,
  type EffectsMode,
} from '../lib/effects';
import {
  RESOLUTION_PRESETS,
  SOUND_FIELDS,
  bufferNote,
  draftFromConfig,
  newClipPreset,
  patchFromDraft,
  renderClipName,
  requiredBuffer,
  resolvedResolution,
  type ClipPreset,
  type Draft,
} from '../lib/settingsDraft';
import {ACCENTS, ACCENT_NAMES, type AccentName} from '../theme/accents';
import {useStore} from '../state/store';
import {Modal} from '../components/Modal';
import {IconCheck, IconClose} from '../components/Icons';
import {AudioTracks, type AudioSource} from '../components/settings/AudioTracks';
import {KeyCapture} from '../components/settings/KeyCapture';
import {
  Row,
  Select,
  Slider,
  SoundGrid,
  TextArea,
  TextField,
  Toggle,
  type RowNote,
} from '../components/settings/Fields';

const SECTIONS = [
  ['recording', 'Recording'],
  ['audio', 'Audio'],
  ['hotkeys', 'Hotkeys'],
  ['storage', 'Storage'],
  ['sharing', 'Sharing'],
  ['discord', 'Discord'],
  ['appearance', 'Appearance'],
  ['advanced', 'Advanced'],
] as const;

type SectionId = (typeof SECTIONS)[number][0];

interface DisplayInfo {
  displays: Array<{id: string; label?: string}>;
  warning?: string | null;
  follow_mouse_supported?: boolean;
}

export function Settings() {
  const {state, dispatch, saveConfig, notify} = useStore();
  const {config, accent, status} = state;

  const [draft, setDraft] = useState<Draft | null>(null);
  const [baseline, setBaseline] = useState<string>('');
  const [displays, setDisplays] = useState<DisplayInfo>({displays: [], warning: null});
  const [sources, setSources] = useState<{sources: AudioSource[]; warning?: string | null}>({
    sources: [],
  });
  const [trackPick, setTrackPick] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [section, setSection] = useState<SectionId>('recording');
  const [restartNeeded, setRestartNeeded] = useState(false);
  const [wfMicPrompt, setWfMicPrompt] = useState(false);
  const [effects, setEffects] = useState<EffectsMode>('auto');
  const [, forceEffectsNote] = useState(0);
  const [checkingUpdate, setCheckingUpdate] = useState(false);

  const bodyRef = useRef<HTMLDivElement>(null);
  const sectionRefs = useRef(new Map<SectionId, HTMLElement>());
  // Set while the rail is scrolling somewhere, so scroll-spy does not fight it.
  const scrollingTo = useRef<SectionId | null>(null);

  const update = useCallback(
    (patch: Partial<Draft>) => setDraft(prev => (prev ? {...prev, ...patch} : prev)),
    [],
  );

  // The draft is seeded once. Later config merges (a mic toggle from Home, for
  // instance) must not wipe edits in progress, so the reseed is keyed on the
  // config arriving rather than on it changing.
  useEffect(() => {
    if (!config || draft) return;
    const next = draftFromConfig(config);
    setDraft(next);
    setBaseline(JSON.stringify(patchFromDraft(next)));
  }, [config, draft]);

  useEffect(() => {
    void api
      .getAppState()
      .then(s => {
        const mode = isEffectsMode(s.effects_mode) ? s.effects_mode : 'auto';
        setEffects(mode);
        applyEffects(mode);
      })
      .catch(() => applyEffects('auto'));
    return subscribeEffects(() => forceEffectsNote(n => n + 1));
  }, []);

  const loadDisplays = useCallback(async (backend: string) => {
    try {
      const info = await api.displays(backend || 'auto');
      setDisplays(info as unknown as DisplayInfo);
    } catch {
      setDisplays({displays: [], warning: 'Could not load display options.'});
    }
  }, []);

  const loadSources = useCallback(async () => {
    try {
      const info = await api.audioSources();
      setSources(info as unknown as {sources: AudioSource[]; warning?: string | null});
      setTrackPick(prev => prev || (info.sources as AudioSource[])[0]?.id || '');
    } catch {
      setSources({
        sources: [{id: 'default_output', label: 'Default output'}],
        warning: 'Could not load audio sources.',
      });
    }
  }, []);

  useEffect(() => {
    if (!draft) return;
    void loadDisplays(draft.backend);
    // Only the backend changes what is enumerable, so this does not rerun on
    // every keystroke elsewhere in the form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft?.backend, loadDisplays]);

  useEffect(() => {
    void loadSources();
  }, [loadSources]);

  // Scroll-spy: whichever section heading is nearest the top of the scroller
  // owns the rail. The old rail only ever highlighted what you last clicked.
  useEffect(() => {
    const scroller = bodyRef.current;
    if (!scroller || !draft) return;
    const onScroll = () => {
      if (scrollingTo.current) return;
      const top = scroller.getBoundingClientRect().top + 96;
      let current: SectionId = SECTIONS[0][0];
      for (const [id] of SECTIONS) {
        const node = sectionRefs.current.get(id);
        if (node && node.getBoundingClientRect().top <= top) current = id;
      }
      setSection(current);
    };
    scroller.addEventListener('scroll', onScroll, {passive: true});
    onScroll();
    return () => scroller.removeEventListener('scroll', onScroll);
  }, [draft]);

  const goTo = (id: SectionId) => {
    setSection(id);
    scrollingTo.current = id;
    sectionRefs.current.get(id)?.scrollIntoView({behavior: 'smooth', block: 'start'});
    window.setTimeout(() => {
      scrollingTo.current = null;
    }, 600);
  };

  const dirty = useMemo(
    () => (draft ? JSON.stringify(patchFromDraft(draft)) !== baseline : false),
    [draft, baseline],
  );

  // Leaving with unsaved changes is the one way this screen can lose work.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  if (!draft) {
    return (
      <div className="settings">
        <p className="home-empty">Loading your settings.</p>
      </div>
    );
  }

  const fail = (title: string, err: unknown) =>
    notify({
      kind: 'error',
      title,
      detail: (err as Error)?.message,
      tone: 'error',
      holdMs: 7000,
    });

  const say = (title: string, detail?: string) =>
    notify({kind: 'info', title, detail, tone: 'accent', holdMs: 3500});

  /** Persist one field on the spot, for the controls Home also owns. */
  const persistNow = async (
    patch: Record<string, Record<string, unknown>>,
    onOk: () => void,
    failure: string,
  ) => {
    try {
      const result = await saveConfig(patch);
      if (result.applied === false && result.warning) {
        notify({
          kind: 'error',
          title: 'Saved, but not applied',
          detail: result.warning,
          tone: 'error',
          holdMs: 8000,
        });
      } else {
        onOk();
      }
      // The baseline moves with it, or the save bar would report a change the
      // daemon already has.
      setBaseline(prev => {
        const merged = {...JSON.parse(prev)} as Record<string, Record<string, unknown>>;
        for (const [group, values] of Object.entries(patch)) {
          merged[group] = {...(merged[group] ?? {}), ...values};
        }
        return JSON.stringify(merged);
      });
    } catch (err) {
      fail(failure, err);
    }
  };

  const micNeedsWfChoice =
    !draft.captureMic &&
    draft.captureAudio &&
    draft.wfMicStrategy === 'prompt' &&
    (draft.backend === 'wf-recorder' || status.backend === 'wf-recorder');

  const setMic = async (enabled: boolean, strategy?: string) => {
    update({captureMic: enabled, ...(strategy ? {wfMicStrategy: strategy} : {})});
    await persistNow(
      {recording: {capture_microphone: enabled, ...(strategy ? {wf_microphone_strategy: strategy} : {})}},
      () => say(enabled ? 'Microphone on' : 'Microphone off', enabled ? 'Included in new clips' : 'Removed from new clips'),
      'Could not change the microphone setting',
    );
  };

  const save = async () => {
    if (resolvedResolution(draft) === false) {
      notify({
        kind: 'error',
        title: 'That resolution is not a size',
        detail: 'Write it as width by height, like 1600x900',
        tone: 'error',
        holdMs: 6000,
      });
      goTo('recording');
      return;
    }

    // The buffer cannot be shorter than the longest clip a key can save. Show
    // the correction rather than performing it behind the user's back.
    const buffer = requiredBuffer(draft);
    const corrected = buffer !== draft.bufferDuration;
    if (corrected) update({bufferDuration: buffer});

    const patch = patchFromDraft({...draft, bufferDuration: buffer});
    const sharingChanged =
      Number(patch.sharing.port) !== Number(config?.sharing?.port ?? 8765) ||
      Boolean(patch.sharing.cloudflare_tunnel) !== Boolean(config?.sharing?.cloudflare_tunnel !== false);

    setSaving(true);
    try {
      const result = await saveConfig(patch);
      if (result.applied === false && result.warning) {
        notify({
          kind: 'error',
          title: 'Saved, but not applied',
          detail: result.warning,
          tone: 'error',
          holdMs: 9000,
        });
      } else {
        say(
          'Settings saved',
          corrected ? `Buffer raised to ${formatLengthLong(buffer)} to cover your longest clip key` : undefined,
        );
      }
      if (result.restart_required && sharingChanged) setRestartNeeded(true);
      setBaseline(JSON.stringify(patch));
    } catch (err) {
      fail('Could not save your settings', err);
    } finally {
      setSaving(false);
    }
  };

  const revert = () => {
    if (!config) return;
    const next = draftFromConfig(config);
    setDraft(next);
    setBaseline(JSON.stringify(patchFromDraft(next)));
  };

  const setAccent = (name: AccentName) => {
    dispatch({type: 'setAccent', accent: name});
    localStorage.setItem('vice-theme', name);
    // Share-page embeds carry the same accent, so the Discord strip on a
    // shared clip matches the app it came from.
    void api
      .saveConfig({sharing: {embed_color: ACCENTS[name].base}})
      .catch(err => console.debug('Saving the embed colour failed', err));
  };

  const setEffectsMode = (mode: EffectsMode) => {
    setEffects(mode);
    applyEffects(mode);
    void api
      .setAppState({effects_mode: mode})
      .catch(err => console.debug('Saving the effects mode failed', err));
  };

  const register = (id: SectionId) => (node: HTMLElement | null) => {
    if (node) sectionRefs.current.set(id, node);
    else sectionRefs.current.delete(id);
  };

  const buffer = bufferNote(draft);
  const followSupported = displays.follow_mouse_supported !== false;

  return (
    <div className="settings">
      <header className="settings-head">
        <div>
          <h1>Settings</h1>
          <p>Tune Vice to the way you play</p>
        </div>
      </header>

      <nav className="settings-rail" aria-label="Settings sections">
        {SECTIONS.map(([id, label]) => (
          <button
            key={id}
            type="button"
            className="rail-chip"
            aria-current={section === id ? 'true' : undefined}
            onClick={() => goTo(id)}>
            {label}
          </button>
        ))}
      </nav>

      <div className="settings-body" ref={bodyRef}>
        {/* ── Recording ─────────────────────────────────────────── */}
        <Card id="recording" title="Recording" register={register('recording')}>
          <Row label="Buffer duration" note={buffer}>
            <Slider
              label="Buffer duration"
              value={draft.bufferDuration}
              min={30}
              max={1800}
              step={30}
              onChange={bufferDuration => update({bufferDuration})}
              format={formatLengthLong}
            />
          </Row>

          <Row
            label="Replay storage"
            help="Where the rolling buffer lives. Auto keeps short buffers in RAM and moves anything over ten minutes to disk.">
            <Select
              label="Replay storage"
              value={draft.replayStorage}
              onChange={replayStorage => update({replayStorage})}
              options={[
                ['auto', 'Auto (recommended)'],
                ['ram', 'RAM'],
                ['disk', 'Disk'],
              ]}
            />
          </Row>

          <Row label="Clip duration" help="Seconds saved when you press the clip key">
            <Slider
              label="Clip duration"
              value={draft.clipDuration}
              min={5}
              max={1800}
              step={5}
              onChange={clipDuration => update({clipDuration})}
              format={formatLengthLong}
            />
          </Row>

          <Row label="Frame rate" help="Capture frames per second">
            <Select
              label="Frame rate"
              value={draft.fps}
              onChange={fps => update({fps})}
              options={['24', '30', '50', '60', '120', '144'].map(v => [v, `${v} fps`] as [string, string])}
            />
          </Row>

          <Row label="Resolution" help="Auto matches your display">
            <Select
              label="Resolution"
              value={draft.resolution}
              onChange={resolution => update({resolution})}
              options={[...RESOLUTION_PRESETS.map(([v, t]) => [v, t] as [string, string]), ['custom', 'Custom']]}
            />
          </Row>

          {draft.resolution === 'custom' ? (
            <Row
              label="Custom resolution"
              note={
                resolvedResolution(draft) === false
                  ? {text: 'Write it as width by height, like 1600x900.', tone: 'warning' as const}
                  : null
              }
              help="Width by height, for example 1600x900">
              <TextField
                label="Custom resolution"
                mono
                value={draft.customResolution}
                placeholder="1600x900"
                onChange={customResolution => update({customResolution})}
              />
            </Row>
          ) : null}

          <Row
            label="Container"
            help="MKV survives crashes better and suits multi-track audio. Discord embeds and browsers need MP4.">
            <Select
              label="Container"
              value={draft.container}
              onChange={container => update({container})}
              options={[
                ['mp4', 'MP4 (best compatibility)'],
                ['mkv', 'MKV (crash-safe)'],
              ]}
            />
          </Row>

          <Row label="Video encoder" help="GPU encoders are faster and use less CPU">
            <Select
              label="Video encoder"
              value={draft.encoder}
              onChange={encoder => update({encoder})}
              options={[
                ['auto', 'Auto (recommended)'],
                ['h264_nvenc', 'NVIDIA H.264 (NVENC)'],
                ['hevc_nvenc', 'NVIDIA H.265 (NVENC)'],
                ['h264_vaapi', 'AMD or Intel H.264 (VAAPI)'],
                ['hevc_vaapi', 'AMD or Intel H.265 (VAAPI)'],
                ['av1_nvenc', 'NVIDIA AV1 (NVENC, RTX 40 and up)'],
                ['av1_vaapi', 'AMD or Intel AV1 (VAAPI)'],
                ['libx264', 'Software H.264 (x264)'],
                ['libx265', 'Software H.265 (x265)'],
              ]}
            />
          </Row>

          <Row
            label="Colour depth"
            help="8-bit suits every player. 10-bit needs an HEVC or AV1 encoder.">
            <Select
              label="Colour depth"
              value={draft.colorDepth}
              onChange={colorDepth => update({colorDepth})}
              options={[
                ['8', '8-bit (standard)'],
                ['10', '10-bit (HEVC or AV1)'],
              ]}
            />
          </Row>

          <Row
            label="Hardware video decode in previews"
            help="Let your GPU decode clips in this window instead of the CPU. Worth turning on if high-resolution AV1 or HEVC previews stutter. It renders video black on some drivers, so if that happens turn it back off. Takes effect next time you open Vice.">
            <Toggle
              label="Hardware video decode in previews"
              checked={draft.hardwareDecode}
              onChange={hardwareDecode => update({hardwareDecode})}
            />
          </Row>

          <Row label="Recording backend" help="Screen capture method">
            <Select
              label="Recording backend"
              value={draft.backend}
              onChange={backend => update({backend})}
              options={[
                ['auto', 'Auto (recommended)'],
                ['gsr', 'gpu-screen-recorder'],
                ['wf-recorder', 'wf-recorder (Wayland)'],
                ['ffmpeg', 'ffmpeg (X11)'],
              ]}
            />
          </Row>

          <Row
            label="Follow my mouse"
            note={
              followSupported
                ? null
                : {
                    text: 'Needs X11, Hyprland or Sway. Vice cannot tell where the pointer is on this session.',
                    tone: 'warning' as const,
                  }
            }
            help="Record whichever monitor the pointer is on. Switching monitors restarts the buffer, so a clip taken right after moving will be short.">
            <Toggle
              label="Follow my mouse"
              checked={followSupported && draft.followMouse}
              disabled={!followSupported}
              onChange={followMouse => update({followMouse})}
            />
          </Row>

          <Row label="Display" note={displayNote(draft, displays)}>
            <Select
              label="Display"
              value={draft.display}
              disabled={draft.followMouse && followSupported}
              onChange={display => update({display})}
              options={displayOptions(draft, displays)}
            />
          </Row>
        </Card>

        {/* ── Audio ─────────────────────────────────────────────── */}
        <Card id="audio" title="Audio" register={register('audio')}>
          <Row label="Capture desktop audio" help="Include system sound in clips">
            <Toggle
              label="Capture desktop audio"
              checked={draft.captureAudio}
              onChange={captureAudio => update({captureAudio})}
            />
          </Row>

          <Row
            label="Capture microphone"
            help="Record your mic into clips. The same switch as the tile on Home, and saved the moment you flip it.">
            <Toggle
              label="Capture microphone"
              checked={draft.captureMic}
              onChange={next => {
                if (next && micNeedsWfChoice) setWfMicPrompt(true);
                else void setMic(next);
              }}
            />
          </Row>

          <Row label="Desktop audio source" note={desktopSourceNote(draft, sources)}>
            <Select
              label="Desktop audio source"
              value={draft.desktopSource}
              onChange={desktopSource => update({desktopSource})}
              options={groupedSourceOptions(draft.desktopSource, sources.sources)}
            />
          </Row>

          <Row
            label="Microphone source"
            help="Used when mic capture is on. Default input follows the system setting.">
            <Select
              label="Microphone source"
              value={draft.micSource}
              onChange={micSource => update({micSource})}
              options={micSourceOptions(draft.micSource, sources.sources)}
            />
          </Row>

          <Row
            label="Mono microphone"
            help="Centres your mic in the clip. Turn this on if your voice only comes out of one ear, which is what most XLR and single-channel interfaces do. Applied when the clip is saved, so it needs mic capture on and no separate audio tracks.">
            <Toggle
              label="Mono microphone"
              checked={draft.micMono}
              onChange={micMono => update({micMono})}
            />
          </Row>

          {/* Separate tracks keep their own levels, so the balance sliders
              would be claiming an effect they do not have. */}
          {draft.audioTracks.length === 0 ? (
            <>
              <Row label="Desktop audio volume" help="Balanced into new clips as they are saved">
                <Slider
                  label="Desktop audio volume"
                  value={draft.desktopVolume}
                  min={0}
                  max={200}
                  step={5}
                  onChange={desktopVolume => update({desktopVolume})}
                  format={v => `${v}%`}
                />
              </Row>
              <Row
                label="Microphone volume"
                help="Turn this down if your mic overpowers the game. Applies while mic capture is on.">
                <Slider
                  label="Microphone volume"
                  value={draft.micVolume}
                  min={0}
                  max={200}
                  step={5}
                  onChange={micVolume => update({micVolume})}
                  format={v => `${v}%`}
                />
              </Row>
            </>
          ) : null}

          <Row
            label="Notification volume"
            help="The ping when a clip is saved, and the session start, stop and highlight tones.">
            <Slider
              label="Notification volume"
              value={draft.notifyVolume}
              min={0}
              max={100}
              step={5}
              onChange={notifyVolume => update({notifyVolume})}
              format={v => (v > 0 ? `${v}%` : 'Off')}
            />
          </Row>

          <Row
            label="Custom sounds"
            stack
            help="Play your own file instead of the built-in tone. Leave blank for the tone. A path that does not exist falls back to the tone, so you never end up with silence.">
            <SoundGrid
              fields={SOUND_FIELDS}
              values={draft.sounds}
              onChange={(key, value) => update({sounds: {...draft.sounds, [key]: value}})}
            />
          </Row>

          <Row
            label="Separate audio tracks"
            stack
            help="Each source becomes its own track for editing. Players, Discord and share links use track 1. With mic capture on, your microphone gets its own track.">
            <AudioTracks
              tracks={draft.audioTracks}
              sources={sources.sources}
              mixFirst={draft.mixFirstTrack}
              desktopAudioOn={draft.captureAudio}
              pick={trackPick}
              onPickChange={setTrackPick}
              onChange={audioTracks => update({audioTracks})}
              refreshing={refreshing}
              onDuplicate={() =>
                notify({
                  kind: 'error',
                  title: 'That source is already a track',
                  tone: 'error',
                  holdMs: 3500,
                })
              }
              onRefresh={() => {
                setRefreshing(true);
                void loadSources()
                  .then(() => say('Audio sources refreshed'))
                  .finally(() => setRefreshing(false));
              }}
            />
          </Row>

          <Row
            label="Combined first track"
            help="Record an extra track 1 that mixes every source, so players and shared clips carry full audio. Your separate tracks start at 2.">
            <Toggle
              label="Combined first track"
              checked={draft.mixFirstTrack}
              onChange={mixFirstTrack => update({mixFirstTrack})}
            />
          </Row>

          <Row
            label="wf-recorder microphone mode"
            help="How wf-recorder handles desktop audio together with a microphone">
            <Select
              label="wf-recorder microphone mode"
              value={draft.wfMicStrategy}
              onChange={wfMicStrategy => update({wfMicStrategy})}
              options={[
                ['prompt', 'Ask when needed'],
                ['backend_fallback', 'Use a compatible backend'],
                ['mic_only', 'Mic only on wf-recorder'],
              ]}
            />
          </Row>
        </Card>

        {/* ── Hotkeys ───────────────────────────────────────────── */}
        <Card id="hotkeys" title="Hotkeys" register={register('hotkeys')}>
          <Row
            label="Clip key"
            note={
              status.hotkeys_available === false
                ? {
                    text: 'Vice cannot read your keyboard right now, so no hotkey will fire. Adding your user to the input group and logging back in usually fixes it.',
                    tone: 'warning' as const,
                  }
                : null
            }
            help="Click to rebind, then press a key or a combo like Alt+F9. Escape cancels. Saved the moment you press it.">
            <KeyCapture
              value={draft.clipKey}
              onUnsupported={() =>
                notify({kind: 'error', title: 'That key cannot be bound, try another', tone: 'error', holdMs: 4000})
              }
              onCapture={clipKey => {
                update({clipKey});
                void persistNow(
                  {hotkeys: {clip: clipKey}},
                  () => say(`Clip key is now ${clipKey}`),
                  'The key was captured but not saved',
                );
              }}
            />
          </Row>

          <Row
            label="Additional clip hotkeys"
            stack
            help="Each key saves its own clip length. Double-tap any clip key to start or stop a session.">
            <ClipPresets
              presets={draft.clipPresets}
              onChange={clipPresets => update({clipPresets})}
              onUnsupported={() =>
                notify({kind: 'error', title: 'That key cannot be bound, try another', tone: 'error', holdMs: 4000})
              }
            />
          </Row>

          <Row
            label="Ignore hotkeys in these apps"
            stack
            help="One per line. Vice leaves its keys alone while a matching app is focused, for games that clip on the same keys. Matched against the window process and class, for example ggst.exe. Needs X11, Hyprland or Sway.">
            <TextArea
              label="Ignore hotkeys in these apps"
              value={draft.hotkeyBlocklist}
              placeholder="ggst.exe"
              onChange={hotkeyBlocklist => update({hotkeyBlocklist})}
            />
          </Row>
        </Card>

        {/* ── Storage ───────────────────────────────────────────── */}
        <Card id="storage" title="Storage" register={register('storage')}>
          <Row label="Save clips to" help="Directory where clips are written">
            <TextField
              label="Save clips to"
              wide
              value={draft.directory}
              placeholder="~/Videos/Vice"
              onChange={directory => update({directory})}
            />
          </Row>

          <Row
            label="Tag clips with the game"
            help="Append the detected game to clip filenames, like Vice_Clip_4_Overwatch-2.mp4. Uses the same game list as Rich Presence and the auto playlists.">
            <Toggle
              label="Tag clips with the game"
              checked={draft.tagWithGame}
              onChange={tagWithGame => update({tagWithGame})}
            />
          </Row>

          <Row
            label="Create a playlist per game"
            help="When a known game is focused, file the clip into an auto playlist for it with its own colour.">
            <Toggle
              label="Create a playlist per game"
              checked={draft.autoPlaylist}
              onChange={autoPlaylist => update({autoPlaylist})}
            />
          </Row>

          <Row
            label="Clip filename"
            note={clipNameNote(draft)}
            help={
              <>
                Leave empty for the default Vice_Clip_4 naming. Use <code>$n</code> for the clip
                number, <code>$date</code>, <code>$time</code>, and <code>$game</code> (needs the
                toggle above). Clips are never overwritten.
              </>
            }>
            <TextField
              label="Clip filename"
              wide
              mono
              value={draft.clipNameTemplate}
              placeholder="clip_$date_$time"
              onChange={clipNameTemplate => update({clipNameTemplate})}
            />
          </Row>
        </Card>

        {/* ── Sharing ───────────────────────────────────────────── */}
        <Card id="sharing" title="Sharing" register={register('sharing')}>
          <Row label="HTTP port" help="Port for the local share server">
            <TextField
              label="HTTP port"
              mono
              type="number"
              min={1024}
              max={65535}
              value={draft.port}
              onChange={port => update({port: Number(port) || 0})}
            />
          </Row>

          <Row
            label="Public link"
            help="Share links that work outside your own network. Needs the cloudflared binary installed, otherwise links only work on your network.">
            <Toggle
              label="Public link"
              checked={draft.cloudflareTunnel}
              onChange={cloudflareTunnel => update({cloudflareTunnel})}
            />
          </Row>
        </Card>

        {/* ── Discord ───────────────────────────────────────────── */}
        <Card id="discord" title="Discord Rich Presence" register={register('discord')}>
          <Row
            label="Show what you are playing"
            help="Puts &quot;Clipping &lt;Game&gt; with Vice&quot; on your Discord profile while a known game is focused. On by default, and window titles are never sent.">
            <Toggle
              label="Show what you are playing"
              checked={draft.discordEnabled}
              onChange={discordEnabled => update({discordEnabled})}
            />
          </Row>

          <Row
            label="Custom games"
            stack
            help={
              <>
                One game per line: <code>Display Name | match1, match2</code>. Matches are
                case-insensitive substrings checked against the focused window&apos;s process name
                and class. The bundled list already covers over 300 games.
              </>
            }>
            <TextArea
              label="Custom games"
              rows={4}
              value={draft.discordCustomGames}
              placeholder="My Game | mygame.exe, MyGameClient"
              onChange={discordCustomGames => update({discordCustomGames})}
            />
          </Row>

          <Row
            label="Client ID override"
            help="Optional. Leave empty to use Vice's own Discord application, or provide your own Application ID for custom branding.">
            <TextField
              label="Client ID override"
              wide
              mono
              value={draft.discordClientId}
              placeholder="Discord Application ID"
              onChange={discordClientId => update({discordClientId})}
            />
          </Row>
        </Card>

        {/* ── Appearance ────────────────────────────────────────── */}
        <Card id="appearance" title="Appearance" register={register('appearance')}>
          <Row
            label="Accent colour"
            help="Tints the controls, the highlights and the ambient wash behind the app. Saved straight away, and shared clips pick it up too.">
            <div className="swatches">
              {ACCENT_NAMES.map(name => (
                <button
                  key={name}
                  type="button"
                  className="swatch"
                  data-active={accent === name || undefined}
                  style={{background: ACCENTS[name].base}}
                  title={name[0].toUpperCase() + name.slice(1)}
                  aria-label={`${name} accent`}
                  aria-pressed={accent === name}
                  onClick={() => setAccent(name)}>
                  {accent === name ? <IconCheck size={13} /> : null}
                </button>
              ))}
            </div>
          </Row>

          <Row
            label="Visual effects"
            note={effectsNote(effects) ? {text: effectsNote(effects)} : null}
            help="Motion and depth cost a GPU. Auto measures how fast frames arrive in this window and turns them down when it cannot keep up.">
            <Select
              label="Visual effects"
              value={effects}
              onChange={mode => setEffectsMode(mode as EffectsMode)}
              options={EFFECTS_MODES.map(m => [m, m[0].toUpperCase() + m.slice(1)] as [string, string])}
            />
          </Row>
        </Card>

        {/* ── Advanced ──────────────────────────────────────────── */}
        <Card id="advanced" title="Advanced" register={register('advanced')}>
          <Row
            label="Extra gpu-screen-recorder arguments"
            stack
            help={
              <>
                Appended to the recorder command as written. Example:{' '}
                <code>-k hevc -bm cbr -q 20000 -fm cfr</code>
              </>
            }>
            <TextField
              label="Extra gpu-screen-recorder arguments"
              wide
              mono
              value={draft.gsrArgs}
              placeholder="-k hevc -bm cbr -q 20000 -fm cfr"
              onChange={gsrArgs => update({gsrArgs})}
            />
          </Row>

          <Row
            label="Check for updates"
            help="Ask GitHub once a day whether a newer Vice is out. Nothing about you or your clips is sent.">
            <Toggle
              label="Check for updates"
              checked={draft.checkForUpdates}
              onChange={checkForUpdates => update({checkForUpdates})}
            />
          </Row>

          <Row label="Check now" help="Look straight away, ignoring the daily wait.">
            <button
              type="button"
              className="btn btn-quiet btn-sm"
              disabled={checkingUpdate}
              onClick={() => {
                setCheckingUpdate(true);
                void api
                  .checkUpdate()
                  .then(result => {
                    const info = result as {update?: {version?: string} | null};
                    say(
                      info?.update?.version
                        ? `Vice ${info.update.version} is available`
                        : 'You are on the latest release',
                    );
                  })
                  .catch(err => fail('Could not reach GitHub', err))
                  .finally(() => setCheckingUpdate(false));
              }}>
              {checkingUpdate ? 'Checking' : 'Check now'}
            </button>
          </Row>
        </Card>
      </div>

      <div className="save-bar" data-dirty={dirty || undefined}>
        <span className="save-state">
          {dirty ? (
            'Unsaved changes'
          ) : (
            <>
              <IconCheck size={13} /> Everything saved
            </>
          )}
        </span>
        <button type="button" className="btn btn-quiet btn-sm" onClick={revert} disabled={!dirty || saving}>
          Discard
        </button>
        <button type="button" className="btn btn-sm" onClick={() => void save()} disabled={!dirty || saving}>
          {saving ? 'Saving' : 'Save settings'}
        </button>
      </div>

      <Modal
        open={wfMicPrompt}
        title="How should the microphone be mixed in?"
        onClose={() => setWfMicPrompt(false)}>
        <p>
          wf-recorder records one audio source at a time. Choose what happens when both the desktop
          and the microphone are on.
        </p>
        <div className="choice-list">
          <button
            type="button"
            className="choice"
            onClick={() => {
              setWfMicPrompt(false);
              void setMic(true, 'backend_fallback');
            }}>
            <b>Use a backend that can do both</b>
            <span>Vice records with a compatible backend whenever the microphone is on.</span>
          </button>
          <button
            type="button"
            className="choice"
            onClick={() => {
              setWfMicPrompt(false);
              void setMic(true, 'mic_only');
            }}>
            <b>Microphone only</b>
            <span>Desktop audio is dropped while the microphone is on.</span>
          </button>
        </div>
      </Modal>

      <Modal
        open={restartNeeded}
        title="Restart Vice to finish"
        onClose={() => setRestartNeeded(false)}
        footer={
          <button type="button" className="btn" onClick={() => setRestartNeeded(false)}>
            Got it
          </button>
        }>
        <p>
          The sharing settings are saved, but the server only picks up a new port or tunnel setting
          when the daemon restarts.
        </p>
      </Modal>
    </div>
  );
}

function Card({
  id,
  title,
  register,
  children,
}: {
  id: string;
  title: string;
  register: (node: HTMLElement | null) => void;
  children: React.ReactNode;
}) {
  return (
    <section className="settings-card" id={`settings-${id}`} ref={register} aria-label={title}>
      <h2>{title}</h2>
      {children}
    </section>
  );
}

function ClipPresets({
  presets,
  onChange,
  onUnsupported,
}: {
  presets: ClipPreset[];
  onChange: (next: ClipPreset[]) => void;
  onUnsupported: () => void;
}) {
  const patch = (uid: string, values: Partial<ClipPreset>) =>
    onChange(presets.map(p => (p.uid === uid ? {...p, ...values} : p)));

  return (
    <div className="presets">
      {presets.map(preset => (
        <div className="preset-row" key={preset.uid}>
          <KeyCapture
            compact
            value={preset.key}
            onUnsupported={onUnsupported}
            onCapture={key => patch(preset.uid, {key})}
          />
          <input
            className="text-input preset-duration"
            type="number"
            min={5}
            max={600}
            step={5}
            value={preset.duration}
            aria-label="Clip length for this key"
            onChange={e => patch(preset.uid, {duration: Number(e.target.value)})}
          />
          <span className="preset-unit mono">s</span>
          <button
            type="button"
            className="preset-remove"
            title="Remove this hotkey"
            aria-label="Remove this hotkey"
            onClick={() => onChange(presets.filter(p => p.uid !== preset.uid))}>
            <IconClose size={12} />
          </button>
        </div>
      ))}
      <button
        type="button"
        className="btn btn-quiet btn-sm"
        onClick={() => onChange([...presets, newClipPreset()])}>
        Add hotkey
      </button>
    </div>
  );
}

/**
 * A saved value the backend is not listing right now is still a saved value.
 * Dropping it to Auto here wrote display=null on the next save and destroyed a
 * monitor set by hand, which is the only way to reach one gpu-screen-recorder
 * will not enumerate (#160). The audio pickers below do the same.
 */
function displayOptions(draft: Draft, info: DisplayInfo): Array<[string, string]> {
  const listed = usableDisplays(info);
  const options: Array<[string, string]> = [
    ['', 'Auto (backend default)'],
    ...listed.map(d => [d.id, d.label || d.id] as [string, string]),
  ];
  if (draft.display && !listed.some(d => d.id === draft.display)) {
    options.push([draft.display, `${draft.display} (saved)`]);
  }
  return options;
}

function displayNote(draft: Draft, info: DisplayInfo): RowNote {
  const listed = usableDisplays(info);
  if (draft.display && !listed.some(d => d.id === draft.display)) {
    return {
      text: `Display "${draft.display}" is not being reported right now. It is still saved and will be used if it comes back.`,
      tone: 'warning',
    };
  }
  if (info.warning) return {text: `${info.warning} Auto will still work.`, tone: 'warning'};
  if (!listed.length) {
    return {text: 'No individual displays were detected. Auto will still work.', tone: 'warning'};
  }
  return {text: 'Choose which display to record. Auto follows the backend default.'};
}

/**
 * Defence in depth: drop anything whose id or label reads like a recorder
 * diagnostic. The backend filters these already, but a new error format
 * slipping through should show "no displays" rather than an option that
 * breaks recording when picked.
 */
function usableDisplays(info: DisplayInfo) {
  const looksLikeError = (value: string | undefined) => {
    const v = String(value || '').toLowerCase();
    return (
      v.startsWith('gsr error') ||
      v.startsWith('error:') ||
      v.includes('for_each_active_monitor') ||
      v.includes('failed to open')
    );
  };
  return (info.displays ?? []).filter(d => !(looksLikeError(d.id) || looksLikeError(d.label)));
}

function sourceKind(source: AudioSource): string {
  if (source.kind) return source.kind;
  const id = source.id || '';
  if (id === 'default_input' || (id.startsWith('device:') && !id.endsWith('.monitor'))) return 'input';
  if (id.startsWith('app:') || id.startsWith('app-inverse:')) return 'app';
  return 'monitor';
}

function groupedSourceOptions(selected: string, sources: AudioSource[]) {
  const list = sources.length ? sources : [{id: 'default_output', label: 'Default output'}];
  const groups: Array<{group: string; options: Array<[string, string]>}> = [];
  const kinds: Array<[string, string]> = [
    ['monitor', 'Desktop audio'],
    ['input', 'Microphones'],
    ['app', 'Applications'],
  ];
  for (const [kind, label] of kinds) {
    const members = list.filter(s => sourceKind(s) === kind);
    if (members.length) {
      groups.push({group: label, options: members.map(s => [s.id, s.label || s.id])});
    }
  }
  const known = new Set(kinds.map(([kind]) => kind));
  const rest = list.filter(s => !known.has(sourceKind(s)));
  if (rest.length) groups.push({group: 'Other', options: rest.map(s => [s.id, s.label || s.id])});
  if (selected && !list.some(s => s.id === selected)) {
    groups.push({group: 'Saved', options: [[selected, `${selected} (saved)`]]});
  }
  return groups;
}

function micSourceOptions(selected: string, sources: AudioSource[]): Array<[string, string]> {
  const inputs = sources.filter(s => sourceKind(s) === 'input');
  if (!inputs.some(s => s.id === 'default_input')) {
    inputs.unshift({id: 'default_input', label: 'Default input'});
  }
  const options = inputs.map(s => [s.id, s.label || s.id] as [string, string]);
  if (selected && !inputs.some(s => s.id === selected)) {
    options.push([selected, `${selected} (saved)`]);
  }
  return options;
}

function desktopSourceNote(
  draft: Draft,
  info: {sources: AudioSource[]; warning?: string | null},
): RowNote {
  const source = info.sources.find(s => s.id === draft.desktopSource);
  if (source && sourceKind(source) === 'input') {
    return {
      text: 'This is a microphone input, so clips would have no desktop audio. Pick one under Desktop audio instead.',
      tone: 'warning',
    };
  }
  if (draft.desktopSource && info.sources.length && !source) {
    return {
      text:
        info.warning ||
        'That source is not listed right now. It is still saved and will be passed to the recorder.',
      tone: 'warning',
    };
  }
  return {text: 'Choose what the recorder captures as desktop audio.'};
}

function clipNameNote(draft: Draft): RowNote | null {
  const template = draft.clipNameTemplate.trim();
  if (!template) return null;
  const name = renderClipName(template, 4, 'Overwatch-2', new Date());
  return name
    ? {text: `Next clip: ${name}.mp4`, tone: 'accent'}
    : {text: 'That template renders to nothing, so the default naming will be used.', tone: 'warning'};
}

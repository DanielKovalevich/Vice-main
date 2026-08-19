/** Fixed vocabulary of the editor: transitions, fonts and text presets. */

export const ED_FX = [
  {
    id: 'crossfade',
    name: 'Crossfade',
    desc: 'Blend outgoing into incoming',
    len: 1.0,
    glyph:
      '<rect x="3" y="8" width="11" height="11" rx="2"/><rect x="10" y="5" width="11" height="11" rx="2" opacity=".5"/>',
  },
  {
    id: 'fadeblack',
    name: 'Fade to black',
    desc: 'Dip through pure black',
    len: 0.8,
    glyph:
      '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M12 5h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-7z" fill="currentColor" stroke="none" opacity=".8"/>',
  },
  {
    id: 'fadewhite',
    name: 'Fade to white',
    desc: 'Bloom through white',
    len: 0.8,
    glyph:
      '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M12 5h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-7z" fill="currentColor" stroke="none" opacity=".3"/>',
  },
  {
    id: 'dipaccent',
    name: 'Dip to accent',
    desc: 'Flash the theme colour',
    len: 0.7,
    glyph:
      '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="12" cy="12" r="3.5" fill="currentColor" stroke="none"/>',
  },
  {
    id: 'blurdis',
    name: 'Blur dissolve',
    desc: 'Defocus across the cut',
    len: 1.2,
    glyph: '<circle cx="9" cy="12" r="5"/><circle cx="15" cy="12" r="5" opacity=".5"/>',
  },
  {
    id: 'slide',
    name: 'Slide',
    desc: 'Incoming pushes in from the right',
    len: 0.8,
    glyph:
      '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M8 12h7"/><path d="m12 9 3 3-3 3"/>',
  },
] as const;

/**
 * The editor's own font picker, which is a user-facing text tool rather than
 * UI chrome. All three ship as local woff2 alongside the interface font.
 */
export const ED_FONTS: Record<string, {label: string; stack: string}> = {
  display: {label: 'Geist', stack: "'Geist', sans-serif"},
  body: {label: 'Inter', stack: "'Inter', sans-serif"},
  mono: {label: 'JetBrains Mono', stack: "'JetBrains Mono', monospace"},
};

export const ED_TEXT_PRESETS = [
  {id: 'title', name: 'Title', font: 'display', size: 64, weight: 600, color: '#f2f5fa', sample: 'Match point', x: 50, y: 44},
  {id: 'subtitle', name: 'Subtitle', font: 'body', size: 34, weight: 500, color: '#dbe1ea', sample: 'Ranked grind', x: 50, y: 58},
  {id: 'caption', name: 'Caption', font: 'mono', size: 22, weight: 400, color: '#b8c0cd', sample: '1920x1080 · 60 fps', x: 50, y: 88},
  {id: 'lower', name: 'Lower third', font: 'display', size: 40, weight: 600, color: '#f2f5fa', sample: 'Player · support', x: 22, y: 84},
] as const;

export const ED_SWATCHES = ['#f2f5fa', '#33adff', '#c4b5fd', '#6ee7b7', '#fdba74'] as const;

export const ED_LIB_HINTS: Record<string, string> = {
  library: 'Drag a clip onto the timeline, or double-click to append',
  effects: 'Drag an effect onto a clip, or between two clips',
  text: 'Drag a title onto the preview or the T1 lane',
};

export const edFx = (id: string) => ED_FX.find(f => f.id === id);

export function edGlyph(paths: string, size = 14): string {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
}

export const ED_ICONS = {
  film: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M7 3v18"/><path d="M3 7.5h4"/><path d="M3 12h18"/><path d="M3 16.5h4"/><path d="M17 3v18"/><path d="M17 7.5h4"/><path d="M17 16.5h4"/>',
  type: '<polyline points="4 7 4 4 20 4 20 7"/><line x1="9" x2="15" y1="20" y2="20"/><line x1="12" x2="12" y1="4" y2="20"/>',
  volumeX: '<path d="M11 5 6 9H2v6h4l5 4z"/><line x1="22" x2="16" y1="9" y2="15"/><line x1="16" x2="22" y1="9" y2="15"/>',
};

/** The transport readout: m:ss.t, tenths, because the editor is frame-ish. */
export function edFmt(t: number): string {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  const d = Math.floor((t % 1) * 10);
  return `${m}:${String(s).padStart(2, '0')}.${d}`;
}

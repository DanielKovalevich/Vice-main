// Built by tools/verify-custom-accent.mjs. Not part of the app bundle.
import {deriveAccent} from '../../ui-src/theme/deriveAccent';

const SEEDS = {
  blue: '#0099ff',
  purple: '#8b5cf6',
  green: '#10b981',
  red: '#ef4444',
  orange: '#f97316',
};
// The generator's one hand-picked tone. Everything else takes the default.
const TONE: Record<string, number> = {blue: 74};

const out: Record<string, unknown> = {};
for (const [name, seed] of Object.entries(SEEDS)) out[name] = deriveAccent(seed, TONE[name]);

// A spread of hues plus the awkward ones. None may produce a scheme that fails
// its own checks, because a user can pick any of them.
const PROBES = [
  '#000000', '#ffffff', '#808080', '#123456', '#ff0000', '#00ff00', '#0000ff',
  '#ffff00', '#00ffff', '#ff00ff', '#7c3aed', '#0a0a2e', '#8b0000', '#013220', '#2b1700',
];
out.__probes = Object.fromEntries(PROBES.map(s => [s, deriveAccent(s)]));

console.log(JSON.stringify(out));

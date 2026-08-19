/**
 * Behaviour of the UI's pure logic, exercised directly.
 *
 * These are the parts that fail quietly rather than loudly: an event guard
 * that lets a stale message through shows up as a progress bar walking
 * backwards, and a resolution rule that disagrees with the daemon shows up as
 * a refused export. Neither is something a type checker can see.
 *
 * Run through tests/test_ui_logic.py, which transpiles the modules first.
 */

import {applyPublishEvent, emptyPublishView, isTerminal} from './fireshare.js';
import {elapsedLabel, pickConnector, renderTitleTemplate} from './youtube.js';
import {filterByType, groupClips, normalizeGroupBy, normalizeTypeFilter} from './clipGrouping.js';
import {
  formatFps,
  inferExportGame,
  normalizeFps,
  normalizeResolution,
  presetResolutions,
  resolutionFromValue,
  shareAspect,
  sourceFps,
  sourceGames,
} from './editorExport.js';

let pass = 0;
const failures = [];
const check = (name, cond) => {
  if (cond) pass++;
  else failures.push(name);
};

/* ── FireShare publish-event guard ──────────────────────────────── */

const A = 'attempt-1';
check(
  'an event for another attempt is dropped',
  applyPublishEvent(emptyPublishView(), {attempt_id: 'other', seq: 5, progress_pct: 50}, A, -1) === null,
);
check(
  'nothing applies before an attempt exists',
  applyPublishEvent(emptyPublishView(), {attempt_id: A, seq: 1}, null, -1) === null,
);

const first = applyPublishEvent(
  emptyPublishView(),
  {attempt_id: A, seq: 1, state: 'uploading', progress_pct: 10},
  A,
  -1,
);
check('the first tick applies', first !== null && first.view.progress === 10 && first.seq === 1);
check(
  'a repeated seq is dropped',
  applyPublishEvent(first.view, {attempt_id: A, seq: 1, progress_pct: 5}, A, first.seq) === null,
);
check(
  'an older seq is dropped',
  applyPublishEvent(first.view, {attempt_id: A, seq: 0, progress_pct: 1}, A, first.seq) === null,
);

const later = applyPublishEvent(first.view, {attempt_id: A, seq: 7, progress_pct: 60}, A, first.seq);
check('a newer seq applies', later !== null && later.view.progress === 60);

const ready = applyPublishEvent(
  later.view,
  {attempt_id: A, seq: 8, state: 'ready', public_url: 'http://example/x'},
  A,
  later.seq,
);
check('ready pins progress to 100', ready.view.progress === 100);
check('ready keeps the public url', ready.view.publicUrl === 'http://example/x');
check(
  'a late tick cannot undo a terminal state',
  applyPublishEvent(
    ready.view,
    {attempt_id: A, seq: 6, state: 'uploading', progress_pct: 40},
    A,
    ready.seq,
  ) === null,
);

const noProgress = applyPublishEvent(
  {state: 'uploading', progress: 42, publicUrl: '', error: ''},
  {attempt_id: A, seq: 20, state: 'processing'},
  A,
  10,
);
check('a message without progress leaves the bar alone', noProgress.view.progress === 42);

const failed = applyPublishEvent(
  noProgress.view,
  {attempt_id: A, seq: 21, state: 'failed', error_message: 'boom'},
  A,
  noProgress.seq,
);
check('an error message carries through', failed.view.error === 'boom');
check(
  'terminal states are recognised',
  isTerminal('ready') && isTerminal('failed') && isTerminal('canceled') && isTerminal('stale'),
);
check(
  'in-flight states are not terminal',
  !isTerminal('uploading') && !isTerminal('processing') && !isTerminal('idle'),
);

/* ── YouTube helpers ────────────────────────────────────────────── */

const clip = {
  name: 'Clutch_Round.mp4',
  game: 'Counter-Strike 2',
  created_at: '2026-08-19T14:05:00',
};
check('$filename drops the extension', renderTitleTemplate('$filename', clip) === 'Clutch_Round');
check(
  '$game expands',
  renderTitleTemplate('$game - $filename', clip) === 'Counter-Strike 2 - Clutch_Round',
);
check('$date expands', renderTitleTemplate('$date', clip) === '2026-08-19');
check('$time expands', renderTitleTemplate('$time', clip) === '1405');
check('an empty template falls back to the filename', renderTitleTemplate('', clip) === 'Clutch_Round');
check(
  'a null game leaves an empty string, not the text null',
  renderTitleTemplate('$game', {...clip, game: null}) === '',
);
check('newlines are collapsed, since a title is one line', renderTitleTemplate('a\nb', clip) === 'a b');
check(
  'an unreadable date yields nothing rather than NaN',
  renderTitleTemplate('$date$time', {...clip, created_at: 'not a date'}) === '',
);

check(
  'elapsed time formats as mm:ss',
  elapsedLabel('2026-08-19T14:00:00Z', Date.parse('2026-08-19T14:01:05Z')) === '1:05',
);
check(
  'elapsed seconds are padded',
  elapsedLabel('2026-08-19T14:00:00Z', Date.parse('2026-08-19T14:00:07Z')) === '0:07',
);
check(
  'elapsed never runs negative when clocks disagree',
  elapsedLabel('2026-08-19T14:00:00Z', Date.parse('2026-08-19T13:59:00Z')) === '0:00',
);
check('elapsed copes with no start time', elapsedLabel(undefined, Date.now()) === '0:00');

const connectors = [
  {id: 'a', name: 'CS2'},
  {id: 'b', name: 'Rocket League'},
];
check('the last used connector wins', pickConnector(connectors, 'b', 'CS2').id === 'b');
check(
  'otherwise one named after the game wins',
  pickConnector(connectors, '', 'rocket league').id === 'b',
);
check('otherwise the first is used', pickConnector(connectors, '', 'Halo').id === 'a');
check('no connectors gives null', pickConnector([], '', 'CS2') === null);

/* ── clip grouping ──────────────────────────────────────────────── */

const mk = (slug, game, origin, created) => ({slug, game, origin, created_at: created});
const now = Date.parse('2026-08-19T12:00:00');
const clips = [
  mk('a', 'CS2', 'raw', '2026-08-19T09:00:00'),
  mk('b', null, 'edited', '2026-08-18T09:00:00'),
  mk('c', 'Rocket League', 'raw', '2026-01-01T09:00:00'),
];

check('the raw filter keeps only raw clips', filterByType(clips, 'raw').length === 2);
check('the edited filter keeps only edited clips', filterByType(clips, 'edited').length === 1);
check('the all filter keeps everything', filterByType(clips, 'all').length === 3);

const byGame = groupClips(clips, 'game', now);
check('untagged sorts last however it collates', byGame[byGame.length - 1].label === 'Untagged');
check(
  'named games sort alphabetically',
  byGame[0].label === 'CS2' && byGame[1].label === 'Rocket League',
);

const byDate = groupClips(clips, 'date', now);
// 2026-01-01 to 2026-08-19 is about 230 days, so it is Past year, not Older.
check(
  'date buckets run newest to oldest',
  byDate.map(g => g.label).join('|') === 'Today|Past week|Past year',
);
check(
  'more than a year old falls into Older',
  groupClips([mk('old', null, 'raw', '2024-01-01T09:00:00')], 'date', now)[0].label === 'Older',
);
check(
  'no grouping gives one unlabelled group',
  groupClips(clips, 'none', now).length === 1 && groupClips(clips, 'none', now)[0].label === '',
);
check(
  'an unreadable date lands in its own bucket',
  groupClips([mk('x', null, 'raw', 'nope')], 'date', now)[0].label === 'Unknown date',
);
check('the legacy value "time" means date', normalizeGroupBy('time') === 'date');
check('an unknown grouping is rejected', normalizeGroupBy('sideways') === null);
check('an unknown filter is rejected', normalizeTypeFilter('purple') === null);

/* ── editor export, which must agree with vice/editor.py ────────── */

check(
  'a normal resolution passes',
  JSON.stringify(normalizeResolution({width: 1920, height: 1080})) === '{"width":1920,"height":1080}',
);
check('odd sides are rejected rather than nudged', normalizeResolution({width: 1921, height: 1080}) === null);
check('below the minimum is rejected', normalizeResolution({width: 32, height: 32}) === null);
check('above the maximum is rejected', normalizeResolution({width: 8000, height: 100}) === null);
check('a non-integer is rejected', normalizeResolution({width: 1920.5, height: 1080}) === null);
check('over the pixel budget is rejected', normalizeResolution({width: 7680, height: 4322}) === null);
check('a non-object is rejected', normalizeResolution('1920x1080') === null);

check('a frame rate in range passes', normalizeFps(59.94) === 59.94);
check('a frame rate is rounded to three places', normalizeFps(23.9761234) === 23.976);
check('below the minimum frame rate is rejected', normalizeFps(0.5) === null);
check('above the maximum frame rate is rejected', normalizeFps(241) === null);
check('a boolean frame rate is rejected, as the daemon does', normalizeFps(true) === null);
check('a non-numeric frame rate is rejected', normalizeFps('sixty') === null);

check('identical aspects match', shareAspect({width: 1920, height: 1080}, {width: 1280, height: 720}));
check(
  'different aspects do not match',
  !shareAspect({width: 1920, height: 1080}, {width: 1920, height: 1200}),
);
check(
  'the tolerance the daemon allows holds',
  shareAspect({width: 1998, height: 1080}, {width: 1920, height: 1038}),
);

const wide = presetResolutions({width: 1920, height: 1080});
check(
  'a 16:9 canvas is offered 4K down to 720p',
  wide.map(r => `${r.width}x${r.height}`).join(',') === '3840x2160,2560x1440,1920x1080,1280x720',
);
const tall = presetResolutions({width: 1080, height: 1920});
check('a vertical canvas is offered vertical sizes', tall.length > 0 && tall.every(r => r.height > r.width));
check(
  'every preset keeps the canvas aspect',
  tall.every(r => shareAspect({width: 1080, height: 1920}, r)),
);
check('every preset is even sided', [...wide, ...tall].every(r => r.width % 2 === 0 && r.height % 2 === 0));
check('no canvas means no presets', presetResolutions(null).length === 0);

check('a resolution string parses', resolutionFromValue('1920x1080').width === 1920);
check('a times sign is accepted', resolutionFromValue('1920\u00d71080').height === 1080);
check('an odd resolution string is rejected', resolutionFromValue('1921x1080') === null);
check('nonsense is rejected', resolutionFromValue('big') === null);

check('a fractional frame rate keeps its decimals', formatFps(59.94) === '59.94');
check('a whole frame rate has no trailing zeros', formatFps(60) === '60');

check('source frame rate takes the highest', sourceFps([{fps: 30}, {fps: 60}, {fps: 24}]) === 60);
check('an out of range source frame rate is ignored', sourceFps([{fps: 0}, {fps: 5000}]) === 60);

check(
  'source games are distinct and sorted',
  sourceGames([{game: 'Rocket League'}, {game: 'CS2'}, {game: 'CS2'}]).join(',') === 'CS2,Rocket League',
);
check('one game is used directly', inferExportGame([{game: 'CS2'}, {game: 'CS2'}]) === 'CS2');
check(
  'disagreeing games become Multiple games',
  inferExportGame([{game: 'CS2'}, {game: 'Halo'}]) === 'Multiple games',
);
check('no games gives an empty tag', inferExportGame([{game: null}]) === '');

/* ── report ─────────────────────────────────────────────────────── */

if (failures.length) {
  console.log(`FAILED ${failures.length} of ${pass + failures.length}`);
  failures.forEach(name => console.log(`  ${name}`));
  process.exit(1);
}
console.log(`OK ${pass}`);

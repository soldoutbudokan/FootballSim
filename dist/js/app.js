import { Simulation, STEP, GOAL } from './sim.js';
import { PLAYS, formationFor, RECEIVERS, ROUTE_COLORS, COVERAGES, HOT_ROUTES } from './plays.js';
import { FieldScene } from './scene.js';
import { AdaptiveGraphics, PROFILES } from './graphics.js';
import { FieldAudio } from './audio.js';

// FootballSim front end: title menu, broadcast HUD, dialogs and the game loop.
// The simulation runs at a fixed 120 Hz step; rendering is throttled separately.

const $ = id => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

const PREFS_KEY = 'footballsim.preferences.v1';
const CAMERAS = [
  { id: 'game', label: 'Game camera' },
  { id: 'broadcast', label: 'Broadcast' },
  { id: 'all22', label: 'All-22' },
];
const LIGHTING = [
  { id: 'day', label: 'Afternoon' },
  { id: 'sunset', label: 'Golden hour' },
  { id: 'night', label: 'Under the lights' },
];
const PASS_STYLES = ['timing', 'bullet', 'touch', 'lob'];
// Keep tap/hold selection, meter fill and its tick marks on the same scale.
const PASS_CHARGE = { touch: 0.12, bullet: 0.24, full: 0.30 };
const DOWN_NAMES = ['', '1ST', '2ND', '3RD', '4TH'];
// Gamepad buttons that pass to receivers 1-5 after the snap: A, X, Y, B, RB.
const PASS_BUTTONS = [0, 2, 3, 1, 5];
const BAD_RESULTS = ['interception', 'sack', 'safety'];

// ---------- Preferences ----------
const storage = {
  read() { try { return JSON.parse(localStorage.getItem(PREFS_KEY)) || {}; } catch { return {}; } },
  write(value) { try { localStorage.setItem(PREFS_KEY, JSON.stringify(value)); } catch { /* storage unavailable */ } },
};

function loadPrefs() {
  const prefs = { graphics: 'auto', lighting: 'day', camera: 'game', passStyle: 'timing', fieldStrip: false, ...storage.read() };
  // Older versions saved 'wide' and 'qb' camera ids; anything unknown falls back to the game camera.
  if (!CAMERAS.some(c => c.id === prefs.camera)) prefs.camera = 'game';
  if (!LIGHTING.some(l => l.id === prefs.lighting)) prefs.lighting = 'day';
  if (!PASS_STYLES.includes(prefs.passStyle)) prefs.passStyle = 'timing';
  if (prefs.graphics !== 'auto' && !PROFILES.some(profile => profile.id === prefs.graphics)) prefs.graphics = 'auto';
  prefs.fieldStrip = prefs.fieldStrip === true;
  return prefs;
}

const prefs = loadPrefs();
const savePrefs = () => storage.write(prefs);
const sim = new Simulation();
const audio = new FieldAudio();
const isTouch = matchMedia('(pointer: coarse)').matches;
const debug = new URLSearchParams(location.search).has('debug');
document.body.classList.toggle('touch-active', isTouch);

// ---------- Session state ----------
let view, graphics;
let inMenu = true, paused = false, started = false, showArt = true;
let replay = null, charge = null, frameId = 0;
let activeDialog = null, dialogReturn = null;
let toastTimer = 0, playFilter = 'all', hotReceiver = 0, menuIndex = 0, padStickLatch = 0;
let audiblePage = 0;
const AUDIBLES_PER_PAGE = 8;
const keys = new Set();
const touch = { x: 0, z: 0, sprint: false };
const padMove = { x: 0, z: 0, sprint: false };
let padButtons = [];
let last = performance.now(), lastRender = last, nextRender = 0, accumulator = 0;
let uiElapsed = 0, fpsElapsed = 0, fpsFrames = 0, fps = 0;

const markers = {};
const targetButtons = [];
const menuItems = [...document.querySelectorAll('.menu-item')];

// ---------- Small helpers ----------
function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

function fieldPosition(z) {
  const yard = Math.round(z - 10);
  return yard < 50 ? 'OWN ' + yard : yard === 50 ? 'MIDFIELD' : 'OPP ' + (100 - yard);
}

function downAndDistance() {
  const goal = sim.spot + sim.toGo >= GOAL;
  return DOWN_NAMES[sim.down] + ' & ' + (goal ? 'GOAL' : sim.toGo);
}

// The HUD refreshes ten times a second; writing only changed values keeps style and paint work near zero.
function setText(id, value) {
  const el = $(id);
  if (el.textContent !== value) el.textContent = value;
}

function setHidden(id, hidden) {
  const el = $(id);
  if (el.hidden !== hidden) el.hidden = hidden;
}

function cameraLabel(id) { return CAMERAS.find(c => c.id === id)?.label || CAMERAS[0].label; }

function fillOptions(select, options) {
  select.replaceChildren(...options.map(({ id, label }) => new Option(label, id)));
}

function button(className, html, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = className;
  b.innerHTML = html;
  if (onClick) b.addEventListener('click', onClick);
  return b;
}

// ---------- Input ----------
function clearInput() {
  keys.clear();
  touch.x = touch.z = padMove.x = padMove.z = 0;
  touch.sprint = padMove.sprint = false;
  setCharge(null);
}

function movement() {
  // Arrow keys lead the throw while a pass is charging, so they do not move the quarterback then.
  const arrows = !charge;
  const key = code => (keys.has(code) ? 1 : 0);
  const arrow = code => (arrows && keys.has(code) ? 1 : 0);
  let x = key('KeyD') - key('KeyA') + arrow('ArrowRight') - arrow('ArrowLeft') + touch.x + padMove.x;
  let z = key('KeyW') - key('KeyS') + arrow('ArrowUp') - arrow('ArrowDown') + touch.z + padMove.z;
  const length = Math.hypot(x, z);
  if (length > 1) { x /= length; z /= length; }
  const sprint = keys.has('ShiftLeft') || keys.has('ShiftRight') || touch.sprint || padMove.sprint;
  return { x, z, sprint };
}

// ---------- Mode: title menu or game ----------
function setMode() {
  document.body.classList.toggle('in-menu', inMenu);
  document.body.classList.toggle('in-game', !inMenu);
  $('welcome').hidden = !inMenu;
  $('hud').hidden = inMenu;
}

function start() {
  if (!view) return;
  inMenu = false;
  started = true;
  setMode();
  view.firstFrame = true;
  graphics.reset();
  last = performance.now();
  syncPlay();
}

function returnToMenu() {
  if (replay) closeReplay();
  closeAllDialogs();
  // A rep in progress restarts from the huddle when practice resumes.
  if (!['presnap', 'dead'].includes(sim.phase)) sim.reset();
  inMenu = true;
  setMode();
  clearInput();
  view.firstFrame = true;
  setMenuIndex(0);
  syncPlay();
}

function setMenuIndex(index, focus = false) {
  menuIndex = (index + menuItems.length) % menuItems.length;
  menuItems.forEach((item, i) => item.classList.toggle('is-active', i === menuIndex));
  if (focus) menuItems[menuIndex].focus({ preventScroll: true });
}

function moveMenu(step) {
  setMenuIndex(menuIndex + step, true);
  audio.event('menu');
}

function activateMenu() { menuItems[menuIndex].click(); }

menuItems.forEach((item, i) => {
  item.addEventListener('pointerenter', () => setMenuIndex(i));
  item.addEventListener('focus', () => setMenuIndex(i));
});

// ---------- Dialogs ----------
function openDialog(id, returnTo = null) {
  if (activeDialog) return;
  clearInput();
  paused = true;
  activeDialog = $(id);
  dialogReturn = returnTo;
  if (id === 'pause') renderPause();
  activeDialog.showModal();
  audio.suspend();
}

function closeDialog() {
  if (!activeDialog) return;
  const dialog = activeDialog, back = dialogReturn;
  activeDialog = null;
  dialogReturn = null;
  dialog.close();
  paused = false;
  clearInput();
  last = performance.now();
  accumulator = 0;
  graphics?.reset();
  audio.resume();
  if (back) openDialog(back);
}

function closeAllDialogs() {
  dialogReturn = null;
  closeDialog();
}

// Opens a dialog from another one (pause -> settings) and returns to it afterwards.
function swapDialog(id, returnTo) {
  if (activeDialog) {
    activeDialog.close();
    activeDialog = null;
    dialogReturn = null;
  }
  paused = false;
  openDialog(id, returnTo);
}

document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', closeDialog));
document.querySelectorAll('dialog').forEach(dialog => {
  dialog.addEventListener('cancel', e => { e.preventDefault(); closeDialog(); });
  dialog.addEventListener('click', e => {
    if (e.target !== dialog) return;
    const r = dialog.getBoundingClientRect();
    const outside = e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
    if (outside) closeDialog();
  });
});

// ---------- Play state ----------
function syncPlay() {
  view?.setPlay(sim.effectivePlay, sim.spot, sim.config.flip, sim.config.mode === 'drive' ? sim.toGo : null);
  $('offense').value = sim.config.offense;
  $('random-play').setAttribute('aria-pressed', String(sim.config.offense === 'random'));
  $('play-name').textContent = sim.play.name;
  const flags = [sim.play.formation];
  if (sim.config.offense === 'random') flags.push('RANDOM');
  if (sim.audibled) flags.push('AUDIBLE');
  if (Object.keys(sim.hotRoutes).length) flags.push('HOT ROUTE');
  $('formation').textContent = flags.join(' · ');
  $('read-tip').textContent = sim.play.read;
  renderPlaybook();
  clearInput();
  renderHUD();
}

function snap() {
  if (inMenu) { start(); return; }
  if (paused || replay) return;
  if (sim.phase === 'presnap') {
    sim.snap();
    clearInput();
  } else if (sim.phase === 'dead') {
    sim.next();
    syncPlay();
  }
  renderHUD();
}

// ---------- Passing ----------
function setCharge(next) {
  charge = next;
  $('charge').hidden = !charge;
  targetButtons.forEach((b, i) => b.classList.toggle('active', !!charge && i === charge.index));
  RECEIVERS.forEach((id, i) => markers[id]?.classList.toggle('active', !!charge && i === charge.index));
  if (charge) $('charge').style.setProperty('--target-color', ROUTE_COLORS[charge.index]);
}

function beginCharge(index) {
  if (inMenu || paused || replay || sim.phase !== 'live' || sim.carrier !== 'QB' || sim.crossedLine || sim.play.type === 'run') return;
  if (sim.play.type === 'pa' && sim.time < 1.1) { toast('Let the play-action fake develop'); return; }
  setCharge({ id: RECEIVERS[index], index, started: performance.now() });
  $('charge-target').textContent = String(index + 1);
}

function passStyleFor(seconds) {
  if (prefs.passStyle !== 'timing') return prefs.passStyle;
  return seconds < PASS_CHARGE.touch ? 'lob' : seconds < PASS_CHARGE.bullet ? 'touch' : 'bullet';
}

function releaseCharge(index) {
  if (!charge || charge.index !== index) return;
  const style = passStyleFor((performance.now() - charge.started) / 1000);
  const lead = {
    x: (keys.has('ArrowRight') ? 1 : 0) - (keys.has('ArrowLeft') ? 1 : 0),
    z: (keys.has('ArrowUp') ? 1 : 0) - (keys.has('ArrowDown') ? 1 : 0),
  };
  if (!sim.requestThrow(charge.id, style, lead)) toast(sim.crossedLine ? 'Past the line of scrimmage: run it' : 'Set your feet before the throw');
  setCharge(null);
}

// ---------- Camera, pause, fullscreen ----------
function setCamera(id) {
  prefs.camera = id;
  if (view) view.cameraMode = id;
  $('camera').value = id;
  savePrefs();
}

function cycleCamera() {
  const index = CAMERAS.findIndex(c => c.id === prefs.camera);
  setCamera(CAMERAS[(index + 1) % CAMERAS.length].id);
  toast(cameraLabel(prefs.camera));
}

function openPlaybook() {
  if (replay) closeReplay();
  if (!inMenu && !['presnap', 'dead'].includes(sim.phase)) { toast('Call the next play after this rep'); return; }
  openDialog('playbook');
}

function togglePause() {
  if (inMenu) return;
  if (activeDialog) closeAllDialogs();
  else openDialog('pause');
}

async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else if (document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen();
    else toast('Fullscreen is not supported in this browser');
  } catch {
    toast('Fullscreen is unavailable here');
  }
}

document.addEventListener('fullscreenchange', () => {
  const active = !!document.fullscreenElement;
  $('fullscreen').setAttribute('aria-pressed', String(active));
  $('fullscreen').setAttribute('aria-label', (active ? 'Exit' : 'Enter') + ' fullscreen (F)');
  view?.resize();
});

// ---------- Hot routes and audibles ----------
function canAdjust() {
  if (inMenu || replay || sim.phase !== 'presnap') { toast('Make adjustments before the snap'); return false; }
  return true;
}

function openHotRoutes() {
  if (!canAdjust()) return;
  if (sim.play.type === 'run') { toast('Hot routes need a pass play. Press Z to audible'); return; }
  renderHotRoutes();
  openDialog('hot-routes');
}

function openAudibles() {
  if (!canAdjust()) return;
  audiblePage = Math.floor(Math.max(0, PLAYS.findIndex(p => p.id === sim.play.id)) / AUDIBLES_PER_PAGE);
  renderAudibles();
  openDialog('audibles');
}

function applyHotRoute(kind) {
  if (sim.setHotRoute(RECEIVERS[hotReceiver], kind)) {
    syncPlay();
    renderHotRoutes();
  }
}

function chooseAudible(id) {
  if (sim.audible(id)) {
    syncPlay();
    closeDialog();
    toast('Audible: ' + sim.play.name);
  }
}

function renderHotRoutes() {
  const current = sim.hotRoutes[RECEIVERS[hotReceiver]];
  const route = HOT_ROUTES.find(r => r.id === current);
  $('hot-route-current').textContent = 'Receiver ' + (hotReceiver + 1) + ' · ' + (route?.label || 'Original route');

  const receivers = RECEIVERS.map((id, i) => {
    const b = button('receiver-choice', String(i + 1), () => { hotReceiver = i; renderHotRoutes(); });
    b.style.setProperty('--target-color', ROUTE_COLORS[i]);
    b.setAttribute('aria-label', 'Receiver ' + (i + 1));
    b.setAttribute('aria-pressed', String(i === hotReceiver));
    return b;
  });
  $('hot-route-receivers').replaceChildren(...receivers);

  const routes = HOT_ROUTES.map(r => {
    const b = button('option-card', `<span>${r.label}</span><kbd>${r.key}</kbd>`, () => applyHotRoute(r.id));
    b.setAttribute('aria-label', r.label + ' route');
    b.setAttribute('aria-pressed', String(current === r.id));
    return b;
  });
  $('hot-route-grid').replaceChildren(...routes);
}

function renderAudibles() {
  const cards = PLAYS.slice(audiblePage * AUDIBLES_PER_PAGE, (audiblePage + 1) * AUDIBLES_PER_PAGE).map((play, i) => {
    const b = button('option-card', `<kbd>${i + 1}</kbd><div><span>${play.name}</span><small>${play.formation} · ${play.tag}</small></div>`, () => chooseAudible(play.id));
    b.setAttribute('aria-label', 'Audible ' + (i + 1) + ': ' + play.name);
    b.setAttribute('aria-pressed', String(play.id === sim.play.id));
    return b;
  });
  $('audible-grid').replaceChildren(...cards);
  $('audible-page').textContent = `Page ${audiblePage + 1} of ${Math.ceil(PLAYS.length / AUDIBLES_PER_PAGE)}`;
  $('audible-prev').disabled = audiblePage === 0;
  $('audible-next').disabled = (audiblePage + 1) * AUDIBLES_PER_PAGE >= PLAYS.length;
}

function changeAudiblePage(step) {
  audiblePage = clamp(audiblePage + step, 0, Math.ceil(PLAYS.length / AUDIBLES_PER_PAGE) - 1);
  renderAudibles();
}

// ---------- Pause ----------
function renderPause() {
  const s = sim.stats;
  const items = [
    [`${s.completions}/${s.attempts}`, 'Comp / Att'], [s.yards, 'Yards'], [s.td, 'Touchdowns'],
    [s.reps, 'Reps'], [s.ints, 'Interceptions'], [s.sacks, 'Sacks'],
  ];
  $('session-stats').replaceChildren(...items.map(([value, label]) => {
    const cell = document.createElement('div');
    const strong = document.createElement('strong');
    const span = document.createElement('span');
    strong.textContent = String(value);
    span.textContent = label;
    cell.append(strong, span);
    return cell;
  }));
  $('pause-system').textContent = [$('quality-label').textContent, fps ? fps + ' FPS' : '', $('input-device').textContent].filter(Boolean).join(' · ');
}

// ---------- Replay ----------
function setReplayPlaying(playing) {
  replay.playing = playing;
  $('replay-play').classList.toggle('is-paused', !playing);
  $('replay-play').setAttribute('aria-label', playing ? 'Pause replay' : 'Play replay');
}

function openReplay() {
  if (sim.phase !== 'dead' || sim.recording.length < 2) return;
  clearInput();
  replay = { time: 0, playing: true, frames: sim.recording.slice(), duration: sim.recording.at(-1).time };
  setReplayPlaying(true);
  $('replay-controls').hidden = false;
  $('result').hidden = true;
  view.firstFrame = true;
  audio.suspend();
  renderHUD();
}

function closeReplay() {
  replay = null;
  $('replay-controls').hidden = true;
  view.firstFrame = true;
  audio.resume();
  renderHUD();
}

// ---------- Playbook ----------
// Route diagram on a dark field: 2 px per yard downfield, the line of scrimmage at y = 100.
function diagram(play) {
  const flip = sim.config.flip;
  const formation = formationFor(play);
  const map = ([x, z]) => [100 + (flip ? -x : x) * 3.4, 100 - z * 2];
  const fmt = n => n.toFixed(1);
  let svg = '<svg viewBox="0 0 200 122" role="img" aria-label="Route diagram"><rect width="200" height="122" fill="#0e2a26"/>';
  for (let z = -5; z <= 45; z += 5) {
    const y = 100 - z * 2;
    svg += `<path d="M0 ${y}H200" stroke="#f4f2ec" stroke-opacity="${z % 10 ? .05 : .1}"/>`;
    svg += `<path d="M89.5 ${y}h-3M110.5 ${y}h3" stroke="#f4f2ec" stroke-opacity=".22"/>`;
  }
  svg += '<path d="M0 100H200" stroke="#c9ccd1" stroke-opacity=".55" stroke-width="1"/>';

  RECEIVERS.forEach((id, i) => {
    const spec = formation.find(p => p.id === id);
    const points = [[spec.x, spec.z], ...play.routes[id]].map(map);
    const color = ROUTE_COLORS[i];
    const blocker = play.type === 'run' && id !== 'R';
    svg += `<polyline points="${points.map(p => p.map(fmt).join(',')).join(' ')}" stroke="${color}" fill="none" stroke-width="${id === 'R' && play.type === 'run' ? 2.2 : 1.6}" stroke-linejoin="round" stroke-linecap="round"/>`;
    svg += routeEnd(points, color, blocker);
    svg += `<circle cx="${fmt(points[0][0])}" cy="${fmt(points[0][1])}" r="3" fill="${color}"/>`;
  });
  // Offensive line (centre drawn as a square) and the quarterback.
  for (const spec of formation.filter(p => p.role === 'ol')) {
    const [x, y] = map([spec.x, spec.z]);
    svg += spec.id === 'C'
      ? `<rect x="${fmt(x - 2.6)}" y="${fmt(y - 2.6)}" width="5.2" height="5.2" fill="none" stroke="#c9ccd1" stroke-width="1.2"/>`
      : `<circle cx="${fmt(x)}" cy="${fmt(y)}" r="2.6" fill="none" stroke="#c9ccd1" stroke-width="1.2"/>`;
  }
  const qb = formation.find(p => p.id === 'QB');
  const [qx, qy] = map([qb.x, qb.z]);
  svg += `<circle cx="${fmt(qx)}" cy="${fmt(qy)}" r="3" fill="#f4f2ec"/></svg>`;
  return svg;
}

// Pass routes end in an arrowhead; run-play blockers end in a block bar.
function routeEnd(points, color, blocker) {
  const [x1, y1] = points.at(-2), [x2, y2] = points.at(-1);
  const length = Math.hypot(x2 - x1, y2 - y1) || 1;
  const ux = (x2 - x1) / length, uy = (y2 - y1) / length, px = -uy, py = ux;
  const f = n => n.toFixed(1);
  if (blocker) return `<path d="M${f(x2 + px * 3.5)} ${f(y2 + py * 3.5)}L${f(x2 - px * 3.5)} ${f(y2 - py * 3.5)}" stroke="${color}" stroke-width="1.8" stroke-linecap="round"/>`;
  const bx = x2 - ux * 5, by = y2 - uy * 5;
  return `<path d="M${f(x2 + ux)} ${f(y2 + uy)}L${f(bx + px * 2.8)} ${f(by + py * 2.8)}L${f(bx - px * 2.8)} ${f(by - py * 2.8)}Z" fill="${color}"/>`;
}

function matchesFilter(play) {
  const typeMatches = playFilter === 'all' || (playFilter === 'run' ? play.type === 'run' : play.type !== 'run');
  const formationMatches = !$('play-formation-filter').value || play.formation === $('play-formation-filter').value;
  const query = $('play-search').value.trim().toLowerCase();
  const searchMatches = !query || `${play.name} ${play.tag} ${play.formation} ${play.family || ''} ${play.read}`.toLowerCase().includes(query);
  return typeMatches && formationMatches && searchMatches;
}

function choosePlay(id) {
  if (sim.phase === 'dead') sim.next();
  sim.selectPlay(id);
  syncPlay();
  closeAllDialogs();
  if (inMenu) start();
}

function renderPlaybook() {
  const cards = PLAYS.filter(matchesFilter).map(play => {
    const current = play.id === sim.play.id;
    const head = `<div class="play-card-head"><span class="play-tag">${play.tag}</span>${current ? '<span class="play-current">Current</span>' : ''}</div>`;
    const b = button('play-card' + (current ? ' selected' : ''), `${head}<h3>${play.name}</h3>${diagram(play)}<span class="play-formation">${play.formation}</span><span class="play-read">${play.read}</span>`, () => choosePlay(play.id));
    b.setAttribute('aria-label', play.name + ' — ' + play.tag);
    return b;
  });
  $('play-grid').replaceChildren(...cards);
  $('playbook-results').textContent = cards.length ? `${cards.length} of ${PLAYS.length} plays` : 'No matching plays. Try another formation or search.';
}

function renderPlayCounts() {
  $('count-all').textContent = String(PLAYS.length);
  $('count-pass').textContent = String(PLAYS.filter(p => p.type !== 'run').length);
  $('count-run').textContent = String(PLAYS.filter(p => p.type === 'run').length);
}

// ---------- HUD ----------
// The controlled player's state line. Every simulation phase has an entry
// (null: decided by his action and movement below), and so does every
// action (plan 3.4; null: decided by movement). Unknown values fall through.
const PHASE_STATES = { presnap: 'READY', live: null, air: 'PASS AWAY', run: null, tackle: 'WRAPPED', dead: null };
const ACTION_STATES = {
  ready: 'READY', run: null, cut: null, juke: 'JUKE', block: 'ENGAGED', throw: 'THROWING', catch: 'CATCH',
  carry: null, wrapped: 'WRAPPED', tackle: 'TACKLING', down: 'DOWN', stumble: 'STUMBLING',
};
// After the whistle: how the rep ended for him.
const DEAD_STATES = { tackle: 'DOWN', sack: 'DOWN', safety: 'DOWN', out: 'OUT OF BOUNDS', touchdown: 'TOUCHDOWN', incomplete: 'INCOMPLETE', interception: 'INTERCEPTED', timeout: 'REP OVER' };

function playerState(p, pre) {
  const phase = pre ? 'presnap' : sim.phase;
  if (phase === 'dead') return p.action === 'down' ? 'DOWN' : DEAD_STATES[sim.result?.kind] || 'WHISTLE';
  if (PHASE_STATES[phase]) return PHASE_STATES[phase];
  if (ACTION_STATES[p.action]) return ACTION_STATES[p.action];
  if (sim.crossedLine && p.id === 'QB') return 'RUN ONLY';
  if (p.stamina < .25) return 'FATIGUED';
  return Math.hypot(p.vx, p.vz) > 1 ? 'ON THE MOVE' : 'FEET SET';
}

function renderHUD() {
  const phase = sim.phase, pre = phase === 'presnap', dead = phase === 'dead', live = !pre && !dead;
  const run = sim.play.type === 'run';
  const passing = phase === 'live' && !run && !sim.crossedLine;
  const drive = sim.config.mode === 'drive';
  const body = document.body.classList;
  body.toggle('playing', live);
  body.toggle('presnap', pre);
  body.toggle('dead', dead);
  body.toggle('replaying', !!replay);
  body.toggle('drive-mode', drive);

  // Score bug: practice shows field position and rep; drive mode shows down and distance.
  const goal = sim.spot + sim.toGo >= GOAL;
  setHidden('practice-label', drive);
  setHidden('rep-cell', drive);
  setHidden('down-distance', !drive);
  setHidden('to-go-cell', !drive);
  setText('down-distance', downAndDistance());
  setText('drive-detail', goal ? 'GOAL TO GO' : sim.toGo + ' YDS TO GO');
  setText('field-position', fieldPosition(sim.spot));
  setText('rep-number', String(sim.stats.reps + (pre ? 1 : 0)).padStart(2, '0'));
  setText('coverage-label', sim.config.coverage === 'random' && pre ? 'Disguised' : COVERAGES[sim.coverage].label);

  // Play call card and actions.
  setHidden('presnap-adjustments', !pre || !!replay);
  if ($('hot-routes-open').disabled !== run) {
    $('hot-routes-open').disabled = run;
    $('hot-routes-open').title = run ? 'Call a pass play to set hot routes' : 'Hot routes · H';
  }
  setHidden('read-tip', !pre);
  setHidden('snap', !pre);
  setHidden('throw-away', !passing);
  setHidden('targets', (!pre && !passing) || run || !!replay);
  setHidden('result', !dead || !!replay);
  setHidden('touch-controls', !isTouch || !live || !!replay);
  setHidden('minimap', !prefs.fieldStrip || !!replay);

  const p = sim.byId[sim.carrier || sim.selected];
  setText('player-role', p.role.toUpperCase() + ' ' + p.number);
  const stamina = Math.round(p.stamina * 100) + '%';
  if ($('stamina-fill').style.width !== stamina) $('stamina-fill').style.width = stamina;
  $('stamina-fill').parentElement.classList.toggle('low', p.stamina < .25);
  setText('player-state', playerState(p, pre));

  if (dead && sim.result) renderResult(sim.result, drive);
}

function renderResult(r, drive) {
  const touchdown = r.kind === 'touchdown';
  const bad = BAD_RESULTS.includes(r.kind) || (drive && sim.down === 4 && !r.firstDown && !touchdown);
  const good = touchdown || (drive && r.firstDown && !bad);
  let tag = 'REP ' + String(sim.stats.reps).padStart(2, '0') + ' · ' + fieldPosition(sim.spot);
  if (drive) {
    tag = downAndDistance() + ' · ' + fieldPosition(sim.spot);
    if (touchdown) tag = 'SCORE';
    else if (r.kind === 'interception') tag = 'TURNOVER';
    else if (r.firstDown) tag = 'FIRST DOWN';
    else if (sim.down === 4) tag = 'TURNOVER ON DOWNS';
  }
  const banner = $('result');
  banner.classList.toggle('good', good);
  banner.classList.toggle('bad', bad && !good);
  setText('result-yards', r.yards > 0 ? '+' + r.yards : r.yards < 0 ? '−' + Math.abs(r.yards) : '0');
  setText('result-tag', tag);
  setText('result-title', r.label);
  setText('result-detail', r.time.toFixed(1) + ' SEC · ' + sim.stats.completions + '/' + sim.stats.attempts + ' PASSING');
}

// The field strip: the whole field drawn left to right with the line of scrimmage and line to gain.
function drawFieldStrip(state) {
  const canvas = $('minimap');
  if (canvas.hidden) return;
  const c = canvas.getContext('2d'), w = canvas.width, h = canvas.height;
  const sx = w / 120, sy = h / 53.33;
  const toX = z => z * sx, toY = x => h / 2 - x * sy;
  c.clearRect(0, 0, w, h);
  c.fillStyle = '#0e2a26';
  c.fillRect(0, 0, w, h);
  c.fillStyle = '#163a33';
  c.fillRect(0, 0, toX(10), h);
  c.fillRect(toX(110), 0, toX(10), h);
  c.strokeStyle = 'rgba(244,242,236,.18)';
  c.lineWidth = 1.5;
  for (let z = 10; z <= 110; z += 10) {
    c.beginPath(); c.moveTo(toX(z), 0); c.lineTo(toX(z), h); c.stroke();
  }
  const line = (z, color, width) => { c.strokeStyle = color; c.lineWidth = width; c.beginPath(); c.moveTo(toX(z), 0); c.lineTo(toX(z), h); c.stroke(); };
  line(state.spot, '#c9ccd1', 3);
  if (sim.config.mode === 'drive') line(Math.min(GOAL, state.spot + sim.toGo), '#e3b23c', 3);
  for (const p of state.players) {
    const offense = sim.byId[p.id]?.team === 'offense';
    c.fillStyle = p.id === state.carrier ? '#e3b23c' : offense ? '#f4f2ec' : '#7f93ad';
    c.beginPath();
    c.arc(toX(p.z), toY(p.x), p.id === state.carrier ? 6 : 4, 0, Math.PI * 2);
    c.fill();
  }
}

function positionMarkers(state) {
  const visible = !inMenu && !replay && ['presnap', 'live'].includes(state.phase) && sim.play.type !== 'run' && !sim.crossedLine;
  for (const id of RECEIVERS) {
    const el = markers[id];
    const p = visible && state.players.find(q => q.id === id);
    // Just above the rendered helmet, so badges sit on crouched receivers too.
    const top = p && view.helmetTop?.(id);
    const s = p && (top ? view.project(top.x, top.y + 0.12, top.z) : view.project(p.x, 2.55, p.z));
    const hidden = !s || !s.visible;
    if (el.hidden !== hidden) el.hidden = hidden;
    if (hidden) continue;
    el.style.transform = `translate(${s.x.toFixed(1)}px, ${s.y.toFixed(1)}px) translate(-50%, -100%)`;
  }
}

// The pass meter sits beside the quarterback while a throw is charging.
function updatePassMeter(state, now) {
  if (!charge) return;
  const seconds = (now - charge.started) / 1000;
  const style = passStyleFor(seconds);
  $('charge-fill').style.height = Math.min(100, seconds / PASS_CHARGE.full * 100) + '%';
  setText('charge-label', style);
  $('charge').classList.toggle('bullet', style === 'bullet');
  const qb = state.players.find(p => p.id === 'QB');
  if (!qb) return;
  const s = view.project(qb.x, 1.2, qb.z);
  const x = clamp(s.x + 30, 8, innerWidth - 120), y = clamp(s.y - 70, 8, innerHeight - 110);
  $('charge').style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
}

// ---------- Static UI setup ----------
function buildTargets() {
  const meterTicks = $('charge').querySelectorAll('.meter-tick');
  meterTicks[0].style.bottom = PASS_CHARGE.touch / PASS_CHARGE.full * 100 + '%';
  meterTicks[1].style.bottom = PASS_CHARGE.bullet / PASS_CHARGE.full * 100 + '%';
  RECEIVERS.forEach((id, i) => {
    const key = String(i + 1);
    const b = button('target-button', `<strong>${key}</strong>`);
    b.style.setProperty('--target-color', ROUTE_COLORS[i]);
    b.setAttribute('aria-label', 'Pass to receiver ' + key);
    b.setAttribute('aria-keyshortcuts', key);
    b.addEventListener('pointerdown', e => { e.preventDefault(); b.setPointerCapture(e.pointerId); beginCharge(i); });
    b.addEventListener('pointerup', () => releaseCharge(i));
    b.addEventListener('pointercancel', clearInput);
    targetButtons.push(b);
    $('targets').append(b);

    const marker = document.createElement('div');
    marker.className = 'receiver-marker';
    marker.id = 'marker-' + id;
    marker.textContent = key;
    marker.hidden = true;
    marker.style.setProperty('--target-color', ROUTE_COLORS[i]);
    markers[id] = marker;
    $('receiver-labels').append(marker);
  });
}

function buildSettings() {
  PLAYS.forEach(play => $('offense').append(new Option(play.name, play.id)));
  [...new Set(PLAYS.map(play => play.formation))].forEach(name => $('play-formation-filter').append(new Option(name, name)));
  fillOptions($('lighting'), LIGHTING);
  fillOptions($('camera'), CAMERAS);
  $('graphics').value = prefs.graphics;
  $('lighting').value = prefs.lighting;
  $('camera').value = prefs.camera;
  $('pass-style').value = prefs.passStyle;
  $('field-strip').value = prefs.fieldStrip ? 'on' : 'off';

  // Display and control preferences apply immediately; practice settings wait for Apply.
  $('graphics').onchange = () => { prefs.graphics = $('graphics').value; savePrefs(); graphics?.select(prefs.graphics); };
  $('lighting').onchange = () => { prefs.lighting = $('lighting').value; savePrefs(); view?.setLighting(prefs.lighting); };
  $('camera').onchange = () => setCamera($('camera').value);
  $('pass-style').onchange = () => { prefs.passStyle = $('pass-style').value; savePrefs(); };
  $('field-strip').onchange = () => { prefs.fieldStrip = $('field-strip').value === 'on'; savePrefs(); renderHUD(); };
}

$('start').onclick = start;
$('menu-playbook').onclick = openPlaybook;
$('menu-settings').onclick = () => openDialog('settings');
$('menu-controls').onclick = () => openDialog('help');
$('snap').onclick = snap;
$('next').onclick = snap;
$('throw-away').onclick = () => sim.throwAway();
$('settings-open').onclick = () => openDialog('settings');
$('help-open').onclick = () => openDialog('help');
$('playbook-open').onclick = openPlaybook;
$('result-playbook').onclick = openPlaybook;
$('random-play').onclick = () => choosePlay('random');
$('hot-routes-open').onclick = openHotRoutes;
$('audible-open').onclick = openAudibles;
$('audible-prev').onclick = () => changeAudiblePage(-1);
$('audible-next').onclick = () => changeAudiblePage(1);
$('play-search').oninput = renderPlaybook;
$('play-formation-filter').onchange = renderPlaybook;
$('hot-route-reset').onclick = () => applyHotRoute('default');
$('pause-button').onclick = togglePause;
$('resume').onclick = closeAllDialogs;
$('restart').onclick = () => { sim.reset(); syncPlay(); closeAllDialogs(); };
$('pause-settings').onclick = () => swapDialog('settings', 'pause');
$('pause-controls').onclick = () => swapDialog('help', 'pause');
$('quit-menu').onclick = returnToMenu;
$('fullscreen').onclick = toggleFullscreen;
$('art-button').onclick = () => {
  showArt = !showArt;
  $('art-button').setAttribute('aria-pressed', String(showArt));
};
$('replay-open').onclick = openReplay;
$('replay-close').onclick = closeReplay;
$('replay-play').onclick = () => {
  if (!replay) return;
  if (replay.time >= replay.duration) replay.time = 0;
  setReplayPlaying(!replay.playing);
};
$('replay-scrub').oninput = () => {
  if (!replay) return;
  replay.time = Number($('replay-scrub').value) / 1000 * replay.duration;
  setReplayPlaying(false);
};
$('sound').onclick = async () => {
  await audio.setEnabled(!audio.enabled);
  $('sound').setAttribute('aria-pressed', String(audio.enabled));
  $('sound').setAttribute('aria-label', audio.enabled ? 'Mute sound' : 'Enable sound');
  if (paused) audio.suspend();
};
document.querySelectorAll('[data-filter]').forEach(b => {
  b.onclick = () => {
    playFilter = b.dataset.filter;
    document.querySelectorAll('[data-filter]').forEach(el => el.classList.toggle('active', el === b));
    renderPlaybook();
  };
});
$('flip-play').onchange = () => {
  if (sim.phase === 'dead') sim.next();
  sim.config.flip = $('flip-play').checked;
  sim.reset();
  syncPlay();
};
$('apply-settings').onclick = () => {
  if (replay) closeReplay();
  sim.reset();
  sim.configure({
    offense: $('offense').value, coverage: $('coverage').value, difficulty: $('difficulty').value,
    mode: $('practice-mode').value, spot: Number($('spot').value),
  });
  syncPlay();
  closeDialog();
  if (!inMenu) toast('Settings applied');
};

// ---------- Keyboard ----------
const GAME_KEYS = ['Space', 'Enter', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'KeyB', 'KeyC', 'KeyH', 'KeyZ', 'KeyP', 'Escape', 'KeyX', 'KeyR', 'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'ShiftLeft', 'ShiftRight'];

function dialogKey(e) {
  if (e.code === 'Escape') { e.preventDefault(); closeDialog(); return; }
  if (e.repeat) return;
  if (activeDialog.id === 'hot-routes') {
    if (/^Digit[1-5]$/.test(e.code)) { e.preventDefault(); hotReceiver = Number(e.code.slice(-1)) - 1; renderHotRoutes(); }
    else if (e.code === 'Digit0') { e.preventDefault(); applyHotRoute('default'); }
    else {
      const route = HOT_ROUTES.find(r => e.code === 'Key' + r.key);
      if (route) { e.preventDefault(); applyHotRoute(route.id); }
    }
  } else if (activeDialog.id === 'audibles') {
    if (/^Digit[1-8]$/.test(e.code)) {
      const play = PLAYS[audiblePage * AUDIBLES_PER_PAGE + Number(e.code.slice(-1)) - 1];
      if (play) { e.preventDefault(); chooseAudible(play.id); }
    } else if (e.code === 'BracketLeft' || e.code === 'BracketRight') {
      e.preventDefault(); changeAudiblePage(e.code === 'BracketLeft' ? -1 : 1);
    }
  }
}

function menuKey(e) {
  if (['ArrowUp', 'KeyW'].includes(e.code)) { e.preventDefault(); moveMenu(-1); }
  else if (['ArrowDown', 'KeyS'].includes(e.code)) { e.preventDefault(); moveMenu(1); }
  else if (['Enter', 'Space'].includes(e.code)) { e.preventDefault(); if (!e.repeat) activateMenu(); }
  else if (e.code === 'KeyB' && !e.repeat) { e.preventDefault(); openPlaybook(); }
}

function gameKey(e) {
  if (GAME_KEYS.includes(e.code)) e.preventDefault();
  if (e.repeat) return;
  keys.add(e.code);
  switch (e.code) {
    case 'Space': case 'Enter': snap(); break;
    case 'Escape': case 'KeyP': togglePause(); break;
    case 'KeyH': openHotRoutes(); break;
    case 'KeyZ': openAudibles(); break;
    case 'KeyB': openPlaybook(); break;
    case 'KeyC': cycleCamera(); break;
    case 'Tab': $('art-button').click(); break;
    case 'KeyR': openReplay(); break;
    case 'KeyX': sim.throwAway(); break;
    case 'KeyQ': sim.juke(-1); break;
    case 'KeyE': sim.juke(1); break;
    default: if (/^Digit[1-5]$/.test(e.code)) beginCharge(Number(e.code.slice(-1)) - 1);
  }
}

window.addEventListener('keydown', e => {
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;
  if (e.code === 'KeyF') { e.preventDefault(); if (!e.repeat) toggleFullscreen(); return; }
  if (activeDialog) dialogKey(e);
  else if (inMenu) menuKey(e);
  else gameKey(e);
});
window.addEventListener('keyup', e => {
  if (/^Digit[1-5]$/.test(e.code)) releaseCharge(Number(e.code.slice(-1)) - 1);
  keys.delete(e.code);
});
window.addEventListener('blur', () => {
  clearInput();
  if (started && !paused && !inMenu) openDialog('pause');
});

// ---------- Touch ----------
const joystick = $('joystick'), thumb = joystick.querySelector('i');
let joyPointer = null;
function updateJoy(e) {
  const r = joystick.getBoundingClientRect();
  const x = e.clientX - r.left - r.width / 2, z = -(e.clientY - r.top - r.height / 2);
  const d = Math.max(36, Math.hypot(x, z));
  touch.x = x / d;
  touch.z = z / d;
  thumb.style.transform = `translate(${touch.x * 32}px, ${-touch.z * 32}px)`;
}
joystick.onpointerdown = e => { e.preventDefault(); joyPointer = e.pointerId; joystick.setPointerCapture(e.pointerId); updateJoy(e); };
joystick.onpointermove = e => { if (e.pointerId === joyPointer) updateJoy(e); };
joystick.onpointerup = joystick.onpointercancel = () => { joyPointer = null; touch.x = touch.z = 0; thumb.style.transform = ''; };
$('touch-sprint').onpointerdown = e => { e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); touch.sprint = true; };
$('touch-sprint').onpointerup = $('touch-sprint').onpointercancel = () => { touch.sprint = false; };
$('touch-juke-left').onclick = () => sim.juke(-1);
$('touch-juke-right').onclick = () => sim.juke(1);

// ---------- Gamepad ----------
// D-pad focus movement inside dialogs, so menus work without a mouse.
function moveDialogFocus(step) {
  const items = [...activeDialog.querySelectorAll('button:not(:disabled), select, input')].filter(el => el.offsetParent !== null);
  if (!items.length) return;
  const index = items.indexOf(document.activeElement);
  items[(index + step + items.length) % items.length].focus();
}

function onPadPress(i) {
  if (i === 9) { togglePause(); return; }
  if (activeDialog) {
    if (i === 1) closeDialog();
    else if (i === 12 || i === 14) moveDialogFocus(-1);
    else if (i === 13 || i === 15) moveDialogFocus(1);
    else if (i === 0 && activeDialog.contains(document.activeElement)) document.activeElement.click();
    return;
  }
  if (paused) return;
  if (inMenu) {
    if (i === 12) moveMenu(-1);
    else if (i === 13) moveMenu(1);
    else if (i === 0) activateMenu();
    return;
  }
  if (i === 0 && (sim.phase === 'presnap' || sim.phase === 'dead')) snap();
  else if (PASS_BUTTONS.includes(i)) beginCharge(PASS_BUTTONS.indexOf(i));
  else if (i === 8) cycleCamera();
  else if (i === 14) sim.juke(-1);
  else if (i === 15) sim.juke(1);
}

function pollGamepad() {
  const pad = navigator.getGamepads?.().find(p => p && p.mapping === 'standard');
  if (!pad) { padMove.x = padMove.z = 0; padMove.sprint = false; padButtons = []; return; }
  $('input-device').textContent = 'Controller';
  const deadzone = v => (Math.abs(v) < .18 ? 0 : (Math.abs(v) - .18) / .82 * Math.sign(v));
  padMove.x = deadzone(pad.axes[0]);
  padMove.z = -deadzone(pad.axes[1]);
  padMove.sprint = !!pad.buttons[7]?.pressed;
  // The left stick also steps through the title menu, one item per push.
  if (inMenu && !activeDialog) {
    const y = pad.axes[1] || 0;
    if (Math.abs(y) > .6 && !padStickLatch) { padStickLatch = Math.sign(y); moveMenu(padStickLatch); }
    else if (Math.abs(y) < .3) padStickLatch = 0;
  }
  pad.buttons.forEach((b, i) => {
    const was = padButtons[i] || false;
    if (b.pressed && !was) onPadPress(i);
    if (!b.pressed && was && PASS_BUTTONS.includes(i)) releaseCharge(PASS_BUTTONS.indexOf(i));
  });
  padButtons = pad.buttons.map(b => b.pressed);
}

window.addEventListener('resize', () => view?.resize());

// ---------- Frame loop ----------
function frame(now) {
  frameId = requestAnimationFrame(frame);
  if (document.hidden || !view) return;
  const raw = Math.max(0, (now - last) / 1000);
  last = now;
  pollGamepad();
  if (paused) return;
  const dt = Math.min(raw, .1);

  if (!inMenu && !replay) {
    accumulator += dt;
    while (accumulator >= STEP) { sim.step(STEP, movement()); accumulator -= STEP; }
    for (const event of sim.drainEvents()) audio.event(event);
  }
  if (replay && replay.playing) {
    replay.time = Math.min(replay.duration, replay.time + dt * .5);
    if (replay.time >= replay.duration) setReplayPlaying(false);
  }

  // The title screen renders at 20 fps; the game is capped at 60 fps.
  if (now + .5 < nextRender) return;
  const interval = inMenu ? 50 : 1000 / 60;
  nextRender = now - nextRender > interval ? now + interval : nextRender + interval;
  const realDelta = Math.max(0, (now - lastRender) / 1000);
  const renderDelta = Math.min(.15, realDelta);
  lastRender = now;

  let state = sim.snapshot();
  if (replay) {
    state = replay.frames[Math.min(replay.frames.length - 1, Math.floor(replay.time / .05))];
    $('replay-scrub').value = String(replay.time / replay.duration * 1000);
  }
  view.render(state, renderDelta, { menu: inMenu, showArt, replay: !!replay });
  graphics.sample(renderDelta * 1000, !inMenu && !replay, ['presnap', 'dead'].includes(sim.phase));
  positionMarkers(state);
  updatePassMeter(state, now);

  uiElapsed += renderDelta;
  // Real elapsed time, so a slow renderer reports its true frame rate.
  fpsElapsed += realDelta;
  fpsFrames++;
  if (view.assetsReady && !$('load-status').hidden) $('load-status').hidden = true;
  if (uiElapsed > .1) {
    renderHUD();
    drawFieldStrip(state);
    uiElapsed = 0;
  }
  if (fpsElapsed > 1) {
    fps = Math.round(fpsFrames / fpsElapsed);
    $('fps').textContent = fps + ' FPS';
    fpsElapsed = 0;
    fpsFrames = 0;
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    cancelAnimationFrame(frameId);
    clearInput();
    audio.suspend();
    if (started && !paused && !inMenu) openDialog('pause');
  } else {
    last = performance.now();
    lastRender = last;
    nextRender = 0;
    accumulator = 0;
    graphics?.reset();
    frameId = requestAnimationFrame(frame);
  }
});

// ---------- Boot ----------
buildTargets();
buildSettings();
renderPlayCounts();
savePrefs();
try {
  view = new FieldScene($('field'), sim.players);
  view.setLighting(prefs.lighting);
  view.cameraMode = prefs.camera;
  graphics = new AdaptiveGraphics((profile, scale) => {
    view.setQuality(profile, scale);
    const auto = prefs.graphics === 'auto' ? 'Auto · ' : '';
    $('quality-label').textContent = auto + profile.label + (scale < 1 ? ' · ' + Math.round(scale * 100) + '%' : '');
  }, prefs.graphics);
  syncPlay();
  $('input-device').textContent = isTouch ? 'Touch' : 'Keyboard and mouse';
  frameId = requestAnimationFrame(frame);
  if (debug) {
    window.footballsim = { sim, view, graphics, start, snap, get paused() { return paused; }, get replay() { return replay; } };
  }
} catch (error) {
  console.error(error);
  $('start').disabled = true;
  $('load-status').textContent = 'WebGL 2 required';
  $('error').hidden = false;
  $('error-message').textContent = 'FootballSim needs WebGL 2. Turn on hardware acceleration in your browser, then reload. ' + (error.message || '');
}

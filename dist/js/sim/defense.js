// The defensive coordinator: the roster, fronts and difficulty table; the
// call for each rep (what the defense plays and, separately, what it shows
// before the snap); the alignment against the offense's formation; and the
// scouting report it keeps on the offense across the session.
//
// Everything here is in the play's own frame: x toward the offense's right
// on an unflipped play, z yards past the line. createPlayer mirrors x for a
// flipped play and coverage.js multiplies landmarks by the same sign, so a
// flipped play draws the mirror image of the same call.
import { RECEIVERS, COVERAGES, formationFor } from '../plays.js';
import { GET_OFF } from './common.js';

export const DIFFICULTY = {
  // Difficulty is how smart the defense is: reads, anticipation, run fits,
  // the rush plan and the coordinator's craft, never bodies, block strength,
  // catching or tackling odds. `latency`: how late (s) a defender reads a
  // quarterback he rushes or watches (his eyes, a scramble); `carrier`: how
  // late he reads the ball carrier on a designed run (close at every level);
  // `chase`: how late he reads a receiver he chases after the catch (he has
  // watched the ball into his hands); `read`: how late a coverage man reads a
  // receiver. `contain`: yards outside a scrambling quarterback the edge
  // rusher on his side keeps (rush lane discipline). `carry`: yards past the
  // line where an underneath defender gives up a vertical he is carrying when
  // no deep man has taken it (his pattern-match rule: All-pro carries it until
  // a deep man takes it). `help`: how far a defender with an empty zone leans
  // toward the most open receiver near him (share of the way from his
  // landmark). `anticipate`: how much of a receiver's change of speed a
  // coverage man reads into where he is going (a receiver sinking into a
  // break), on top of `routeLead` s of his seen velocity.
  // The coordinator: `menu` is the list of families he calls; `situ` how
  // strongly the situation (down, distance, field, formation) steers the
  // call (an exponent on its multipliers); `disguise` the
  // share of calls shown from another shell; `late` the share of disguises
  // whose rotation is held past the snap, `hold` the shortest hold (s; a
  // better coordinator holds the look just long enough to fool the
  // quarterback's first look, no longer); `scout` how much the scouting
  // report steers the call (0 not at all, 1 in full). Run fits (sim/run.js
  // FIT): `runRead` s after the snap when a linebacker reads the run and
  // fits (safeties and corners later), scaled by how much the offense has
  // been running; `bust` the share of men who misfit (jump a gap, over-run
  // the play or read it late); `home` the share of back-side men who stay
  // home for the cutback; `fill` the share of reps a deep safety fills a gap
  // the box leaves open; `blockRead` how well a lineman reads a down block, a
  // reach or a puller (added to his side of the block's margin, RUN_BLOCK;
  // a Rookie is fooled by it). `bite`: s a linebacker steps up on a play fake
  // before he drops, scaled the same way. `eyes`: the
  // share of the quarterback's throwing motion a robber drives on (and a
  // deep middle splitting two verticals leans to). `squeeze`: how far a man
  // defender off or on top trusts his read of a stem (coverage.js MAN).
  // `press`: how much more (or less) often the coordinator presses his zone
  // corners: a pressed corner bails from the line on top of #1, an off one
  // gives the quick throw.
  rookie: { latency: 0.30, carrier: 0.32, chase: 0.25, read: 0.30, ballReaction: 0.36, judgment: 1.8, routeLead: 0.06, anticipate: 0, contain: 0.3, carry: 16, help: 0.2,
    menu: 'rookie', situ: 0.5, disguise: 0.1, late: 0, hold: 0.45, scout: 0, runRead: 0.6, bust: 0.25, home: 0.35, fill: 0.2, blockRead: -0.45, bite: 0.55, eyes: 0, squeeze: 0, press: -0.3 },
  pro: { latency: 0.28, carrier: 0.28, chase: 0.21, read: 0.24, ballReaction: 0.28, judgment: 0.9, routeLead: 0.13, anticipate: 0.5, contain: 1.0, carry: 21, help: 0.45,
    menu: 'pro', situ: 0.8, disguise: 0.35, late: 0.25, hold: 0.3, scout: 0.5, runRead: 0.55, bust: 0.08, home: 0.8, fill: 0.6, blockRead: 0, bite: 0.42, eyes: 0.5, squeeze: 0.5, press: 0 },
  allpro: { latency: 0.2, carrier: 0.26, chase: 0.17, read: 0.18, ballReaction: 0.18, judgment: 0.35, routeLead: 0.20, anticipate: 1, contain: 1.5, carry: Infinity, help: 0.7,
    menu: 'allpro', situ: 1, disguise: 0.5, late: 0.4, hold: 0.15, scout: 1, runRead: 0.5, bust: 0.03, home: 0.95, fill: 0.9, blockRead: 0.3, bite: 0.3, eyes: 1, squeeze: 0.7, press: 0.3 },
};

export const DEFENSE = [
  { id: 'DE1', number: 91, role: 'dl', x: -4.8, z: 1.2, speed: 7.2 },
  { id: 'DT1', number: 95, role: 'dl', x: -1.5, z: 1.2, speed: 6.9 },
  { id: 'DT2', number: 97, role: 'dl', x: 1.6, z: 1.2, speed: 6.8 },
  { id: 'DE2', number: 99, role: 'dl', x: 4.8, z: 1.2, speed: 7.2 },
  { id: 'LB1', number: 54, role: 'lb', x: -7, z: 5, speed: 8.4 },
  { id: 'LB2', number: 52, role: 'lb', x: 0, z: 6, speed: 8.2 },
  { id: 'LB3', number: 56, role: 'lb', x: 7, z: 5, speed: 8.3 },
  { id: 'CB1', number: 23, role: 'cb', x: -21, z: 6, speed: 9.3 },
  { id: 'CB2', number: 24, role: 'cb', x: 21, z: 6, speed: 9.3 },
  { id: 'FS', number: 31, role: 's', x: -9, z: 17, speed: 9.0 },
  { id: 'SS', number: 32, role: 's', x: 9, z: 17, speed: 8.9 },
];
// The rest of the squad, who come on in the other personnel packages: a
// nickel back (a slot corner), a dime back (a sixth defensive back), a nose
// tackle and a fourth linebacker for the heavy and goal-line packages.
// ROSTER is everybody who can ever play (the renderer builds them all; 11 are
// on the field each rep).
export const RESERVES = [
  { id: 'NB', number: 21, role: 'cb', x: 9, z: 5, speed: 9.2 },
  { id: 'DB', number: 29, role: 's', x: -9, z: 6, speed: 9.0 },
  { id: 'DT3', number: 93, role: 'dl', x: 0, z: 1.2, speed: 6.6 },
  { id: 'LB4', number: 50, role: 'lb', x: 3, z: 4, speed: 8.1 },
];
export const ROSTER = [...DEFENSE, ...RESERVES];
const PLAYER = Object.fromEntries(ROSTER.map(p => [p.id, p]));
// The squad the renderer needs: the players on the field now and every
// defender who can come on later (with the defense's team), so a change of
// personnel between reps never needs new rigs.
export function fullSquad(players) {
  const here = new Set(players.map(p => p.id));
  return [...players, ...ROSTER.filter(p => !here.has(p.id)).map(p => ({ ...p, team: 'defense' }))];
}

// Personnel packages. The base 4-3 is DEFENSE; each other package sends men
// on for the base players in `subs`, keyed by the base spot they take (the
// Sam and the Will are the strong and weak outside linebackers, so who
// leaves depends on the formation's strength). Everybody who comes on plays
// the jobs of the spot he takes, with his own technique: a nickel or dime
// back covers a slot like a corner and aligns over #2, the fourth linebacker
// plays the strong safety's box jobs from the box. `families`: the coverage
// families the package can play (all when absent); `shells`: the pre-snap
// looks it can show (all when absent).
//   base     4-3: two wide receivers, a tight end and a back, or fewer wide
//   nickel   4-2-5: the nickel back for the Sam, against three wide
//   dime     4-1-6: the dime back for the Will too, against four or five
//            wide and on 3rd and long
//   heavy    4-4-3: a fourth linebacker for the strong safety (eight in the
//            box, one deep), on short yardage against a tight set
//   goal     5-3-3 goal line: the nose tackle for the free safety; five
//            linemen and the Sam on the line fill all six gaps, the Mike
//            and the Will stack behind them, the strong safety plays at the
//            goal line and the corners press. Man, Cover 0 and a compressed
//            Cover 3 only: there is no room for two deep halves.
export const PACKAGES = {
  base: { name: 'Base', look: '4-3', subs: {} },
  nickel: { name: 'Nickel', look: '4-2-5', subs: { sam: 'NB' } },
  dime: { name: 'Dime', look: '4-1-6', subs: { sam: 'NB', will: 'DB' } },
  heavy: { name: 'Heavy', look: '4-4-3', subs: { SS: 'LB4' }, families: ['cover3', 'cover1', 'blitz', 'firezone', 'creeper'], shells: ['one-high', 'mug'] },
  goal: { name: 'Goal line', look: '5-3-3', subs: { FS: 'DT3' }, families: ['cover1', 'blitz', 'cover3'], shells: ['one-high', 'mug'] },
};
// Choosing the package. A receiver is detached when a wide receiver stands
// `wr` yd or more from the ball, a tight end or back `te` yd or more (a tight
// end inside a bunch stays a tight end). Inside `goal` yd of the goal line
// the goal-line package comes on (against four or more detached, the
// nickel). A coordinator matches the offense situ² of the time (the
// difficulty's `situ`: Rookie a quarter, Pro two thirds, All-pro always) and
// otherwise stays in base. A running offense (the scouting report) keeps the
// base on the field against three wide up to `run` of the time; a passing
// one brings the nickel against the base sets up to `pass` of the time.
const PERSONNEL = { wr: 6.8, te: 9, goal: 5, run: 0.35, pass: 0.3 };
// Inside PERSONNEL.goal yd a matched package (nickel or dime against a
// spread set) never calls the coverages that need depth behind them: no
// pole runner, no quarters.
const CRAMPED = ['tampa2', 'cover4', 'cover6'];
// The spots in the base 4-3, in the order the players line up (and draw
// their jitter).
const SPOTS = DEFENSE.map(p => p.id);
// Who plays each base spot in this package against this strength.
function lineup(pkg, s) {
  const subs = PACKAGES[pkg]?.subs || {}, who = {};
  for (const id of SPOTS) who[id] = PLAYER[id];
  for (const [spot, id] of Object.entries(subs)) {
    const at = spot === 'sam' ? (s > 0 ? 'LB3' : 'LB1') : spot === 'will' ? (s > 0 ? 'LB1' : 'LB3') : spot;
    who[at] = PLAYER[id];
  }
  return who;
}
// Detached receivers (see PERSONNEL).
function detached(lay) {
  return Object.entries(lay.at).filter(([id, p]) => !lay.backs.includes(id) && !(p.role === 'te' && lay.bunch?.ids.includes(id))
    && Math.abs(p.x) >= (p.role === 'wr' ? PERSONNEL.wr : PERSONNEL.te)).length;
}
// The package that matches the offense: by formation, down and distance and
// field position.
function matchPackage(lay, down, toGo, togoal, short) {
  const wide = detached(lay);
  if (togoal <= PERSONNEL.goal) return wide >= 4 ? 'nickel' : 'goal';
  if (short) return wide >= 4 ? 'nickel' : wide === 3 ? 'base' : 'heavy';
  const pkg = wide >= 4 ? 'dime' : wide === 3 ? 'nickel' : 'base';
  if (down >= 3 && toGo >= 7) return pkg === 'base' ? 'nickel' : 'dime';
  return pkg;
}
// Defensive line spacing, left to right with the strength on the right
// (mirrored when the offense is strong to its left).
export const FRONTS = [
  { name: 'Even', x: [-4.8, -1.6, 1.6, 4.8] }, { name: 'Over', x: [-5.8, -2.8, 0.65, 4.2] },
  { name: 'Under', x: [-4.2, -0.65, 2.8, 5.8] }, { name: 'Wide 9', x: [-7, -2, 2, 7] },
];

// Coverage families (keys of COVERAGES in plays.js). Rookie calls the simple
// menu; Pro adds quarters, Tampa 2 and the fire zone; All-pro calls them all.
export const FAMILIES = ['cover3', 'cover1', 'cover2', 'tampa2', 'cover4', 'cover6', 'man', 'blitz', 'firezone', 'creeper'];
const MENUS = {
  rookie: ['cover3', 'cover2', 'cover1', 'man', 'blitz'],
  pro: ['cover3', 'cover2', 'cover1', 'tampa2', 'cover4', 'man', 'blitz', 'firezone'],
  allpro: FAMILIES,
};
const TWO_HIGH = new Set(['cover2', 'tampa2', 'cover4', 'cover6', 'man']);
// The families whose corners play man (their press share is their own).
const MAN_FAMILIES = new Set(['cover1', 'man', 'blitz']);
// Where (yd) a one-high free safety stands across the middle: from `weak`
// yd to the weak side to `strong` yd to the strength, drawn per call and
// never from the coverage, so his spot does not tell whether he stays in
// the middle or spins to a half after the snap.
const ONE_HIGH = { weak: 2.5, strong: 1.0 };
// How far off the ball (yd) a linebacker who rushes creeps outside the mug
// look, and how deep a safety who rushes comes down.
const CREEP = 3, SAFETY_CREEP = 7;
// Depth is no tell: on SUGAR times the difficulty's `disguise` of the calls
// a linebacker who drops creeps up like a blitzer (sugar), and, drawn
// apart, a strong safety with an underneath job comes down like a safety
// pressure (roll).
const SUGAR = 0.6;
// The gaps a second-level man walks up into, x from the ball (yd): the A
// gap beside the centre, the B gap outside the guard. A lineman within
// `near` yd of the spot already has the gap; the man stacks `stack` yd off
// behind him. No two defenders start closer than SPACE yd (a body each).
const GAP = { A: 0.85, B: 2.3, near: 0.6, stack: 2.2 }, SPACE = 0.6;
// A late rotation holds the men whose show is more than SHOWN yd from
// their spot in the family's natural look.
const SHOWN = 1;
// A delayed rusher shown DELAY.deep yd off or deeper waits at most
// DELAY.most s for his count.
const DELAY = { deep: 4, most: 0.35 };
// What a neutral down (1st and 10 between the 20s against two by two) calls.
const BASE = { cover3: 1.5, cover1: 1.0, cover2: 1.2, tampa2: 1.05, cover4: 1.15, cover6: 1.0, man: 0.8, blitz: 0.55, firezone: 0.8, creeper: 0.85 };
// Situation multipliers. Short yardage (2 or less) brings the box down and
// man and pressure up; 3rd and long brings pressure and deep shells; 3rd and
// medium plays tight man and sim pressure; 2nd and long expects a pass.
const DOWNS = {
  short: { cover3: 1.3, cover1: 1.4, cover2: 0.6, tampa2: 0.5, cover4: 0.8, cover6: 0.65, man: 0.85, blitz: 1.5, firezone: 1.0, creeper: 0.65 },
  medium: { cover3: 0.9, cover1: 1.25, cover2: 1.0, tampa2: 1.0, cover4: 1.0, cover6: 1.0, man: 1.25, blitz: 1.05, firezone: 1.15, creeper: 1.25 },
  long: { cover3: 0.75, cover1: 0.85, cover2: 1.25, tampa2: 1.5, cover4: 1.25, cover6: 1.2, man: 1.0, blitz: 1.25, firezone: 1.5, creeper: 1.7 },
  second: { cover3: 1.0, cover1: 1.0, cover2: 1.2, tampa2: 1.2, cover4: 1.2, cover6: 1.1, man: 1.0, blitz: 0.9, firezone: 1.1, creeper: 1.2 },
};
// Field position: inside the 5 the deep zones vanish (man, zero, pressure);
// in the red zone the shells compress, man (Cover 1 bracketing the inside)
// and the three-deep zones that play everything in front of them rise, and
// the pole runner and the quarters' seam reads fade (the end line is the
// deep help, the seams are the danger); backed up, the defense attacks.
const FIELD = {
  goal: { cover3: 1.0, cover1: 1.2, cover2: 1.0, tampa2: 0.6, cover4: 0.6, cover6: 0.5, man: 1.8, blitz: 1.6, firezone: 0.8, creeper: 0.5 },
  red: { cover3: 1.3, cover1: 1.3, cover2: 1.2, tampa2: 0.8, cover4: 0.9, cover6: 0.6, man: 1.8, blitz: 1.4, firezone: 1.1, creeper: 0.7 },
  backed: { cover3: 1.2, cover1: 1.1, cover2: 0.9, tampa2: 0.8, cover4: 0.9, cover6: 0.9, man: 0.9, blitz: 1.3, firezone: 1.3, creeper: 1.1 },
};
// Formation fits: quarters against two by two, Cover 6 and a sky rotation
// against trips, match and banjo calls against a bunch, pressure or six in
// coverage against empty, a loaded box against the tight sets.
const FITS = {
  doubles: { cover4: 1.25, cover2: 1.1 },
  trips: { cover6: 1.8, cover3: 1.2, cover4: 0.7, cover2: 0.8 },
  bunch: { cover1: 1.2, cover4: 1.2, cover3: 1.1, cover2: 0.9 },
  empty: { blitz: 1.5, firezone: 1.6, cover1: 1.4, creeper: 1.4, man: 1.2, cover3: 0.85, tampa2: 0.8 },
  pistol: { cover3: 1.2, cover1: 1.2, cover2: 0.85 },
  tight: { cover3: 1.3, cover1: 1.3, blitz: 1.2, cover2: 0.8, tampa2: 0.7, cover4: 1.1, cover6: 0.8 },
  singleback: { cover3: 1.3, cover1: 1.2, cover4: 1.1, blitz: 1.1, tampa2: 0.8 },
};
// No family below FLOOR (shared over the menu: 4 % each of All-pro's ten)
// or above CAP of the calls in any one situation, so nothing becomes
// predictable.
const FLOOR = 0.4, CAP = 0.4;

// Variants within a family: Cover 3 rotations, what Cover 1 does with its
// sixth man, who comes in Cover 0, who drops and who comes in a fire zone or
// a sim pressure.
const VARIANTS = {
  cover3: { sky: 0.45, buzz: 0.3, cloud: 0.25 },
  cover1: { rat: 0.6, pressure: 0.3, spy: 0.1 },
  blitz: { doubleA: 0.3, lbSafety: 0.3, edge: 0.2, corner: 0.2 },
  firezone: { end: 0.45, tackle: 0.3, safety: 0.25 },
  creeper: { end: 0.4, tackle: 0.35, safety: 0.25 },
};
// Pre-snap shells. The first is the family's natural look; the others are
// disguises it can rotate out of, physically: a Cover 3 shown two-high is a
// sky or buzz rotation (one safety spins to the middle, the other is already
// deep enough), a two-deep coverage shown one-high spins the deep safety to
// his half while the down safety bails, and the pressure families show the
// same mug look whether they bring it or drop out of it.
//   two-high  safeties 12-13 yd, 9-10 yd either side of the ball
//   one-high  free safety 14 yd in the middle, strong safety 8-9 yd by the box
//   base      both safeties at 10 yd, a neutral split look
//   mug       linebackers walked up into the A gaps or over the edge, the
//             safeties split at 9-10 yd (a blitzing one walked up), corners
//             pressed
export const SHELLS = {
  cover3: ['one-high', 'two-high', 'base', 'mug'],
  cloud: ['two-high', 'base'],
  cover1: ['one-high', 'two-high', 'base', 'mug'],
  cover2: ['two-high', 'one-high', 'base', 'mug'],
  tampa2: ['two-high', 'one-high', 'base', 'mug'],
  cover4: ['two-high', 'one-high', 'base'],
  cover6: ['two-high', 'one-high', 'base'],
  man: ['two-high', 'one-high', 'base', 'mug'],
  blitz: ['mug', 'one-high', 'two-high', 'base'],
  firezone: ['mug', 'two-high', 'one-high', 'base'],
  creeper: ['mug', 'two-high', 'one-high', 'base'],
};
const SHELL_WEIGHT = { 'two-high': 1.6, 'one-high': 0.8, base: 0.7, mug: 0.35 };
// A pressure (fire zone, sim pressure) shown two-high has the farthest to
// rotate down: it is shown that way this share as often.
const PRESSURE_TWO_HIGH = 0.4;
// Looks a call cannot get out of in time are never shown: Cover 0 shows
// the mug or the base look (its man safeties cannot start 12 yd off their
// men); a safety who rushes cannot start 12 yd deep, and from the
// one-high look only the strong safety's own side is in reach (the weak
// side's safety pressure walks him up in the mug); the
// two-deep zones never walk their hole or pole runner up into the mug (a
// 12 yd drop from the line); and Cover 1 from two-high is the robber call
// only (the down safety is the robber; a pressure or a spy would leave him
// a slot to reach). `side` is the call's side (1 the strength). A package
// shows only its own looks: the heavy and goal-line packages have one
// safety, so never a two-high or split look.
function makeable(family, variant, shell, side = 1, pkg = 'base') {
  const shells = PACKAGES[pkg]?.shells;
  if (shells && !shells.includes(shell)) return false;
  if (family === 'blitz') return shell === 'mug' || shell === 'base';
  if ((family === 'cover2' || family === 'tampa2') && shell === 'mug') return false;
  if ((family === 'firezone' || family === 'creeper') && variant === 'safety') return shell === 'mug' || (shell === 'one-high' && side > 0);
  if (family === 'cover1' && variant !== 'rat') return shell !== 'two-high';
  return true;
}
// Share of calls with the corners pressed (the rest play off or squat). A
// fire zone and a sim pressure mostly press and bail into their thirds from
// any look: the quick throw is the answer to pressure, and an off corner
// gives it away (the mug look always presses).
const PRESS = { cover3: 0.25, cover1: 0.6, cover2: 0.45, tampa2: 0.4, cover4: 0.1, cover6: 0.2, man: 0.7, blitz: 0.6, firezone: 0.7, creeper: 0.7 };
// Man leverage: share of calls with outside leverage (help inside from the
// free safety); the rest play inside leverage.
const OUTSIDE = { cover1: 0.65, man: 0.2, blitz: 0.3 };
// Details per call drawn from the call's own generator (see callDefense).
const DRAWS = 15;

const NAMES = { cover3: 'Cover 3', cover1: 'Cover 1', cover2: 'Cover 2', tampa2: 'Tampa 2', cover4: 'Cover 4', cover6: 'Cover 6', man: '2-man', blitz: 'Cover 0', firezone: 'Fire zone', creeper: 'Sim pressure' };
const VARIANT_NAMES = {
  sky: 'sky', buzz: 'buzz', cloud: 'cloud', rat: 'robber', pressure: 'pressure', spy: 'spy',
  doubleA: 'double A-gap blitz', lbSafety: 'linebacker and safety blitz', edge: 'double edge blitz', corner: 'corner blitz',
  end: 'end drop', tackle: 'tackle drop', safety: 'safety pressure',
};

// --------------------------------------------------------------------------
// Reading the formation. Receivers wider than the box are numbered from the
// outside in on each side (#1, #2, #3); the strength is the side with more
// of them, the tight end's side on a tie. Each receiver's slot (outside,
// slot, te, back) is what the scouting report files his targets under.
const BOX = 4.5;
export function readFormation(formation) {
  const at = {}, slot = {}, left = [], right = [], backs = [];
  for (const p of formation) {
    if (!RECEIVERS.includes(p.id)) continue;
    at[p.id] = { x: p.x, z: p.z, role: p.role };
    if (p.z < -3 && Math.abs(p.x) < BOX) backs.push(p.id);
    else (p.x < 0 ? left : right).push(p.id);
  }
  const wide = (a, b) => Math.abs(at[b].x) - Math.abs(at[a].x) || RECEIVERS.indexOf(a) - RECEIVERS.indexOf(b);
  left.sort(wide); right.sort(wide);
  const te = Object.keys(at).find(id => at[id].role === 'te' && !backs.includes(id));
  const strength = left.length === right.length ? (te && at[te].x < 0 ? -1 : 1) : left.length > right.length ? -1 : 1;
  for (const id of Object.keys(at)) {
    const first = left[0] === id || right[0] === id;
    slot[id] = backs.includes(id) ? 'back' : at[id].role === 'te' && Math.abs(at[id].x) < 9 ? 'te' : first && Math.abs(at[id].x) > 12 ? 'outside' : 'slot';
  }
  // A bunch: three receivers on one side within 5 yd of each other.
  let bunch = null;
  for (const [side, ids] of [[-1, left], [1, right]]) {
    if (ids.length < 3) continue;
    const xs = ids.slice(0, 3).map(id => at[id].x);
    if (Math.max(...xs) - Math.min(...xs) <= 5) bunch = { side, ids: ids.slice(0, 3) };
  }
  const heavy = Object.values(at).filter(p => Math.abs(p.x) < 9 && p.z > -3).length;
  return { at, slot, nums: { [-1]: left, [1]: right }, backs, strength, bunch, heavy };
}

// Who is who against this strength: the Sam linebacker and the strong safety
// play to the strength, the Will away from it; corners and the outside
// linebackers stay on their own side of the ball.
function roles(s) {
  return {
    sam: s > 0 ? 'LB3' : 'LB1', will: s > 0 ? 'LB1' : 'LB3', mike: 'LB2',
    cb: side => side < 0 ? 'CB1' : 'CB2', ol: side => side < 0 ? 'LB1' : 'LB3',
    de: side => side < 0 ? 'DE1' : 'DE2', dt: side => side < 0 ? 'DT1' : 'DT2',
    safety: side => side === s ? 'SS' : 'FS',
  };
}

// How deep (yd) a lineman who drops out of a pressure sets: a tackle in the
// hook or the hole over the ball, an end in the seam on his side. Both are
// drops a lineman makes in about the time the quick game takes.
const DROP = { hook: 6, seam: 6 };

// Coverage jobs (play frame; see coverage.js for how each is played).
// Deep thirds split THIRD yd either side of the ball, so the middle owns the
// seams; halves split at the ball.
const THIRD = 12;
const deep = (x, depth, lo, hi) => ({ kind: 'deep', x, depth, lo, hi });
const third = (side, shade = 0) => side < 0 ? deep(-19, 23, -Infinity, -THIRD) : side > 0 ? deep(19, 23, THIRD, Infinity) : deep(shade, 26, -THIRD, THIRD);
// Against three receivers to one side the post safety starts POST_SHADE yd
// toward them (his zone stays the same).
const POST_SHADE = 3;
const postShade = lay => (lay.nums[lay.strength].length >= 3 ? lay.strength * POST_SHADE : 0);
// How far across (yd) Cover 1's free safety can help over the top of a man.
const FREE_REACH = 9;
// The red zone (yd to the goal line) and how far either side of the ball
// (yd) Cover 1's free safety brackets the inside receivers there.
const RED_ZONE = 20, BRACKET = 9;
const half = side => deep(side * 12, 25, side < 0 ? -Infinity : 0, side < 0 ? 0 : Infinity);
const under = (role, x, depth) => ({ kind: 'under', role, x, depth });
const quarter = (role, side) => ({ kind: 'quarter', role, side });

// Man coverage: who covers whom. Corners take the #1 on their side; the rest
// are matched to the other receivers by role (a safety on a slot, a
// linebacker on a tight end or back) and distance: the cheapest pairing of
// all (at most six defenders on five receivers, so a full search).
// `defenders` are base spots; `who` says who plays each (a nickel or dime
// back in a linebacker's spot covers like a slot corner, the fourth
// linebacker in the strong safety's like a linebacker).
function manCost(def, rec, lay, s, who) {
  const r = lay.at[rec], slot = lay.slot[rec], side = r.x < 0 ? -1 : 1, first = lay.nums[side][0] === rec;
  const natural = { CB1: -18, CB2: 18, LB1: -4, LB2: 0, LB3: 4, FS: -s * 8, SS: s * 8 }[def] ?? 0;
  const role = who?.[def]?.role ?? (def === 'FS' || def === 'SS' ? 's' : 'lb');
  let cost;
  if (def.startsWith('CB')) cost = first && side === (def === 'CB1' ? -1 : 1) ? 0 : first ? 30 : side === (def === 'CB1' ? -1 : 1) ? 6 : 16;
  else if (role === 'cb' || (role === 's' && def.startsWith('LB'))) cost = slot === 'slot' ? 0 : slot === 'outside' ? 4 : slot === 'te' ? 3.5 : 7;
  else if (role === 's') cost = slot === 'slot' ? 1 : slot === 'outside' ? 5 : slot === 'te' ? 3 : 7;
  else cost = slot === 'te' || slot === 'back' ? 0 : slot === 'slot' ? 5 : 12;
  return cost + 0.15 * Math.abs(natural - r.x);
}
function matchMan(defenders, lay, s, who) {
  const recs = RECEIVERS.filter(id => lay.at[id]), cost = defenders.map(d => recs.map(r => manCost(d, r, lay, s, who)));
  let best = Infinity, pick = null;
  const used = new Array(defenders.length).fill(false), take = [];
  const search = (k, total) => {
    if (total >= best) return;
    if (k === recs.length) { best = total; pick = take.slice(); return; }
    for (let i = 0; i < defenders.length; i++) {
      if (used[i]) continue;
      used[i] = true; take.push(i);
      search(k + 1, total + cost[i][k]);
      used[i] = false; take.pop();
    }
  };
  search(0, 0);
  const map = new Map();
  if (pick) pick.forEach((i, k) => map.set(defenders[i], recs[k]));
  return map;
}

// What a corner plays at the line: 'press' (he jams) on a press call;
// 'bail' in the mug look without one (he shows press and bails at the
// snap); else 'off'. Against a #1 split inside TIGHT yd of the ball he
// stands off (showSpots) and plays off whatever the call.
const TIGHT = 10;
function cornerPlay(call, lay, side) {
  const one = lay.nums[side][0];
  if (one && Math.abs(lay.at[one].x) < TIGHT) return 'off';
  return call.press ? 'press' : call.shell === 'mug' ? 'bail' : 'off';
}

// The jobs and rushers of a call against a formation, by base spot (see
// lineup for who plays each).
function assignments(call, lay, togoal = 75) {
  const s = lay.strength, R = roles(s), jobs = {}, rush = {}, who = lineup(call.package, s);
  if (call.package === 'goal') return goalAssignments(call, lay, togoal, who);
  // Inside the 20 Cover 1 brackets the inside: the free safety takes only
  // the verticals within BRACKET yd of the ball, and a wide receiver's man
  // plays him alone, on top (the end line is his deep help).
  const red = togoal <= RED_ZONE, wide = red ? BRACKET : Infinity;
  for (const id of ['DE1', 'DT1', 'DT2', 'DE2']) rush[id] = { lane: null, at: 0 };
  const blitz = (id, lane, side, gap, at = 0) => { rush[id] = { lane, side, gap, at }; delete jobs[id]; };
  const drop = (id, job) => { delete rush[id]; jobs[id] = job; };
  let men = [];
  const e = call.side * s;   // the call's side (drop side, cloud side) on the field
  switch (call.coverage) {
    case 'cover3':
      if (call.variant === 'cloud') {
        jobs[R.cb(e)] = under('flat', e * 23, 5); jobs[R.safety(e)] = third(e);
        jobs[R.safety(-e)] = third(0, postShade(lay)); jobs[R.cb(-e)] = third(-e);
        jobs[R.ol(e)] = under('curl', e * 9, 9); jobs[R.mike] = under('hook', -e * 4, 9); jobs[R.ol(-e)] = under('curlflat', -e * 13, 7);
      } else {
        jobs[R.cb(-s)] = third(-s); jobs[R.cb(s)] = third(s); jobs.FS = third(0, postShade(lay));
        jobs[R.will] = under('curlflat', -s * 13, 7); jobs[R.mike] = under('hook', -s * 4, 9);
        if (call.variant === 'buzz') { jobs.SS = under('hook', s * 5, 9); jobs[R.sam] = under('curlflat', s * 13, 7); }
        else { jobs[R.sam] = under('hook', s * 5, 9); jobs.SS = under('curlflat', s * 13, 7); }
      }
      if (call.spy) jobs[R.mike] = { kind: 'spy' };
      break;
    case 'cover1': {
      jobs.FS = { ...deep(postShade(lay), 17, -wide, wide), free: true };
      // From a two-high look the strong safety is 12 yd deep: too far to
      // reach a slot in time, so he comes down to the robber's job and the
      // linebackers and corners take the five receivers.
      const down = call.shell === 'two-high';
      const pool = down ? ['CB1', 'CB2', 'LB1', 'LB2', 'LB3'] : ['CB1', 'CB2', 'SS', 'LB1', 'LB2', 'LB3'], map = matchMan(pool, lay, s, who);
      let extra = down ? 'SS' : pool.find(id => !map.has(id));
      // A spy is a linebacker: when a defensive back is the man left over
      // (a nickel back took the slot), he takes the Mike's man instead.
      if (call.variant === 'spy' && extra && who[extra].role !== 'lb' && map.has(R.mike) && who[R.mike].role === 'lb') {
        map.set(extra, map.get(R.mike)); map.delete(R.mike); extra = R.mike;
      }
      men = [...map.keys()];
      if (call.variant === 'pressure' && extra) blitz(extra, extra === 'SS' ? 'edge' : 'blitz', extra === 'SS' ? s : -s, 'A');
      else if (extra) jobs[extra] = call.variant === 'spy' ? { kind: 'spy' } : { kind: 'rat', x: down ? s * 3 : 0, depth: 9 };
      for (const [d, r] of map) jobs[d] = { kind: 'man', id: r };
      break;
    }
    case 'cover2': case 'tampa2': {
      const tampa = call.coverage === 'tampa2';
      jobs[R.safety(-s)] = half(-s); jobs[R.safety(s)] = half(s);
      jobs.CB1 = under('flat', -23, 5); jobs.CB2 = under('flat', 23, 5);
      // The hooks wall #2's seam (see coverage.js) and carry it to the half.
      jobs.LB1 = { ...under('hook', tampa ? -10 : -8, tampa ? 10 : 11), seam: true }; jobs.LB3 = { ...under('hook', tampa ? 10 : 8, tampa ? 10 : 11), seam: true };
      jobs.LB2 = tampa ? { kind: 'under', role: 'pole', x: 0, depth: 12 } : under('hole', 0, 12);
      break;
    }
    case 'cover4':
      for (const side of [-1, 1]) { jobs[R.cb(side)] = quarter('corner', side); jobs[R.safety(side)] = quarter('safety', side); }
      jobs.LB1 = under('curlflat', -12, 7); jobs.LB3 = under('curlflat', 12, 7); jobs.LB2 = under('hook', s, 9);
      break;
    case 'cover6':
      jobs[R.cb(s)] = quarter('corner', s); jobs.SS = quarter('safety', s);
      // The weak half reaches 6 yd past the ball, over a trips #3 up the seam.
      jobs[R.cb(-s)] = under('flat', -s * 23, 5); jobs.FS = { ...half(-s), lo: s > 0 ? -Infinity : -6, hi: s > 0 ? 6 : Infinity };
      jobs[R.sam] = under('curlflat', s * 12, 7); jobs[R.mike] = under('hook', s * 3, 9); jobs[R.will] = under('curl', -s * 9, 10);
      break;
    case 'man': {
      jobs[R.safety(-s)] = half(-s); jobs[R.safety(s)] = half(s);
      const map = matchMan(['CB1', 'CB2', 'LB1', 'LB2', 'LB3'], lay, s, who);
      men = [...map.keys()];
      for (const [d, r] of map) jobs[d] = { kind: 'man', id: r };
      break;
    }
    case 'blitz': {
      // Six rushers: the four linemen and two more; the other five play man
      // with no help. A corner comes only when his #1 is close enough to the
      // ball for a safety to roll over him; otherwise a linebacker and the
      // strong safety come.
      let variant = call.variant;
      const weakOne = lay.nums[-s][0];
      if (variant === 'corner' && !(weakOne && Math.abs(lay.at[weakOne].x) < 14)) variant = 'lbSafety';
      call.played = variant;
      if (variant === 'doubleA') { blitz(R.mike, 'blitz', s, 'A'); blitz(R.will, 'blitz', -s, 'A'); }
      else if (variant === 'edge') { blitz(R.sam, 'edge', s); blitz(R.will, 'edge', -s); }
      else if (variant === 'corner') { blitz(R.cb(-s), 'edge', -s); blitz(R.mike, 'blitz', -s, 'A'); }
      else { blitz(R.mike, 'blitz', -s, 'A'); blitz('SS', 'edge', s); }
      const pool = ['CB1', 'CB2', 'FS', 'SS', 'LB1', 'LB2', 'LB3'].filter(id => !rush[id]), map = matchMan(pool, lay, s, who);
      men = [...map.keys()];
      for (const [d, r] of map) jobs[d] = { kind: 'man', id: r };
      for (const id of pool) if (!map.has(id)) jobs[id] = { kind: 'rat', x: 0, depth: 8 };
      break;
    }
    case 'firezone':
      // Five rush, three under, three deep: a lineman drops into the seam or
      // the hook and two second-level men come. A dropping lineman takes a
      // drop he can make in time (DROP yd deep), and every zone goes to the
      // man nearest it: the tackle's gap to the Mike, the edges' seams to the
      // men already on that side.
      jobs.CB1 = third(-1); jobs.CB2 = third(1); jobs.FS = third(0, postShade(lay));
      if (call.variant === 'tackle') {
        drop(R.dt(e), under('hook', e * 2, DROP.hook));
        blitz(R.mike, 'blitz', e, 'A'); blitz(R.sam, 'edge', s);
        jobs[R.will] = under('seamflat', -s * 10, 7); jobs.SS = under('seamflat', s * 10, 7);
      } else if (call.variant === 'safety') {
        drop(R.de(e), under('seamflat', e * 10, DROP.seam));
        blitz('SS', 'edge', e); blitz(R.ol(e), 'blitz', e, 'B');
        jobs[R.mike] = under('hook', 0, 9); jobs[R.ol(-e)] = under('seamflat', -e * 10, 7);
      } else {
        drop(R.de(e), under('seamflat', e * 10, DROP.seam));
        blitz(R.ol(e), 'edge', e); blitz(R.mike, 'blitz', e, 'B');
        jobs.SS = under('hook', s * 2, 9); jobs[R.ol(-e)] = under('seamflat', -e * 10, 7);
      }
      break;
    case 'creeper': {
      // Four rush and seven cover: a lineman drops and a second-level man
      // replaces him in the rush, sometimes on a delay.
      jobs.CB1 = third(-1); jobs.CB2 = third(1); jobs.FS = third(0, postShade(lay));
      const at = call.delay;
      if (call.variant === 'tackle') {
        drop(R.dt(e), call.spy ? { kind: 'spy' } : under('hole', 0, DROP.hook));
        blitz(R.mike, 'blitz', e, 'A', at);
        jobs[R.will] = under('curlflat', -s * 13, 7); jobs[R.sam] = under('curlflat', s * 13, 7); jobs.SS = under('hook', s * 5, 9);
      } else if (call.variant === 'safety') {
        drop(R.de(e), under('curlflat', e * 12, 6));
        blitz('SS', 'edge', e, undefined, at);
        jobs[R.ol(e)] = under('hook', e * 5, 9); jobs[R.mike] = under('hook', -e * 3, 9); jobs[R.ol(-e)] = under('curlflat', -e * 13, 7);
      } else {
        drop(R.de(e), under('curlflat', e * 12, 6));
        // One hook each side whatever the call side: the Mike weak, the
        // strong safety strong.
        blitz(R.ol(e), 'edge', e, undefined, at);
        jobs[R.mike] = under('hook', -s * 3, 9); jobs[R.ol(-e)] = under('curlflat', -e * 13, 7); jobs.SS = under('hook', s * 5, 9);
      }
      break;
    }
  }
  return manTechnique(call, lay, { jobs, rush, men }, wide, postShade(lay));
}

// Man technique from the call: press or off, inside or outside leverage,
// trailing with help over the top or staying on top with none. In Cover 1
// the only help is the free safety in the middle (`free`, his x): a
// receiver split wider than FREE_REACH yd from him has none (2-man has a
// half over everybody, Cover 0 nobody).
function manTechnique(call, lay, plan, wide, free) {
  const { jobs, men } = plan;
  for (const id of men) {
    const r = lay.at[jobs[id].id];
    const help = call.coverage === 'blitz' ? false : call.coverage === 'cover1' ? !!r && Math.abs(r.x - free) < Math.min(FREE_REACH, wide) : true;
    Object.assign(jobs[id], { press: id.startsWith('CB') && cornerPlay(call, lay, id === 'CB1' ? -1 : 1) === 'press', lev: call.lev, help, cushion: 4, jam: call.jam });
  }
  // Against a bunch, the men on it banjo: they settle who takes whom by
  // the release (in, out and up) instead of chasing through the traffic.
  if (lay.bunch && men.length) {
    const group = men.filter(id => lay.bunch.ids.includes(jobs[id].id));
    if (group.length >= 2) for (const id of group) jobs[id].banjo = true;
  }
  return plan;
}

// The goal-line package (5-3-3): the five linemen rush (the nose tackle
// plays the free safety's spot), the strong safety is the only deep man and
// the end line is his help. Cover 1: the Sam, the Mike, the Will and the
// corners take the five receivers, the strong safety brackets the inside.
// Cover 0: six cover five, so the one left over comes. Cover 3 (compressed
// by the end line): corners and the strong safety in thirds, the outside
// linebackers in the curl-flats and the Mike in the hook.
function goalAssignments(call, lay, togoal, who) {
  const s = lay.strength, R = roles(s), jobs = {}, rush = {};
  for (const id of ['DE1', 'DT1', 'FS', 'DT2', 'DE2']) rush[id] = { lane: null, at: 0 };
  const wide = togoal <= RED_ZONE ? BRACKET : Infinity;
  let men = [];
  call.played = null;
  if (call.coverage === 'cover3') {
    jobs.CB1 = third(-1); jobs.CB2 = third(1); jobs.SS = third(0);
    jobs[R.sam] = under('curlflat', s * 12, 5); jobs[R.will] = under('curlflat', -s * 12, 5);
    jobs[R.mike] = call.spy ? { kind: 'spy' } : under('hook', 0, 6);
  } else {
    const blitz = call.coverage === 'blitz';
    const pool = blitz ? ['CB1', 'CB2', 'SS', 'LB1', 'LB2', 'LB3'] : ['CB1', 'CB2', 'LB1', 'LB2', 'LB3'], map = matchMan(pool, lay, s, who);
    men = [...map.keys()];
    for (const [d, r] of map) jobs[d] = { kind: 'man', id: r };
    for (const id of pool) {
      if (map.has(id)) continue;
      if (!blitz) { jobs[id] = { kind: 'rat', x: 0, depth: 5 }; continue; }
      // The man left over comes: off the edge from the Sam's spot on the
      // line or from the secondary, else through the B gap behind the
      // tackles.
      const side = id === R.will ? -s : id === R.mike ? (lay.at.R?.x < 0 ? -1 : 1) : s;
      rush[id] = id === R.mike || id === R.will ? { lane: 'blitz', side, gap: 'B', at: 0 } : { lane: 'edge', side: id === 'CB1' ? -1 : id === 'CB2' ? 1 : side, at: 0 };
    }
    if (!blitz) jobs.SS = { ...deep(0, 12, -wide, wide), free: true };
  }
  return manTechnique(call, lay, { jobs, rush, men }, wide, 0);
}

// The landmark a job heads for first, to judge how far a man rotates.
function landmark(job, show, lay) {
  if (!job) return show;
  if (job.kind === 'deep') return { x: job.x, z: Math.min(job.depth, 15) };
  if (job.kind === 'under' || job.kind === 'rat') return { x: job.x, z: job.depth };
  if (job.kind === 'quarter') return { x: job.side * (job.role === 'corner' ? 16 : 8), z: job.role === 'corner' ? 9 : 11 };
  if (job.kind === 'man' && lay.at[job.id]) return { x: lay.at[job.id].x, z: 2 };
  if (job.kind === 'spy') return { x: 0, z: 5 };
  return show;
}

// Where everybody lines up: the shell the call shows, adjusted to the
// formation (corners on the #1s, outside linebackers apexed between the
// tackle and #2, men over their receivers, blitzers walked up in the mug).
// A nickel or dime back in a linebacker's spot aligns over #2 on his side;
// the fourth linebacker in the strong safety's spot stands in the box.
function showSpots(call, lay, plan, togoal) {
  if (call.package === 'goal') return goalSpots(call, lay, plan, togoal);
  const s = lay.strength, R = roles(s), { jobs, rush } = plan, shell = call.shell, spots = {}, who = lineup(call.package, s);
  const at = id => lay.at[id], inside = x => (x < 0 ? 1 : -1);
  const zone = job => !!job && (job.kind === 'under' || job.kind === 'spy' || job.kind === 'rat');
  const front = FRONTS[call.front].x, fx = s > 0 ? front : front.map((_, i) => -front[3 - i]);
  ['DE1', 'DT1', 'DT2', 'DE2'].forEach((id, i) => { spots[id] = { x: fx[i], z: 1.2 }; });
  // Of `ids`, the man whose drop from spot(id) to his landmark is shortest.
  const shortest = (ids, spot) => {
    let best = null;
    for (const id of ids) {
      const from = spot(id), aim = landmark(jobs[id], from, lay), trip = Math.hypot(aim.x - from.x, aim.z - from.z);
      if (!best || trip < best.trip) best = { id, spot: from, trip };
    }
    return best;
  };
  // Second-level rushers walk up to where they come from in the mug look;
  // from any other shell they come from depth. A gap man stacks behind a
  // lineman who already stands in his gap (a shaded tackle).
  const mug = shell === 'mug', walked = [];
  const gapSpot = (side, gap, z) => {
    const x = side * (gap === 'B' ? GAP.B : GAP.A);
    return { x, z: fx.some(l => Math.abs(l - x) < GAP.near) ? GAP.stack : z };
  };
  const rushSpot = (id, r) => {
    if (r.lane === 'edge') return { x: r.side * (Math.abs(fx[r.side < 0 ? 0 : 3]) + 1.7), z: 1.5 };
    return gapSpot(r.side, r.gap, 1.6);
  };
  // Linebackers: over a man's receiver, apexed in zone, or in the box.
  for (const id of ['LB1', 'LB2', 'LB3']) {
    const side = id === 'LB1' ? -1 : id === 'LB3' ? 1 : 0, job = jobs[id];
    if (rush[id] && mug) { spots[id] = rushSpot(id, rush[id]); walked.push(id); continue; }
    if (who[id].role !== 'lb') { spots[id] = slotSpot(lay, job, side); continue; }
    if (job?.kind === 'man' && at(job.id)) {
      const r = at(job.id), slot = lay.slot[job.id];
      spots[id] = slot === 'back' ? { x: r.x * 0.4 + side * 1.5, z: 4.8 } : { x: r.x + inside(r.x) * (slot === 'te' ? 0.6 : 1.3), z: slot === 'te' ? 4 : 4.5 };
      continue;
    }
    if (!side) { spots[id] = { x: s * 0.7, z: lay.heavy >= 4 ? 4.3 : 5.2 }; continue; }
    const two = lay.nums[side][1], r = two && at(two);
    if (r && Math.abs(r.x) > 7) spots[id] = { x: side * Math.min(9, Math.max(5.5, (3.6 + Math.abs(r.x)) / 2)), z: 4.5 };
    else if (r) spots[id] = { x: r.x + side * 0.6, z: 4.5 };
    else spots[id] = { x: side * 4.2, z: lay.heavy >= 4 ? 4.2 : 4.8 };
  }
  // From any other look a linebacker who rushes at the snap creeps up to
  // CREEP yd (a delayed rusher shows his drop); on a sugar call so does the
  // dropper with the shortest drop, so the depth gives nobody away.
  if (!mug) {
    for (const id of ['LB1', 'LB2', 'LB3']) if (rush[id] && !(rush[id].at > 0)) spots[id].z = Math.min(spots[id].z, CREEP);
    const dummy = call.sugar && shortest(['LB2', 'LB1', 'LB3'].filter(id => !rush[id] && zone(jobs[id])), id => ({ x: spots[id].x, z: Math.min(spots[id].z, CREEP) }));
    if (dummy) spots[dummy.id] = dummy.spot;
  }
  // The mug look always shows two men walked up, whether they come or not,
  // the men with the shortest drops first. Each walks up on his own side of
  // the ball (the Mike toward his drop, or the free side), in the A gap if
  // nobody stands in it, else the B gap.
  if (mug) {
    const free = side => !walked.some(w => spots[w].x * side > 0 && Math.abs(spots[w].x) < (GAP.A + GAP.B) / 2);
    const walkUp = id => {
      let side = id === 'LB1' ? -1 : id === 'LB3' ? 1 : 0;
      if (!side) {
        const aim = landmark(jobs[id], spots[id], lay), lean = Math.abs(aim.x) > 0.5 ? Math.sign(aim.x) : -s;
        side = free(lean) || !free(-lean) ? lean : -lean;
      }
      return gapSpot(side, free(side) ? 'A' : 'B', 1.7);
    };
    while (walked.length < 2) {
      const pick = shortest([R.mike, R.ol(-s), R.ol(s)].filter(id => !walked.includes(id) && zone(jobs[id]) && who[id].role === 'lb'), walkUp);
      if (!pick) break;
      spots[pick.id] = pick.spot; walked.push(pick.id);
    }
  }
  // Safeties by shell; a man safety in the mug or base look sits over his
  // man. A one-high free safety stands anywhere across the middle (the
  // call's `cheat`), whatever he plays after the snap.
  const safety = {
    'two-high': { SS: { x: s * 9.5, z: 12.5 }, FS: { x: -s * 9.5, z: 13 } },
    'one-high': { FS: { x: s * (ONE_HIGH.strong - (ONE_HIGH.strong + ONE_HIGH.weak) * call.cheat), z: 14 }, SS: { x: s * 6, z: 8.5 } },
    base: { FS: { x: -s * 5.5, z: 10.5 }, SS: { x: s * 6, z: 9.5 } },
    mug: { FS: { x: -s * 5.5, z: 10.5 }, SS: { x: s * 6, z: 9 } },
  }[shell];
  for (const id of ['FS', 'SS']) {
    const job = jobs[id];
    if (who[id].role === 'lb') spots[id] = boxSpot(lay, job, s, mug && rush[id] ? rushSpot(id, rush[id]) : null);
    else if (rush[id] && mug) spots[id] = rushSpot(id, rush[id]);
    // A safety who rushes from any other look creeps down to the box on
    // the side he comes from; on a roll call a strong safety with an
    // underneath job comes down as far, so the depth gives nobody away.
    else if (rush[id]) spots[id] = { x: rush[id].side * Math.abs(safety[id].x), z: Math.min(safety[id].z, SAFETY_CREEP) };
    else if (job?.kind === 'man' && at(job.id) && (mug || shell === 'base' || (shell === 'one-high' && id === 'SS'))) {
      const r = at(job.id);
      spots[id] = { x: r.x + inside(r.x) * 1.5, z: 6.5 };
    } else if (call.roll && id === 'SS' && zone(job) && (shell === 'one-high' || shell === 'base')) spots[id] = { ...safety[id], z: Math.min(safety[id].z, SAFETY_CREEP) };
    else spots[id] = { ...safety[id] };
    // In the red zone the shell compresses toward the goal line.
    spots[id].z = Math.min(spots[id].z, 4 + 0.5 * togoal);
  }
  cornerSpots(call, lay, plan, spots);
  return spots;
}

// Corners on #1: pressed on a press call and always in the mug look,
// squatting in the flat (Cover 2 corners, unless shown one-high), or off;
// outside leverage in zone, the call's leverage in man. Against a #1 inside
// TIGHT yd the corner stands at least 3.5 yd off (and plays off; see
// cornerPlay).
function cornerSpots(call, lay, { jobs, rush }, spots) {
  const mug = call.shell === 'mug';
  for (const side of [-1, 1]) {
    const id = side < 0 ? 'CB1' : 'CB2', job = jobs[id], one = lay.nums[side][0], r = one ? lay.at[one] : { x: side * 18 };
    const man = job?.kind === 'man', press = call.press || mug;
    const shade = man ? (call.lev === 'outside' ? side : -side) : side;
    let z = press ? 1.4 : job?.kind === 'under' && call.shell !== 'one-high' ? 4.5 : man ? 6.5 : 7;
    if (rush[id]) z = mug ? 2.5 : 4;
    const x = r.x + shade * (press ? 0.6 : 1.2);
    spots[id] = { x, z: Math.abs(r.x) < TIGHT ? Math.max(z, 3.5) : z };
  }
}

// A nickel or dime back in a linebacker's spot (`side` -1 or 1): over his
// man, else just inside #2 on his side at SLOT_DEPTH yd (over a tight end,
// outside his shoulder), else halfway to where #2 would be.
const SLOT_DEPTH = 5.5;
function slotSpot(lay, job, side) {
  const inside = x => (x < 0 ? 1 : -1);
  if (job?.kind === 'man' && lay.at[job.id]) {
    const r = lay.at[job.id];
    return lay.slot[job.id] === 'back' ? { x: r.x * 0.4 + side * 2, z: 5 } : { x: r.x + inside(r.x) * 1.0, z: lay.slot[job.id] === 'te' ? 4.5 : SLOT_DEPTH };
  }
  const two = lay.nums[side][1], r = two && lay.at[two];
  if (r && Math.abs(r.x) > 7) return { x: r.x + inside(r.x) * 1.2, z: SLOT_DEPTH };
  if (r) return { x: r.x + side * 1.5, z: 4.8 };
  return { x: side * 6, z: SLOT_DEPTH };
}
// The fourth linebacker in the strong safety's spot: in the box outside the
// strong tackle (BOX_LB), over his man when he has one, or where he rushes
// from in the mug look.
const BOX_LB = { x: 3.2, z: 4.2 };
function boxSpot(lay, job, s, rushing) {
  if (rushing) return rushing;
  if (job?.kind === 'man' && lay.at[job.id]) {
    const r = lay.at[job.id];
    return lay.slot[job.id] === 'back' ? { x: s * 2.2, z: 4.6 } : { x: r.x - Math.sign(r.x || 1) * 1.0, z: 4.3 };
  }
  return { x: s * BOX_LB.x, z: BOX_LB.z };
}

// The goal-line package's spots. The five linemen and the Sam stand in the
// six gaps (GOAL_FRONT: A, B and C, x yd from the ball), the Mike and the
// Will stack STACK yd off behind the guards, the strong safety sits at or
// just past the goal line, the corners press. A man on a receiver split out
// stands over him.
const GOAL_FRONT = { name: 'Gap', A: 0.85, B: 2.4, C: 4.0, stack: 1.6, z: 3.2, box: 4.5 };
function goalSpots(call, lay, plan, togoal) {
  const s = lay.strength, R = roles(s), { jobs, rush } = plan, spots = {}, inside = x => (x < 0 ? 1 : -1);
  const G = GOAL_FRONT, xs = [-G.C, -G.B, -G.A, G.A, G.B];
  ['DE1', 'DT1', 'FS', 'DT2', 'DE2'].forEach((id, i) => { spots[id] = { x: s > 0 ? xs[i] : -xs[4 - i], z: 1.2 }; });
  for (const id of ['LB1', 'LB2', 'LB3']) {
    const job = jobs[id], r = job?.kind === 'man' && lay.at[job.id], slot = r && lay.slot[job.id];
    if (id === R.sam && (!r || slot === 'te' || slot === 'back' || Math.abs(r.x) < G.C + 2)) spots[id] = { x: s * G.C, z: 1.3 };
    else if (r && slot !== 'back' && Math.abs(r.x) > G.box) spots[id] = { x: r.x + inside(r.x) * 0.8, z: G.z };
    else spots[id] = { x: (id === R.will ? -s : s) * G.stack, z: G.z };
  }
  // The strong safety: over his man, or in the middle (anywhere across it,
  // the call's `cheat`) one-high, or shaded weak in the mug look; never more
  // than half the field to the goal line plus 4 yd deep, nor 3 yd past the
  // goal line.
  const job = jobs.SS, r = job?.kind === 'man' && lay.at[job.id];
  spots.SS = rush.SS ? { x: rush.SS.side * 5, z: 4 } : r ? { x: r.x + inside(r.x) * 1.5, z: 5 }
    : call.shell === 'one-high' ? { x: s * (ONE_HIGH.strong - (ONE_HIGH.strong + ONE_HIGH.weak) * call.cheat), z: 9 } : { x: -s * 2, z: 6 };
  spots.SS.z = Math.min(spots.SS.z, 4 + 0.5 * togoal, togoal + 3);
  cornerSpots(call, lay, plan, spots);
  return spots;
}

// The defenders' specs for this call against a formation: the plan is made
// by base spot, then each spot's player (lineup) takes its job.
function alignment(call, formation, spot) {
  const togoal = 110 - spot, lay = readFormation(formation), plan = assignments(call, lay, togoal);
  const spots = showSpots(call, lay, plan, togoal), { jobs, rush } = plan, who = lineup(call.package, lay.strength);
  call.layout = lay; call.men = plan.men.map(id => who[id].id);
  call.rushers = SPOTS.filter(id => rush[id]).map(id => who[id].id);
  call.banjo = plan.men.filter(id => jobs[id].banjo).map(id => who[id].id);
  call.players = SPOTS.map(id => who[id].id);
  call.corners = [-1, 1].map(side => cornerPlay(call, lay, side));
  call.delayAt = 0;
  // A late rotation holds only the men who are part of the disguise: those
  // who stand somewhere else in the family's natural look.
  const late = call.timing === 'late';
  const natural = late ? showSpots({ ...call, shell: call.natural }, lay, plan, togoal) : spots;
  const placed = [];
  return SPOTS.map((id, i) => {
    const spec = who[id], show = spots[id], [jx, jz] = call.jitter[i];
    const x = show.x + jx;
    let z = Math.min(Math.max(0.8, show.z + jz), 118 - spot);
    // Nobody starts on top of a man already placed (the jitter can put a
    // gap man on the lineman beside him): he steps back to SPACE yd apart.
    for (const p of placed) {
      const dx = x - p.x;
      if (Math.hypot(dx, z - p.z) < SPACE) z = Math.min(p.z + Math.sqrt(SPACE * SPACE - dx * dx), 118 - spot);
    }
    placed.push({ x, z });
    const r = rush[id] ? { ...rush[id] } : null, job = jobs[id] || null;
    // A delayed rusher who shows DELAY.deep yd off or more waits at most
    // DELAY.most s: a longer count from there never reaches the passer.
    if (r && r.at > 0 && show.z >= DELAY.deep) r.at = Math.min(r.at, DELAY.most);
    if (r && r.at > 0) call.delayAt = r.at;
    // When he leaves his show for his job: at his get-off, or after the held
    // look on a late rotation (only for a man the disguise moved, and only
    // for a trip under 10 yd: nobody holds a look he cannot rotate out of
    // in time); a lineman who drops fakes a rush step first; a delayed
    // rusher holds his spot until his count.
    const get = GET_OFF[spec.role], aim = landmark(job, show, lay), moved = Math.hypot(aim.x - show.x, aim.z - show.z);
    const disguised = Math.hypot(show.x - natural[id].x, show.z - natural[id].z) > SHOWN;
    let rotate = { at: get, crossover: moved > 6 };
    if (spec.role === 'dl' && job) rotate = { at: get + 0.25, fake: true };
    else if (r && r.at > 0) rotate = { at: r.at };
    else if (late && disguised && job && job.kind !== 'man' && moved > 4 && moved < 10) rotate.at = get + call.hold;
    const delayed = r && r.at > 0;
    return {
      ...spec, x, z, rushing: !!r && !delayed, rush: r && (r.lane || delayed) ? { lane: r.lane || 'inside', side: r.side ?? Math.sign(show.x || 1), gap: r.gap, at: r.at } : undefined,
      assign: delayed ? { kind: 'hold' } : job, rotate,
    };
  });
}

// --------------------------------------------------------------------------
// The scouting report: what the defense has seen of the offense this
// session. Counts decay by DECAY a rep, so recent reps weigh most.
const DECAY = 0.97;
function newScout() {
  return {
    run: 0, pass: 0, form: {}, throws: 0, throwTime: 0, scrambles: 0,
    slots: { outside: 0, slot: 0, te: 0, back: 0 }, deep: 0, deepWin: 0, fam: {},
  };
}

// Tendencies from the report, each pulled toward a neutral prior while the
// sample is small, and scaled by the difficulty's `scout` (0 at Rookie).
function tendencies(scout, formationId, weight) {
  const n = scout.run + scout.pass, run = (scout.run + 1.6) / (n + 4);
  const f = scout.form[formationId], formRun = f ? (f.run + run * 3) / (f.run + f.pass + 3) : run;
  const throwTime = (scout.throwTime + 2.6 * 2) / (scout.throws + 2);
  const deep = scout.deepWin / (scout.pass + 4), scramble = scout.scrambles / (scout.pass + 4);
  const total = Object.values(scout.slots).reduce((a, b) => a + b, 0);
  let favourite = null;
  for (const [k, v] of Object.entries(scout.slots)) if (v > 2.5 && v > 0.4 * total && (!favourite || v > scout.slots[favourite])) favourite = k;
  const all = Object.values(scout.fam).reduce((a, b) => ({ n: a.n + b.n, win: a.win + b.win }), { n: 0, win: 0 });
  const rate = (all.win + 0.45 * 2) / (all.n + 2), beaten = {};
  for (const [k, v] of Object.entries(scout.fam)) if (v.n >= 2) beaten[k] = (v.win + rate * 2) / (v.n + 2) - rate;
  return {
    weight, run: formRun, runBias: Math.max(-1, Math.min(1, (formRun - 0.4) / 0.4)) * weight,
    quick: Math.max(0, Math.min(1, (2.5 - throwTime) / 0.7)) * weight, slow: Math.max(0, Math.min(1, (throwTime - 2.9) / 0.8)) * weight,
    deep: Math.min(1.5, deep * 5) * weight, scramble: Math.min(1, scramble / 0.15) * weight,
    favourite: weight > 0 ? favourite : null, beaten, rate,
  };
}

// Family weights for this situation, normalised, with FLOOR and CAP, over
// the families the difficulty's menu and the package both have.
function familyWeights(skill, sim, tend, pkg = 'base') {
  const can = PACKAGES[pkg]?.families, near = 110 - sim.spot <= PERSONNEL.goal && pkg !== 'base';
  const menu = (MENUS[skill.menu] || MENUS.pro).filter(f => (!can || can.includes(f)) && !(near && CRAMPED.includes(f))), toGo = sim.toGo, togoal = 110 - sim.spot, floor = FLOOR / menu.length;
  const downs = sim.config.mode === 'drive' || sim.down > 1 || toGo < 10
    ? (toGo <= 2 && (sim.down > 1 || togoal <= 2) ? DOWNS.short : sim.down >= 3 && toGo >= 7 ? DOWNS.long : sim.down >= 3 && toGo >= 3 ? DOWNS.medium : sim.down === 2 && toGo >= 8 ? DOWNS.second : null)
    : null;
  const field = togoal <= 5 ? FIELD.goal : togoal <= 20 ? FIELD.red : sim.spot <= 20 ? FIELD.backed : null;
  const fit = FITS[sim.play.formationId] || {};
  const w = {};
  for (const f of menu) {
    let v = BASE[f] * ((downs?.[f] ?? 1) * (field?.[f] ?? 1) * (fit[f] ?? 1)) ** skill.situ;
    // The scouting report: the box against a running offense, two deep
    // safeties against deep completions, press and man against a quick
    // game, pressure against a quarterback who holds the ball, fewer
    // blitzes against one who scrambles, and less of what he has beaten.
    const box = f === 'cover3' || f === 'cover1' || f === 'blitz' || f === 'firezone';
    v *= 1 + (box ? 0.45 : TWO_HIGH.has(f) && f !== 'cover4' ? -0.35 : 0) * tend.runBias;
    v *= 1 + (TWO_HIGH.has(f) ? 0.6 : f === 'blitz' ? -0.4 : f === 'firezone' ? -0.2 : 0) * tend.deep;
    v *= 1 + ({ cover1: 0.3, man: 0.3, cover2: 0.2, blitz: -0.3, firezone: -0.2 }[f] || 0) * tend.quick;
    v *= 1 + ({ blitz: 0.4, firezone: 0.4, creeper: 0.3 }[f] || 0) * tend.slow;
    v *= 1 + ({ blitz: -0.25, man: -0.2 }[f] || 0) * tend.scramble;
    const fav = { outside: { cover2: 0.2, cover6: 0.15 }, slot: { cover4: 0.2, cover1: 0.1 }, te: { tampa2: 0.2, cover3: 0.1 }, back: { cover1: 0.15, man: 0.1 } }[tend.favourite];
    v *= 1 + (fav?.[f] || 0);
    if (tend.beaten[f] !== undefined) v *= 1 + tend.weight * (Math.max(0.55, Math.min(1.6, 1 - 1.8 * tend.beaten[f])) - 1);
    w[f] = Math.max(1e-6, v);
  }
  // Normalise, then lift anything under the floor and trim anything over the
  // cap, taking the difference from (or giving it to) the rest in proportion.
  for (let pass = 0; pass < 3; pass++) {
    const sum = Object.values(w).reduce((a, b) => a + b, 0);
    for (const f of menu) w[f] /= sum;
    const low = menu.filter(f => w[f] < floor), high = menu.filter(f => w[f] > CAP);
    if (!low.length && !high.length) break;
    for (const f of low) w[f] = floor;
    for (const f of high) w[f] = CAP;
    const fixed = [...low, ...high], rest = menu.filter(f => !fixed.includes(f));
    const left = 1 - fixed.reduce((a, f) => a + w[f], 0), restSum = rest.reduce((a, f) => a + w[f], 0);
    for (const f of rest) w[f] = restSum > 0 ? w[f] * left / restSum : left / rest.length;
  }
  return w;
}

// A generator for the details of a call, seeded by two draws from the
// simulation's stream (mulberry32), so the call takes no more numbers from
// the stream than it always has.
function derived(a, b) {
  let t = (Math.floor(a * 4294967296) ^ Math.imul(Math.floor(b * 4294967296) | 0, 0x9E3779B1) ^ 0x5BD1E995) >>> 0;
  return () => {
    t = (t + 0x6D2B79F5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), t | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

// One draw from a table of weights, in the table's own order.
function choose(table, u) {
  const keys = Object.keys(table), sum = keys.reduce((a, k) => a + table[k], 0);
  let acc = 0;
  for (const k of keys) { acc += table[k] / sum; if (u < acc) return k; }
  return keys[keys.length - 1];
}

export const defense = {
  // The call for a new rep: the family and its variant, the shell it shows
  // and how it rotates, the front, press or off, leverage and any spy. It
  // reads the situation (down, distance, field position), the formation
  // (never the play itself), the difficulty and the scouting report. Every
  // call takes 23 numbers from the seeded stream (24 for a random call) in
  // the same order, whatever it decides, so reps stay deterministic.
  callDefense() {
    const level = DIFFICULTY[this.config.difficulty] ? this.config.difficulty : 'pro', skill = DIFFICULTY[level];
    // From the seeded stream: the family (a random call only), the front and
    // each man's jitter, the same numbers in the same order as ever; the rest
    // of the call from a generator seeded by those draws.
    const asked = this.config.coverage, fixed = asked !== 'random' && COVERAGES[asked] && FAMILIES.includes(asked);
    const familyDraw = fixed ? 0 : this.random(), frontDraw = this.random();
    const jitter = DEFENSE.map(() => [(this.random() - 0.5) * 0.8, (this.random() - 0.5) * 0.7]);
    const next = derived(frontDraw, familyDraw), u = [];
    for (let i = 0; i < DRAWS; i++) u.push(next());
    const scout = this.scout ||= newScout();
    const tend = tendencies(scout, this.play.formationId, skill.scout);
    const togoal = 110 - this.spot, short = this.toGo <= 2 && (this.down > 1 || togoal <= 2), long = this.down >= 3 && this.toGo >= 7;
    // The personnel package (see PERSONNEL): the match for the formation
    // and the situation situ² of the time, else the base; a running offense
    // keeps the base against three wide, a passing one draws the nickel. A
    // fixed coverage the package cannot play is played from the base. A
    // package named in the config (`personnel`, a PACKAGES key) is played
    // every rep.
    const ideal = matchPackage(readFormation(formationFor(this.play)), this.down, this.toGo, togoal, short);
    let match = skill.situ ** 2;
    if (ideal === 'nickel' || ideal === 'dime') match *= 1 - PERSONNEL.run * Math.max(0, tend.runBias);
    let pkg = u[14] < match ? ideal : 'base';
    if (ideal === 'base' && !short && u[14] < PERSONNEL.pass * Math.max(0, -tend.runBias)) pkg = 'nickel';
    if (PACKAGES[this.config.personnel]) pkg = this.config.personnel;
    if (fixed && PACKAGES[pkg].families && !PACKAGES[pkg].families.includes(asked)) pkg = 'base';
    const weights = familyWeights(skill, this, tend, pkg);
    const family = fixed ? asked : choose(weights, familyDraw);
    // Variant, with the report's say: a sky rotation against the run, buzz
    // against tight end targets, cloud against outside targets; Cover 1
    // pressure on passing downs and against a quarterback who holds the ball.
    let variant = null;
    if (VARIANTS[family] && pkg !== 'goal') {
      const table = { ...VARIANTS[family] };
      // One safety: no cloud (its safety takes a deep third outside).
      if (pkg === 'heavy' && family === 'cover3') table.cloud = 0;
      if (family === 'cover3') {
        table.sky *= 1 + 0.5 * Math.max(0, tend.runBias);
        if (tend.favourite === 'te') table.buzz *= 1.6;
        if (tend.favourite === 'outside') table.cloud *= 1.8;
      }
      if (family === 'cover1') { table.pressure *= (long ? 1.6 : 1) * (1 + tend.slow); table.spy *= 1 + 3 * tend.scramble; }
      variant = choose(table, u[1]);
    }
    const side = u[2] < 0.5 ? 1 : -1;   // strength (1) or weak side (-1)
    const spy = (family === 'cover3' || (family === 'creeper' && variant === 'tackle')) && u[3] < 0.04 + 0.4 * tend.scramble;
    // The shell: the natural look, or a disguise. Deep completions bring more
    // two-high looks; short yardage shows more of the mug and the one-high
    // box, passing downs more two-high and pressure looks.
    const list = SHELLS[variant === 'cloud' ? 'cloud' : family].filter(sh => makeable(family, variant, sh, side, pkg)), shells = {};
    list.forEach((sh, i) => {
      let w = i === 0 ? 1 - skill.disguise : skill.disguise * SHELL_WEIGHT[sh] / list.slice(1).reduce((a, k) => a + SHELL_WEIGHT[k], 0);
      // A pressure rotates down from two-high slowest: shown less often.
      if (sh === 'two-high') w *= (1 + tend.deep) * (short ? 0.6 : long ? 1.4 : 1) * (family === 'firezone' || family === 'creeper' ? PRESSURE_TWO_HIGH : 1);
      if (sh === 'mug') w *= short ? 1.6 : long ? 1.3 : 1;
      if (sh === 'one-high') w *= short ? 1.3 : 1;
      shells[sh] = w;
    });
    const total = Object.values(shells).reduce((a, b) => a + b, 0);
    for (const sh in shells) shells[sh] /= total;
    const shell = choose(shells, u[4]), disguised = shell !== list[0];
    const timing = disguised && u[5] < skill.late ? 'late' : 'snap', hold = skill.hold + 0.15 * u[6];
    const red = togoal <= RED_ZONE;
    // At the goal line the corners always press.
    const press = pkg === 'goal' || u[7] < Math.min(0.9, PRESS[family] + (MAN_FAMILIES.has(family) ? 0 : skill.press) + 0.2 * tend.quick + (red ? 0.2 : 0) - (TWO_HIGH.has(family) ? 0 : 0.15 * tend.deep));
    const lev = u[8] < (OUTSIDE[family] ?? 0.5) ? 'outside' : 'inside';
    const fronts = FRONTS.map((f, i) => (long && i === 3 ? 2 : short && i === 0 ? 1.5 : short && i === 3 ? 0.5 : 1));
    const front = Number(choose(Object.fromEntries(fronts.map((w, i) => [i, w])), frontDraw));
    const delay = family === 'creeper' && u[10] >= 0.45 ? 0.3 + 0.5 * u[11] : 0;
    const jam = 0.3 + 0.2 * u[12];
    // Disguise at depth (SUGAR) and the one-high free safety's spot.
    const sugar = u[13] < SUGAR * skill.disguise, roll = u[0] < SUGAR * skill.disguise, cheat = u[9];
    this.call = {
      package: pkg, natural: list[0], coverage: family, variant, side, spy, shell, disguised, timing, hold, press, lev, front, delay, jam, sugar, roll, cheat, jitter,
      bracket: tend.favourite, weights, looks: shells, situation: { down: this.down, toGo: this.toGo, spot: this.spot },
      // Filled in by alignDefense against the formation.
      layout: null, men: [], rushers: [], banjo: [], corners: [], players: [], delayAt: 0, played: variant, description: '', rep: null,
    };
    this.coverage = family;
    this.personnel = pkg;
    this.defensiveFront = pkg === 'goal' ? GOAL_FRONT.name : FRONTS[front].name;
  },

  // The defenders' specs for this rep against the offense's formation: man
  // defenders travel with their assignments when the offense changes
  // formation, including an audible; the called family, shell and front stay.
  // No random draws, so an adjustment never changes the look by itself.
  alignDefense(formation) {
    const call = this.call;
    const specs = alignment(call, formation, this.spot);
    call.rep = { jams: new Set(), throwAt: null, scrambled: false, banjoAt: null };
    call.description = describe(call);
    return specs;
  },

  // Per-rep defensive state once the players exist: reaction latency (on a
  // designed run, how late he reads the carrier), when he reads a run
  // (linemen at once, then linebackers, safeties and corners; sooner against
  // an offense that runs a lot), his run-fit discipline (sim/run.js) and how
  // long a play fake holds him.
  initDefender(d) {
    const skill = this.skill, tend = this.scout ? tendencies(this.scout, this.play.formationId, skill.scout) : { runBias: 0 };
    d.latency = this.play.type === 'run' ? skill.carrier ?? skill.latency : skill.latency;
    d.rotate ||= { at: 0 };
    const lag = { dl: d.latency + 0.1, lb: skill.runRead, s: skill.runRead + 0.15, cb: skill.runRead + 0.3 }[d.role];
    d.readRun = d.role === 'dl' ? lag : lag - 0.12 * tend.runBias;
    this.runDiscipline(d);
    const fake = skill.bite * (1 + 0.6 * tend.runBias);
    d.bite = d.rushing || !d.assign || d.assign.kind === 'man' && d.role !== 'lb' ? 0
      : d.role === 'lb' ? GET_OFF.lb + fake : d.role === 's' && d.start.z - this.spot < 11 ? GET_OFF.s + 0.5 * fake : 0;
  },

  // The rep is over: file what the offense did. The play type, target and
  // throw are things the defense saw happen, never the call before the snap.
  noteResult(result) {
    const call = this.call, scout = this.scout ||= newScout();
    if (!call || !call.rep || !this.stats.reps) return;
    for (const k of ['run', 'pass', 'throws', 'throwTime', 'scrambles', 'deep', 'deepWin']) scout[k] *= DECAY;
    for (const k in scout.slots) scout.slots[k] *= DECAY;
    for (const v of Object.values(scout.form)) { v.run *= DECAY; v.pass *= DECAY; }
    for (const v of Object.values(scout.fam)) { v.n *= DECAY; v.win *= DECAY; }
    const run = this.play.type === 'run', form = scout.form[this.play.formationId] ||= { run: 0, pass: 0 };
    scout[run ? 'run' : 'pass']++; form[run ? 'run' : 'pass']++;
    if (!run && (call.rep.scrambled || this.crossedLine)) scout.scrambles++;
    if (this.threw && call.rep.throwAt !== null) { scout.throws++; scout.throwTime += call.rep.throwAt; }
    if (this.pass && this.pass.receiver) {
      const slot = call.layout?.slot[this.pass.receiver];
      if (slot) scout.slots[slot]++;
      const depth = this.pass.target.z - this.spot;
      if (depth >= 15) { scout.deep++; if (result.completed) scout.deepWin++; }
    }
    // Did the offense win the down? A first down, a touchdown, or enough of
    // the distance (40 % on first down, 60 % on second); turnovers and sacks
    // never.
    const need = this.down === 1 ? 0.4 : this.down === 2 ? 0.6 : 1;
    const win = result.kind === 'touchdown' || (result.kind !== 'interception' && result.kind !== 'sack' && result.kind !== 'safety' && (result.firstDown || result.yards >= need * this.toGo));
    const fam = scout.fam[call.coverage] ||= { n: 0, win: 0 };
    fam.n++; if (win) fam.win++;
  },
};

// One line for the app: the personnel, the family and variant, the look and
// the rotation, the front, the corners and anything special.
function describe(call) {
  const v = call.played && VARIANT_NAMES[call.played];
  const name = NAMES[call.coverage] + (v ? (call.coverage === 'cover3' ? ' ' + v : ' · ' + v) : '');
  const look = call.disguised
    ? `disguised from a ${call.shell} shell, ${call.timing === 'late' ? `holding it ${call.hold.toFixed(1)} s` : 'rotating at the snap'}`
    : `${call.shell} shell`;
  const pkg = PACKAGES[call.package] || PACKAGES.base;
  const parts = [`${pkg.name} ${pkg.look}`, name, look, `${call.package === 'goal' ? GOAL_FRONT.name : FRONTS[call.front].name} front`];
  const play = call.corners.includes('press') ? 'press' : call.corners.includes('bail') ? 'press-bail' : 'off';
  const man = call.men.length ? `${play} man, ${call.lev} leverage` : `corners ${play === 'off' ? 'off' : 'pressed'}`;
  parts.push(man);
  if (call.banjo.length) parts.push('banjo on the bunch');
  if (call.spy) parts.push('QB spy');
  if (call.delayAt) parts.push(`delayed rusher at ${call.delayAt.toFixed(2)} s`);
  return parts.join(' · ');
}

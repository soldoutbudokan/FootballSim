// The offensive coordinator: what "Coordinator's call" (offense 'random')
// calls for the down, the distance and the field. Pure functions of the
// situation and the playbook; reset() in sim.js turns one random draw into
// a call with callPlay(), so a seed still makes the same calls.
//
// Each play is profiled from its own routes (profilePlay): its class (a run,
// play action, the quick game, an intermediate dropback or a shot), the
// typical depth of its reads and how many routes can be caught at a given
// depth. The situation sets a share for each class (DOWNS and FIELD); within
// a class, plays that fit the distance and the room left in the end zone
// get more of it (FIT); FLOOR keeps every play that can work in the call.
// Units: yards past the line; GOAL is the goal line's z.
import { PLAYS, RECEIVERS, formationFor } from '../plays.js';

const GOAL = 110;
export const CLASSES = ['run', 'quick', 'mid', 'shot', 'pa'];

// How each route is read (routeShape):
// A route whose last leg climbs (`climb`: rising more than 2 yd, and more
// than half as fast as it moves across) is a target from its break on:
// from its first landmark, or from the start of that last leg when the leg
// is a long release up the field (`release` yd or more, a go after a double
// move or a wheel). One that ends flat or back toward the quarterback
// (curl, hitch, out, dig, drag, flat) is a target where it settles: at the
// first landmark of its flat legs (`flat`: moving across more than 1.5
// times as fast as up). `hi` is the deepest point it reaches, at most
// `cap` yd. On the quick game the ball comes out on rhythm, so a climbing
// route counts only `rhythm` yd past its break.
const SHAPE = { climb: 0.5, release: 20, flat: 1.5, cap: 40, rhythm: 6 };
// A play's class: a dropback is a shot when one of its first two reads (the
// receivers its coaching cue names first, leaving out one who clears, pulls
// or widens a defender, the checkdown and a direction like "roll toward
// {B}") breaks at `deep` yd or deeper and reaches `shot` yd; any other
// dropback is intermediate.
const CLASS = { shot: 25, deep: 10 };
// A route "gets there" at a distance d when it reaches d plus `past` yd and
// breaks no more than `window` yd beyond it (a throw near the sticks, not
// only a bomb).
const STICKS = { past: 0.5, window: 10 };

// Shares by down and distance (class: share of the calls, before the field
// and the floor):
// `first`: 1st down (and 2nd and 3-6), balanced, a few more runs than any
// one pass class. `second`: 2nd and 7 or more leans pass. `short`: 2 yd or
// less to go, on 2nd down or later (or 1st and goal from the 2), runs, quick
// game and play action. `medium`: 3rd or 4th and 3-6, intermediate routes
// that break past the sticks. `long`: 3rd or 4th and 7-14, no designed
// runs, intermediate and deep concepts and a little quick game that can get
// there; `verylong`: 3rd or 4th and 15 or more, mostly shots.
const DOWNS = {
  first: { run: 0.42, quick: 0.17, mid: 0.2, shot: 0.09, pa: 0.12 },
  second: { run: 0.26, quick: 0.16, mid: 0.3, shot: 0.14, pa: 0.14 },
  short: { run: 0.5, quick: 0.22, mid: 0.08, shot: 0.05, pa: 0.15 },
  medium: { run: 0.14, quick: 0.26, mid: 0.44, shot: 0.08, pa: 0.08 },
  long: { run: 0, quick: 0.08, mid: 0.5, shot: 0.38, pa: 0.04 },
  verylong: { run: 0, quick: 0.03, mid: 0.3, shot: 0.64, pa: 0.03 },
};
// Field position multipliers: inside the 5 (`goal`) runs, the quick game
// and play action, almost no shots; in the red zone (inside the 20) more
// quick game, fewer shots; backed up inside his own 10 (`backed`) he stays
// safe: runs and quick throws, few long drops and fakes that a sack or a
// strip turns into a safety.
const FIELD = {
  goal: { run: 1.4, quick: 1.3, mid: 0.8, shot: 0.1, pa: 1.2 },
  red: { run: 1.1, quick: 1.2, mid: 1.0, shot: 0.4, pa: 1.0 },
  backed: { run: 1.3, quick: 1.2, mid: 0.9, shot: 0.5, pa: 0.5 },
};
// Fit within a class:
// On 3rd and 4th down a pass needs routes that get there (STICKS): with
// `need` of them (`needLong` from 15 yd to go) it fits in full, with fewer
// in proportion; with none it is
// out of the call from `noneFrom` yd to go (3rd and long; `none`: its
// weight with none on 3rd and medium). Its reads should land `ahead` yd past the sticks: the fit
// falls off by `spread` yd from there, to `near` at most.
// Near the goal line (inside the 20) a route that breaks beyond the end
// zone, deeper than the goal line plus `endzone` yd, is wasted: the fit is
// the share of routes still in play, squared; and the reads should break
// within `goalAhead` yd of the goal line, falling off as above.
// On short yardage and inside the 5 an inside run (its lane within `inside`
// yd of the ball) fits `downhill` times, an outside run `wide` times.
const FIT = { need: 2, needLong: 3, noneFrom: 7, none: 0.1, ahead: 4, spread: 8, near: 0.4, endzone: 8.5, goalAhead: 2, inside: 5, downhill: 1.5, wide: 0.6 };
// No callable play gets less than FLOOR of an even share of the calls,
// times its fit and its class's field multiplier (at most 1), so the calls
// stay varied without bringing shots back inside the 5. A play out of the
// call (a run on 3rd and long, a pass that cannot reach the sticks) stays
// out.
const FLOOR = 0.4;

// One route's catch window, [lo, hi] yd past the line (see SHAPE).
function routeShape(route, start, quick) {
  if (!route?.length) return null;
  const n = route.length, from = i => (i ? route[i - 1] : [start.x, start.z]);
  const last = route[n - 1], prev = from(n - 1), dx = last[0] - prev[0], dz = last[1] - prev[1];
  const hi = Math.min(SHAPE.cap, Math.max(...route.map(p => p[1])));
  if (dz > 2 && dz > SHAPE.climb * Math.abs(dx)) {
    const lo = Math.max(0, Math.hypot(dx, dz) >= SHAPE.release && n > 1 ? prev[1] : route[0][1]);
    return { lo, hi: quick ? Math.min(hi, lo + SHAPE.rhythm) : hi };
  }
  let k = n - 1;
  while (k > 0) {
    const a = from(k), b = route[k];
    if (Math.abs(b[0] - a[0]) > SHAPE.flat * Math.abs(b[1] - a[1])) k--; else break;
  }
  const lo = Math.abs(route[k][0] - from(k)[0]) > SHAPE.flat * Math.abs(route[k][1] - from(k)[1]) ? from(k)[1] : route[k][1];
  return { lo: Math.max(0, Math.min(lo, last[1])), hi: Math.max(0, last[1]) };
}

// The first reads, in the order the cue names them (see CLASS).
export function firstReads(play) {
  const text = play.read || '', reads = [];
  for (const m of text.matchAll(/\{(\w+)\}/g)) {
    const id = m[1], end = m.index + m[0].length;
    const after = text.slice(end, end + 32).toLowerCase(), before = text.slice(Math.max(0, m.index - 16), m.index).toLowerCase();
    if (!RECEIVERS.includes(id) || reads.includes(id) || /toward\s*$|checkdown|outlet/.test(before)) continue;
    if (/^(\W?s \w+ |\s+and \{\w+\}\s+)?\s*(clears?|fades? to clear|pulls|widen|holds|is the (checkdown|outlet))/.test(after)) continue;
    reads.push(id);
  }
  return reads;
}

const profiles = new WeakMap();
// A play's traits: `cls` (CLASSES), `depth` (where the first two reads
// break, on average; the median of the four receivers other than the back
// when the cue names none), `deep` (the deepest route), `shapes` (each
// receiver's window).
export function profilePlay(play) {
  if (profiles.has(play)) return profiles.get(play);
  const quick = play.family === 'quick' || /quick/i.test(play.tag || '');
  const starts = Object.fromEntries(formationFor(play).map(p => [p.id, p]));
  const shapes = {};
  for (const id of RECEIVERS) {
    const s = play.type === 'run' ? null : routeShape(play.routes[id], starts[id], quick);
    if (s) shapes[id] = s;
  }
  const four = ['X', 'Y', 'A', 'B'].map(id => shapes[id]).filter(Boolean);
  const los = four.map(s => s.lo).sort((a, b) => a - b);
  const reads = firstReads(play).map(id => shapes[id]).filter(Boolean).slice(0, 2);
  const depth = reads.length ? reads.reduce((a, s) => a + s.lo, 0) / reads.length
    : los.length ? (los[(los.length - 1) >> 1] + los[los.length >> 1]) / 2 : 0;
  const deep = Math.max(0, ...four.map(s => s.hi));
  const cls = play.type === 'run' ? 'run' : play.type === 'pa' ? 'pa' : quick ? 'quick'
    : reads.some(s => s.lo >= CLASS.deep && s.hi >= CLASS.shot) ? 'shot' : 'mid';
  const profile = { cls, depth, deep, shapes };
  profiles.set(play, profile);
  return profile;
}

// Routes of the play that can be caught at `d` yd past the line or beyond.
export function routesThere(play, d) {
  return Object.values(profilePlay(play).shapes).filter(s => s.hi >= d + STICKS.past && s.lo <= d + STICKS.window).length;
}

// The situation as the coordinator reads it. Repeat-the-spot reps are a
// 1st and 10 (or goal) every time, and only the red zone counts there.
export function readSituation({ down = 1, toGo = 10, spot = 35, mode = 'drive' } = {}) {
  const togoal = GOAL - spot, reps = mode !== 'drive';
  if (reps) { down = 1; toGo = Math.min(10, togoal); }
  const downs = toGo <= 2 && (down > 1 || togoal <= 2) ? 'short'
    : down >= 3 && toGo >= 15 ? 'verylong' : down >= 3 && toGo >= 7 ? 'long' : down >= 3 ? 'medium'
    : down === 2 && toGo >= 7 ? 'second' : 'first';
  const field = togoal <= 5 ? 'goal' : togoal <= 20 ? 'red' : !reps && spot <= 20 ? 'backed' : null;
  return { down, toGo, togoal, spot, downs, field };
}

// One play's fit inside its class (FIT).
function fitOf(play, situ) {
  const { cls, depth, shapes } = profilePlay(play);
  let fit = 1;
  if (cls === 'run' && (situ.downs === 'short' || situ.field === 'goal')) fit *= Math.abs(play.lane || 0) <= FIT.inside ? FIT.downhill : FIT.wide;
  if (cls !== 'run' && situ.down >= 3 && situ.toGo > 2) {
    const there = routesThere(play, situ.toGo), need = situ.toGo >= 15 ? FIT.needLong : FIT.need;
    fit *= there ? Math.min(1, there / need) : situ.toGo >= FIT.noneFrom ? 0 : FIT.none;
    const off = (depth - (situ.toGo + FIT.ahead)) / FIT.spread;
    fit *= FIT.near + (1 - FIT.near) * Math.exp(-off * off);
  }
  if (cls !== 'run' && (situ.field === 'goal' || situ.field === 'red')) {
    const all = Object.values(shapes), room = situ.togoal + FIT.endzone;
    const live = all.filter(s => s.lo <= room).length;
    fit *= all.length ? (live / all.length) ** 2 : 1;
    const off = Math.max(0, depth - situ.togoal - FIT.goalAhead) / FIT.spread;
    fit *= FIT.near + (1 - FIT.near) * Math.exp(-off * off);
  }
  return fit;
}

// The share of the calls each play gets in this situation, in PLAYS order
// (sums to 1).
export function playWeights(situation, plays = PLAYS) {
  const situ = situation.downs ? situation : readSituation(situation);
  const downs = DOWNS[situ.downs], field = FIELD[situ.field] || {};
  const fits = plays.map(p => fitOf(p, situ));
  const share = {}, total = {};
  for (const c of CLASSES) { share[c] = downs[c] * (field[c] ?? 1); total[c] = 0; }
  plays.forEach((p, i) => { total[profilePlay(p).cls] += fits[i]; });
  // A class with nothing callable gives its share to the rest.
  let w = plays.map((p, i) => { const c = profilePlay(p).cls; return total[c] ? share[c] * fits[i] / total[c] : 0; });
  const live = w.filter(v => v > 0).length;
  const floor = plays.map((p, i) => (w[i] > 0 ? FLOOR / live * Math.min(1, fits[i] * (field[profilePlay(p).cls] ?? 1)) : 0));
  for (let pass = 0; pass < 4; pass++) {
    const sum = w.reduce((a, b) => a + b, 0);
    w = w.map(v => v / sum);
    const low = w.map((v, i) => (v < floor[i] ? i : -1)).filter(i => i >= 0);
    if (!low.length) break;
    const lifted = low.reduce((a, i) => a + floor[i], 0), rest = w.reduce((a, v, i) => a + (low.includes(i) ? 0 : v), 0);
    w = w.map((v, i) => (low.includes(i) ? floor[i] : v * (1 - lifted) / rest));
  }
  return w;
}

// The call for this situation from one draw `roll` in [0, 1).
export function callPlay(situation, roll, plays = PLAYS) {
  const w = playWeights(situation, plays);
  let acc = 0;
  for (let i = 0; i < plays.length; i++) {
    acc += w[i];
    if (roll < acc) return plays[i];
  }
  return plays[w.findLastIndex(v => v > 0)];
}

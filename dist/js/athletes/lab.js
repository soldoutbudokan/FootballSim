import { Simulation, flightVelocity } from '../sim.js';

// Pose lab: synthetic simulation snapshots that exercise every athlete action
// (plan section 3.4) independently of the live simulation. Development aid
// only; the game never imports this module. Drive it from the console or a
// browser test via ?debug=1:
//
//   const lab = await import('./js/athletes/lab.js');
//   const scene = lab.scenario('cut');           // {duration, frame(t), focus}
//   lab.play(window.footballsim.view, scene, 1.1); // poses the rigs at t = 1.1 s
//
// Snapshots follow plan section 3.1, including the new fields (speed, lean,
// backpedal, phase) that the athletes fall back on when they are missing.

const DT = 1 / 120;
const clone = s => JSON.parse(JSON.stringify(s));

export function presnap(seed = 42, play = 'mesh', coverage = 'cover3') {
  const sim = new Simulation(seed, { offense: play, coverage });
  const s = sim.snapshot();
  for (const p of s.players) Object.assign(p, { speed: 0, lean: 0, backpedal: false });
  return s;
}

// Integrates a scripted rep: control(t, state, byId) sets velocities, actions
// and phases; positions, speed, facing and the stride phase follow.
function scripted(base, duration, control, focus) {
  const s = clone(base), byId = Object.fromEntries(s.players.map(p => [p.id, p]));
  s.phase = 'live';
  for (const p of s.players) p.action = 'run';
  const frames = [];
  for (let i = 0; i * DT <= duration + 1e-9; i++) {
    const t = i * DT;
    s.time = t;
    control(t, s, byId);
    for (const p of s.players) {
      p.x += p.vx * DT; p.z += p.vz * DT;
      p.speed = Math.hypot(p.vx, p.vz);
      p.phase += p.speed * DT;
      if (p.speed > 0.4 && !p.holdFacing) p.facing = Math.atan2(p.vx, p.vz);
      p.actionTime = Math.max(0, p.actionTime - DT);
    }
    if (s.carrier && s.phase !== 'air') {
      const c = byId[s.carrier];
      Object.assign(s.ball, { x: c.x + 0.27, y: 1.25, z: c.z + 0.22, vx: 0, vy: 0, vz: 0 });
    }
    frames.push(clone(s));
  }
  return { duration, focus, frame: t => frames[Math.max(0, Math.min(frames.length - 1, Math.round(t / DT)))] };
}

function setAction(p, action, time) { p.action = action; p.actionTime = time; }
function hold(p, action) { if (p.actionTime <= 0) p.action = action; }
function standStill(s) { for (const p of s.players) { p.vx = 0; p.vz = 0; } }

const SCENARIOS = {
  formation: () => {
    const s = presnap();
    return { duration: 0, focus: 'C', frame: () => s };
  },

  // A receiver at full sprint (9.3 yd/s) straight downfield.
  sprint: () => scripted(presnap(), 3, (t, s, p) => {
    if (t === 0) { standStill(s); Object.assign(p.B, { x: 8, z: 40 }); }
    p.B.vx = 0; p.B.vz = Math.min(9.3, 4 + t * 6);
  }, 'B'),

  // Stem at speed, brake into the break, plant and cut 90 degrees inside.
  cut: () => scripted(presnap(), 2.2, (t, s, p) => {
    const x = p.X;
    if (t === 0) { standStill(s); Object.assign(x, { x: -6, z: 44 }); }
    if (t < 0.8) { x.vx = 0; x.vz = 8.6; x.lean = 0; }
    else if (t < 1.0) { x.vz = Math.max(5.2, x.vz - 15 * DT); x.lean = 0; }
    else if (t < 1.3) {
      if (x.action !== 'cut' && t < 1.01) setAction(x, 'cut', 0.2);
      const a = (t - 1.0) / 0.3 * Math.PI / 2, v = 5.0;
      x.vx = Math.sin(a) * v; x.vz = Math.cos(a) * v; x.lean = 1;
    } else { const v = Math.min(8.6, Math.hypot(x.vx, x.vz) + 5 * DT); x.vx = v; x.vz = 0; x.lean = Math.max(0, x.lean - 4 * DT); }
    hold(x, 'run');
  }, 'X'),

  // Ball carrier jukes left: forward speed drops, lateral velocity builds.
  juke: () => scripted(presnap(), 2.2, (t, s, p) => {
    const r = p.R;
    if (t === 0) { standStill(s); s.phase = 'run'; s.carrier = s.selected = 'R'; Object.assign(r, { x: 0, z: 42 }); }
    if (t < 1.0) { r.vx = 0; r.vz = 7; r.lean = 0; hold(r, 'carry'); }
    else if (t < 1.25) {
      if (r.action !== 'juke') setAction(r, 'juke', 0.45);
      const u = (t - 1) / 0.25; r.vz = 7 * (1 - 0.35 * u); r.vx = -6 * u; r.lean = -1;
    } else { r.vx *= 0.985; r.vz = Math.min(7.5, r.vz + 4 * DT); r.lean = Math.min(0, r.lean + 3 * DT); hold(r, 'carry'); }
  }, 'R'),

  // Quarterback: catch the snap, set, throw (release at 0.23 s), follow through.
  throw: () => {
    const base = presnap(), qb = base.players.find(p => p.id === 'QB');
    const start = 0.6, release = start + 0.23, target = { x: -15, y: 1.6, z: 52 };
    return scripted(base, 2, (t, s, p) => {
      if (t === 0) { standStill(s); s.carrier = s.selected = 'QB'; }
      if (t >= start && t < start + DT) setAction(p.QB, 'throw', 0.4);
      if (t >= release && s.phase !== 'air') {
        const from = { x: qb.x + 0.25, y: 1.85, z: qb.z + 0.35 }, v = flightVelocity(from, target, 1.1);
        Object.assign(s.ball, from, { vx: v.x, vy: v.y, vz: v.z });
        s.phase = 'air'; s.carrier = null;
      }
      if (s.phase === 'air') {
        const b = s.ball; b.x += b.vx * DT; b.z += b.vz * DT; b.y += b.vy * DT - 0.5 * 10.73 * DT * DT; b.vy -= 10.73 * DT;
      }
      hold(p.QB, 'run');
    }, 'QB');
  },

  // Crossing receiver: ball arrives at chest height; hands reach, catch, tuck.
  catch: () => {
    const base = presnap(), catchAt = 1.0, speed = 7.5;
    return scripted(base, 2.2, (t, s, p) => {
      const y = p.Y;
      if (t === 0) {
        standStill(s);
        Object.assign(y, { x: -9, z: 45 });
        const meet = { x: -9 + speed * catchAt, y: 1.45, z: 45 }, from = { x: 0.25, y: 1.85, z: 29.35 };
        const v = flightVelocity(from, meet, catchAt);
        Object.assign(s.ball, from, { vx: v.x, vy: v.y, vz: v.z });
        s.phase = 'air'; s.carrier = null; s.selected = 'Y';
      }
      y.vx = speed; y.vz = 0;
      if (s.phase === 'air') {
        const b = s.ball; b.x += b.vx * DT; b.z += b.vz * DT; b.y += b.vy * DT - 0.5 * 10.73 * DT * DT; b.vy -= 10.73 * DT;
        if (t >= catchAt) { s.phase = 'run'; s.carrier = 'Y'; setAction(y, 'catch', 0.45); }
      } else hold(y, 'run');
    }, 'Y');
  },

  // Carrier meets a linebacker: wrap-up, driven back, both go down.
  tackle: () => tackleScene('LB2', { x: 2.7, z: 50 }, 5.5, 'wrap'),
  // Safety closing fast from distance: a diving tackle at the legs.
  dive: () => tackleScene('SS', { x: 7.5, z: 52 }, 8.6, 'dive'),

  // Guard and tackle engaged in pass protection.
  block: () => scripted(presnap(), 2.5, (t, s, p) => {
    if (t === 0) { standStill(s); Object.assign(p.LG, { x: -1.6, z: 33.9 }); Object.assign(p.DT1, { x: -1.45, z: 35.0 }); }
    const sway = Math.sin(t * 3) * 0.6;
    for (const [o, d] of [['LG', 'DT1']]) {
      p[o].vx = 0; p[o].vz = -0.4 + sway; p[d].vx = 0; p[d].vz = -0.4 + sway;
      p[o].facing = 0; p[d].facing = Math.PI; p[o].holdFacing = p[d].holdFacing = true;
      setAction(p[o], 'block', 0.1); setAction(p[d], 'block', 0.1);
      p[o].engaged = d; p[d].engaged = o;
    }
    s.carrier = 'QB';
  }, 'LG'),

  // Missed tackle: the defender lurches past at 30 % speed.
  stumble: () => scripted(presnap(), 2, (t, s, p) => {
    const c = p.CB1;
    if (t === 0) { standStill(s); Object.assign(c, { x: -3, z: 46 }); }
    if (t < 0.8) { c.vx = 0; c.vz = 7; }
    else { if (c.action !== 'stumble' && t < 0.81) setAction(c, 'stumble', 0.7); const f = c.action === 'stumble' ? 0.3 : 0.7; c.vz = 7 * f; c.lean = c.action === 'stumble' ? 0.6 : 0; hold(c, 'run'); }
  }, 'CB1'),

  // Corner backpedalling while facing the quarterback.
  backpedal: () => scripted(presnap(), 2.5, (t, s, p) => {
    const c = p.CB2;
    if (t === 0) { standStill(s); Object.assign(c, { x: 8, z: 42 }); }
    c.vx = 0; c.vz = Math.min(4.6, t * 6); c.facing = Math.PI; c.holdFacing = true; c.backpedal = true;
  }, 'CB2'),

  // All 22 moving: the real simulation a moment into a pass play.
  wide: () => {
    const sim = new Simulation(42, { offense: 'mesh', coverage: 'cover3' });
    sim.snap();
    const frames = [];
    for (let i = 0; i <= 3 * 120; i++) { sim.step(DT, { x: 0, z: 0 }); if (i % 2 === 0) frames.push(sim.snapshot()); }
    return { duration: 3, focus: 'QB', frame: t => frames[Math.max(0, Math.min(frames.length - 1, Math.round(t * 60)))] };
  },
};

function tackleScene(id, start, closing, mode) {
  const contactDist = mode === 'dive' ? 1.2 : 0.9;
  return scripted(presnap(), 3.5, (t, s, p) => {
    const r = p.R, d = p[id];
    if (t === 0) { standStill(s); s.phase = 'run'; s.carrier = s.selected = 'R'; Object.assign(r, { x: 2, z: 40 }); Object.assign(d, start); }
    if (s.phase === 'run') {
      r.vx = 0; r.vz = 6.5; hold(r, 'carry');
      const gap = Math.hypot(r.x - d.x, r.z - d.z), dx = r.x - d.x, dz = r.z + r.vz * Math.min(0.15, gap * 0.04) - d.z, len = Math.hypot(dx, dz);
      d.vx = dx / len * closing; d.vz = dz / len * closing;
      if (Math.hypot(r.x - d.x, r.z - d.z) < contactDist) {
        s.phase = 'tackle'; s.contact = t;
        setAction(r, 'wrapped', 2); setAction(d, 'tackle', 1.0);
      }
    } else if (s.phase === 'tackle') {
      const v = Math.max(0, Math.hypot(r.vx, r.vz) - 12 * DT);
      r.vx = 0; r.vz = v; d.vx = r.vx * 0.9; d.vz = r.vz * 0.9;
      if (v < 0.5 || t - s.contact > 0.9) { s.phase = 'dead'; s.deadTime = 0; s.whistle = t; setAction(r, 'down', 1); r.vz = 0; d.vz = 0; }
    } else {
      // After the whistle the simulation clock stops and deadTime runs.
      s.deadTime += DT;
      for (const q of s.players) { q.vx *= 0.92; q.vz *= 0.92; }
      s.time = s.whistle;
    }
  }, 'R');
}

export function scenario(name) {
  const make = SCENARIOS[name];
  if (!make) throw new Error('Unknown lab scenario: ' + name + ' (' + Object.keys(SCENARIOS).join(', ') + ')');
  return make();
}

export const SCENARIO_NAMES = Object.keys(SCENARIOS);

// Steps the athletes through a scenario at 60 Hz up to time t (no rendering),
// so blends, gait and foot locks settle exactly as they would live.
export function play(view, scene, t, step = 1 / 60) {
  let state = scene.frame(0);
  view.athletes.update(state, step, {});
  for (let time = step; time <= t + 1e-9; time += step) {
    state = scene.frame(time);
    view.athletes.update(state, step, {});
  }
  return state;
}

import * as THREE from '../../vendor/three.module.js';
import { SIDES, clamp, lerp, smoothstep, bump, wrapAngle } from './math.js';
import { carryArm, cover, legsOut, footOnGround, handOnGround } from './carry.js';

// Tackle choreography. One tackle is shared by everyone in it: the snapshot's
// `tackle` record (who, when, both men's velocity going into the hit) fixes
// which way the pile goes down, how hard, and how each man falls, and every
// pose is then a function of the time since contact. Nothing here remembers
// earlier frames, so a replay can scrub through it in either direction.
//
// All geometry is in scene space (x, -simulation z); yaw is the rig's
// (forward = (sin yaw, cos yaw), his left = (cos yaw, -sin yaw)).

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3();
const _w = new THREE.Vector3(), _g = new THREE.Vector3();

const DIVE_GAP = 1.0;          // farther than this at contact, the tackler left his feet
const LANE = 0.64;             // two bodies lying side by side: yards between their spines
// Seconds on the ground after landing before each man starts to get up
// (plus a share of his own seed), and how long getting up takes.
const RISE = { tackled: [1.25, 0.5, 1.3], tackle: [0.6, 0.35, 1.15], assist: [0.15, 0.3, 0.7] };

// Signed angle from facing `yaw` to the direction (ux, uz), positive to his left.
const angleFrom = (yaw, ux, uz) => Math.atan2(ux * Math.cos(yaw) - uz * Math.sin(yaw), ux * Math.sin(yaw) + uz * Math.cos(yaw));

// How a body facing `yaw` goes down along the unit direction (fx, fz): on
// his front, his back, or one side, and how far he twists so that he lies
// along it.
function fallMode(yaw, fx, fz, out) {
  const phi = angleFrom(yaw, fx, fz), a = Math.abs(phi);
  out.side = 0;
  if (a < 1.05) { out.mode = 'prone'; out.twist = phi; }
  else if (a > 2.2) { out.mode = 'supine'; out.twist = wrapAngle(phi - Math.PI); }
  else { out.mode = 'side'; out.side = Math.sign(phi); out.twist = phi - out.side * Math.PI / 2; }
  return out;
}

// Everything about the tackle that is decided at contact.
function classify(t, c, d) {
  const cvx = t.cvx || 0, cvz = -(t.cvz || 0), dvx = t.dvx || 0, dvz = -(t.dvz || 0);
  const cs = Math.hypot(cvx, cvz), share = t.share ?? 0.5;
  const cyaw = cs > 1.5 ? Math.atan2(cvx, cvz) : Math.PI - (t.cf ?? c.facing ?? 0);
  // The carrier's velocity out of the hit (the simulation's rule: momentum
  // shared, never driven backward, his stride broken).
  const k = 0.45 * share;
  let ax = cvx + (dvx - cvx) * k, az = cvz + (dvz - cvz) * k;
  if (cs > 1e-6) { const back = (ax * cvx + az * cvz) / cs; if (back < 0) { ax -= back * cvx / cs; az -= back * cvz / cs; } }
  ax *= 0.8; az *= 0.8;
  // Tackler -> carrier.
  let rx = c.x - d.x, rz = -c.z + d.z;
  const gap = Math.hypot(rx, rz) || 1;
  rx /= gap; rz /= gap;
  // The pile goes down along what is left of the runner's momentum plus the
  // tackler's; two men who met standing still fall away from the tackler.
  let fx = 0.6 * ax + share * dvx, fz = 0.6 * az + share * dvz;
  const fl = Math.hypot(fx, fz);
  if (fl < 0.5) { fx = rx; fz = rz; } else { fx /= fl; fz /= fl; }
  const closing = Math.hypot(dvx - cvx, dvz - cvz);
  const impact = clamp((closing - 1) / 9, 0, 1);
  const parity = Math.round((t.at || 0) * 120) % 2 ? 1 : -1;

  const out = { key: t.at + ':' + t.tackler + ':' + t.carrier, carrier: t.carrier, tackler: t.tackler, sack: !!t.sack, cyaw, fx, fz, impact };
  fallMode(cyaw, fx, fz, out);
  // The hit as the carrier feels it: toward his left (jx) and his front (jz).
  const hx = fl < 0.5 || Math.hypot(dvx - ax, dvz - az) < 1 ? rx : (dvx - ax) / Math.hypot(dvx - ax, dvz - az);
  const hz = fl < 0.5 || Math.hypot(dvx - ax, dvz - az) < 1 ? rz : (dvz - az) / Math.hypot(dvx - ax, dvz - az);
  out.jx = hx * Math.cos(cyaw) - hz * Math.sin(cyaw);
  out.jz = hx * Math.sin(cyaw) + hz * Math.cos(cyaw);

  // The tackler: where he is in the pile's frame (along the fall and to its
  // left), which decides whether he lands on the runner's legs or beside him.
  const along = -(rx * fx + rz * fz) * gap, left = (-rx * fz + rz * fx) * gap;
  const dive = (t.gap ?? gap) > DIVE_GAP && along < -0.2;
  out.dyaw = Math.atan2(rx, rz);
  out.lane = Math.abs(left) > 0.1 ? Math.sign(left) : parity;
  out.layout = dive ? 'dive' : along < -0.2 ? 'stack' : 'lanes';
  out.flat = out.layout !== 'lanes';
  if (out.layout === 'lanes') {
    const m = fallMode(out.dyaw, fx, fz, {});
    out.tmode = m.mode; out.tside = m.side; out.ttwist = m.twist;
    // A man in front who is dragged down turns and goes down on his hip,
    // chest to the runner, never flat on his back.
    if (m.mode === 'supine') {
      out.tmode = 'side'; out.tside = out.lane;
      out.ttwist = wrapAngle(angleFrom(out.dyaw, fx, fz) - out.lane * Math.PI / 2);
    }
    const shift = out.lane * Math.max(Math.abs(left), LANE) - left;
    out.shiftX = fz * shift; out.shiftZ = -fx * shift;
  }
  // Timing: a hard hit puts him down at once, a drag from behind takes a
  // moment of struggle first; a man whose ankles are taken goes down fast.
  out.t1 = dive ? 0.08 : lerp(0.16, 0.04, impact);
  out.dur = dive ? 0.45 : lerp(0.6, 0.44, impact);
  out.land = out.t1 + out.dur;
  return out;
}

const fallCurve = x => { const t = clamp(x, 0, 1); return t ** 1.7; };

// The frame's tackle for Athletes.frameContext: the classification (cached
// by tackle, so it cannot flip while it plays) plus the clock.
export function tackleContext(t, phase, clock, byId, cache) {
  if (!t || phase === 'presnap') return null;
  const c = byId.get(t.carrier), d = byId.get(t.tackler);
  if (!c || !d) return null;
  const key = t.at + ':' + t.tackler + ':' + t.carrier;
  if (cache.key !== key) { cache.key = key; cache.value = classify(t, c, d); cache.helpers = new Map(); }
  const k = cache.value;
  k.T = Math.max(0, clock - t.at);
  k.u = fallCurve((k.T - k.t1) / k.dur);
  k.dead = phase === 'dead';
  cache.helpers.clear();
  for (const h of t.helpers || []) cache.helpers.set(h.id, h.at - t.at);
  k.helpers = cache.helpers;
  return k;
}

// A simulation that does not publish the tackle (the pose lab, older
// recordings): build the record from the actions when they first show.
export function inferTackle(state, clock, byId, memo) {
  if (state.phase === 'presnap' || !state.carrier) { memo.record = null; return null; }
  const c = byId.get(state.carrier);
  if (!c || (c.action !== 'wrapped' && c.action !== 'down')) { if (state.phase !== 'dead') memo.record = null; return memo.record; }
  let r = memo.record;
  if (!r || r.carrier !== c.id) {
    let d = null, best = Infinity;
    for (const q of state.players) {
      if (q.action !== 'tackle') continue;
      const g = Math.hypot(q.x - c.x, q.z - c.z);
      if (g < best) { best = g; d = q; }
    }
    if (!d) return null;
    r = memo.record = { tackler: d.id, carrier: c.id, at: clock, sack: false, cvx: c.vx || 0, cvz: c.vz || 0, dvx: d.vx || 0, dvz: d.vz || 0, cf: c.facing, gap: best, share: 0.5, helpers: [] };
  }
  for (const q of state.players) {
    if (q.action === 'tackle' && q.id !== r.tackler && !r.helpers.some(h => h.id === q.id)) r.helpers.push({ id: q.id, at: clock });
  }
  return r;
}

// Which tackle action a player shows this frame ('tackled', 'tackle',
// 'assist'), or null once he is back on his feet (or was never in it).
export function tackleRole(anim, p, tk) {
  if (!tk) return null;
  const role = p.id === tk.carrier ? 'tackled' : p.id === tk.tackler ? 'tackle' : tk.helpers.has(p.id) ? 'assist' : null;
  if (!role) return null;
  return riseOf(anim, tk, role) >= 1 ? null : role;
}

// 0 while he is down, rising to 1 as he gets back up after the whistle.
function riseOf(anim, tk, role) {
  if (!tk.dead) return 0;
  const [delay, spread, dur] = RISE[role];
  const from = (role === 'assist' ? Math.max(tk.land, (tk.helpers.get(anim.spec.id) ?? 0) + 0.5) : tk.land) + delay + spread * anim.seed;
  return clamp((tk.T - from) / dur, 0, 1);
}

// ---------------------------------------------------------------------------
// Going to the ground. `u` runs 0 (on his feet, the pose as given) to 1 (down)
// and back to 0 as he gets up; the legs buckle first, the body rotates about
// the ground pivot, then lays out. Options: holding (the arm with the ball,
// or -1), flat (legs straight: someone is lying on them), pitch, arch, kick,
// push (0..1: hands on the turf pushing up).
function goDown(anim, pose, mode, side, u, o) {
  if (u <= 0) return;
  const d = anim.dims, k = d.k;
  const buckle = smoothstep(0, 0.4, u), f = smoothstep(0.12, 1, u), mid = bump(0, 1, u), flat = smoothstep(0, 0.6, u);
  const y0 = pose.pelvis.y, holding = o.holding ?? -1, push = o.push || 0, pw = smoothstep(0, 0.3, push);
  const px = pose.pelvis.x * (1 - f), pz = pose.pelvis.z * (1 - f);
  // Where the feet stand now, as ground points of the body frame.
  const f0 = _a.copy(pose.feet[0]), f1 = _b.copy(pose.feet[1]);

  if (mode === 'prone') {
    pose.tiltPitch = (o.pitch ?? 1.43) * u;
    pose.tiltRoll = (o.roll || 0) * f;
    // He goes over like a plank that gives at the knees: the trunk lines up
    // with the legs early, so his seat never sticks up on the way down.
    pose.pelvis.set(px, lerp(lerp(y0, d.hipY - (o.squat || 0.22) * k, buckle), d.hipY - 0.06, f), pz);
    pose.hips.set(lerp(pose.hips.x, 0.04, flat), pose.hips.y * (1 - f), pose.hips.z * (1 - f));
    pose.spine.set(lerp(pose.spine.x, 0.08 - (o.arch || 0), flat), pose.spine.y * (1 - f), pose.spine.z * (1 - f));
    legsOut(anim, pose, f);
    // A foot still out in front as he tips over stays on top of the turf.
    const cp = Math.cos(pose.tiltPitch), sp = Math.sin(pose.tiltPitch);
    if (cp > 0.25) for (let i = 0; i < 2; i++) {
      const h = pose.feet[i].y * cp - pose.feet[i].z * sp;
      if (h < 0.06) pose.feet[i].y += (0.06 - h) / cp;
    }
    // One knee stays a little cocked so the legs do not lie like a plank.
    const bent = anim.seed < 0.5 ? 0 : 1;
    pose.feet[bent].y += 0.13 * k * f; pose.feet[bent].x += SIDES[bent] * 0.08 * f;
    pose.head.set(lerp(pose.head.x, -1.1, f), lerp(pose.head.y, o.look || 0, f), 0);
    anim.prepareChest(pose);
    for (let i = 0; i < 2; i++) {
      if (i === holding) continue;
      const w = Math.max(push, o.arms ? 0 : f);
      if (w > 0) handOnGround(anim, pose, i, SIDES[i] * lerp(0.4, 0.33, pw), lerp(1.52, 1.34, pw) * k, w);
    }
  } else if (mode === 'supine') {
    pose.tiltPitch = -1.42 * u;
    pose.pelvis.set(px, lerp(lerp(y0, d.hipY - 0.36 * k, buckle), d.hipY - 0.05, f), pz);
    pose.hips.set(lerp(pose.hips.x, 0.12, f) + 0.7 * mid, pose.hips.y * (1 - f), pose.hips.z * (1 - f));
    pose.spine.set(lerp(pose.spine.x, 0.14, f) + 0.3 * mid, pose.spine.y * (1 - f), pose.spine.z * (1 - f));
    pose.head.set(lerp(pose.head.x, 0.8, f), pose.head.y * (1 - f), 0);
    // Feet stay on the turf as he sits down, then the knees stay up (or the
    // legs go flat under a man lying across them); a hard hit kicks one up.
    const kick = (o.kick || 0) * bump(0.25, 0.95, u), high = anim.seed < 0.5 ? 0 : 1;
    for (let i = 0; i < 2; i++) {
      const from = i ? f1 : f0;
      const tx = SIDES[i] * (o.flat ? 0.17 : 0.19), tz = (o.flat ? -0.1 : -0.24) * k;
      footOnGround(anim, pose, i, lerp(from.x, tx, f), lerp(from.z, tz, f), 1, lerp(from.y, d.ankle + (o.flat ? 0.03 : 0), f) + (i === high ? 0.32 * kick : 0.1 * kick));
      pose.footRot[i].set(lerp(pose.footRot[i].x, o.flat ? 0.25 : 1.25, f), SIDES[i] * 0.2, 0);
      pose.knees[i].set(SIDES[i] * 0.25, 0, 1);
    }
    anim.prepareChest(pose);
    for (let i = 0; i < 2; i++) {
      if (i === holding) continue;
      const w = Math.max(push, holding >= 0 || o.arms ? 0 : f);
      if (w > 0) handOnGround(anim, pose, i, SIDES[i] * lerp(0.6, 0.42, pw), lerp(-1.25, -0.78, pw) * k, w);
    }
  } else {
    const b = side > 0 ? 0 : 1, top = 1 - b;
    pose.tiltRoll = -side * 1.38 * u;
    pose.tiltPitch = 0.1 * u;
    pose.pelvis.set(px, lerp(lerp(y0, d.hipY - 0.34 * k, buckle), d.hipY - 0.05, f), pz);
    pose.hips.set(lerp(pose.hips.x + 0.2 * buckle, 0.34, f), pose.hips.y * (1 - f), pose.hips.z * (1 - f));
    pose.spine.set(lerp(pose.spine.x, 0.24, f), pose.spine.y * (1 - f), lerp(pose.spine.z, 0, f) + side * 0.22 * mid);
    pose.head.set(lerp(pose.head.x, 0.1, f), pose.head.y * (1 - f), side * 0.4 * f);
    // Bottom leg long, top leg bent with the knee forward on the turf.
    footOnGround(anim, pose, b, lerp((b ? f1 : f0).x, side * 0.12, f), lerp((b ? f1 : f0).z, -0.16 * k, f), 1, lerp((b ? f1 : f0).y, 0.085, f));
    footOnGround(anim, pose, top, lerp((top ? f1 : f0).x, side * 0.5 * k, f), lerp((top ? f1 : f0).z, 0.36 * k, f), 1, lerp((top ? f1 : f0).y, 0.12, f));
    for (let i = 0; i < 2; i++) { pose.footRot[i].x = lerp(pose.footRot[i].x, 0.6, f); pose.knees[i].set(0, 0, 1); }
    anim.prepareChest(pose);
    const w = Math.max(push, holding >= 0 || o.arms ? 0 : f);
    if (b !== holding && w > 0) handOnGround(anim, pose, b, side * lerp(1.5, 1.15, pw) * k, lerp(0.42, 0.3, pw), w);
    if (top !== holding && holding < 0 && !o.arms) {
      pose.hands[top].lerp(_w.set(SIDES[top] * 0.1, -0.12, 0.3), f);
      pose.elbows[top].lerp(_w.set(SIDES[top], -0.6, -0.3), f);
    }
  }
}

// Knocked flat on his back and straight back up (a pancake block): `u` as in
// goDown, `rising` once he is on his way up (the hands push off).
export function knockedDown(anim, pose, u, rising) {
  goDown(anim, pose, 'supine', 0, u, { kick: 0.6, push: rising ? smoothstep(0.1, 0.5, u) : 0 });
}

// ---------------------------------------------------------------------------
// The ball carrier (or a sacked quarterback).
export function tackled(anim, pose, age, data, p, ctx) {
  const tk = ctx.tackle, d = anim.dims, k = d.k;
  const arm = ctx.holderId === p.id ? carryArm(anim, p) : -1;
  if (!tk) {                                  // wrapped with no record: just fight for yards
    pose.pelvis.y -= 0.16; pose.hips.x = 0.36; pose.spine.x = 0.32;
    if (arm >= 0) cover(pose, arm);
    return;
  }
  const T = tk.T, rise = riseOf(anim, tk, 'tackled'), up = smoothstep(0, 1, rise);
  const u = tk.u * (1 - up), s = 1 - up;
  // Wrapped up and still on his feet: pads down over the ball, legs driving.
  pose.pelvis.y -= 0.15 * k * s;
  pose.hips.x = lerp(pose.hips.x, 0.38, s);
  pose.spine.x = lerp(pose.spine.x, 0.3, s);
  pose.head.x = lerp(pose.head.x, -0.1, s);
  // The hit: his hips go with it, shoulders and head lag behind.
  const jolt = smoothstep(0, 0.06, T) * (1 - 0.6 * smoothstep(0.12, 0.5, T)) * (0.45 + 0.55 * tk.impact) * s * (1 - smoothstep(0.5, 1, u));
  pose.pelvis.x += tk.jx * 0.08 * jolt; pose.pelvis.z += tk.jz * 0.08 * jolt;
  pose.hips.z += -tk.jx * 0.18 * jolt;
  pose.spine.x += -tk.jz * 0.42 * jolt; pose.spine.z += tk.jx * 0.34 * jolt;
  pose.head.x += -tk.jz * 0.3 * jolt; pose.head.z += tk.jx * 0.25 * jolt;
  if (arm >= 0) cover(pose, arm, Math.max(s, 0.001));
  pose.yaw = tk.twist * smoothstep(0.05, 0.8, u);
  // Getting up he puts the free hand down and pushes.
  const push = up > 0 ? bump(0, 1, clamp((1 - u) / 0.75, 0, 1)) ** 0.6 * smoothstep(0.3, 0.6, u + 0.3) : 0;
  goDown(anim, pose, tk.mode, tk.side, u, { holding: arm, flat: tk.flat, kick: tk.impact, push, roll: (anim.seed - 0.5) * 0.3, squat: up > 0 ? 0.46 : 0 });
  // Landing: the body gives a little, then settles.
  const since = T - tk.land;
  if (since > 0 && since < 0.4 && !up) {
    const hit = Math.exp(-since / 0.07) * (0.5 + 0.5 * tk.impact);
    pose.spine.x += (tk.mode === 'supine' ? -0.1 : 0.1) * hit;
    pose.head.x += (tk.mode === 'supine' ? -0.3 : 0.3) * hit;
  }
}

// The carrier's legs between the hips and the feet (scene space): where a
// tackler wraps up. frac 0 = the hips, 1 = the ankles.
function wrapPoint(ctx, tk, frac, out) {
  const rig = ctx.rigs.get(tk.carrier);
  if (!rig) { const c = ctx.byId.get(tk.carrier); return c ? out.set(c.x, 0.9, -c.z) : null; }
  const W = rig.world;
  _g.addVectors(W.feet[0], W.feet[1]).multiplyScalar(0.5);
  return out.copy(W.pelvis).lerp(_g, frac);
}

// Scene yaw the tackler turns to: at the legs he is wrapping (or, falling
// beside the runner, the way he came in).
export function tackleYaw(anim, p, ctx) {
  const tk = ctx.tackle;
  if (!tk) return undefined;
  if (tk.tackler !== p.id) {
    const rig = ctx.rigs.get(tk.carrier);
    return rig ? Math.atan2(rig.world.chest.x - p.x, rig.world.chest.z + p.z) : undefined;
  }
  if (tk.layout === 'lanes') return tk.dyaw;
  const w = wrapPoint(ctx, tk, tk.layout === 'dive' ? 0.62 : 0.3, _g);
  if (!w) return tk.dyaw;
  const dx = w.x + tk.fz * tk.lane * 0.2 - p.x, dz = w.z - tk.fx * tk.lane * 0.2 + p.z;
  return Math.hypot(dx, dz) > 0.35 ? Math.atan2(dx, dz) : tk.dyaw;
}

// The tackler (and, for anyone else in on it, the second man: see assist).
export function tackle(anim, pose, age, data, p, ctx) {
  const tk = ctx.tackle, d = anim.dims, k = d.k;
  if (!tk) {                                   // no record: a plain wrap-up crouch
    pose.pelvis.y = d.hipY - 0.28 * k; pose.hips.x = 0.62; pose.spine.x = 0.35;
    return;
  }
  if (tk.tackler !== p.id) return assist(anim, pose, p, ctx, tk);
  const T = tk.T, dive = tk.layout === 'dive';
  const rise = riseOf(anim, tk, 'tackle'), up = smoothstep(0, 1, rise), s = 1 - up;
  // He rides the runner down a beat behind him; a diver is out flat at once.
  let fall = dive ? smoothstep(0.02, 0.36, T) : fallCurve((T - tk.t1 - 0.04) / tk.dur);
  // A runner who is pulling away drags him off his feet: the simulation lets
  // the gap open while he hangs on, so the farther the hips he is holding
  // are, the flatter he is stretched out behind them.
  if (tk.layout === 'stack') {
    const hips = wrapPoint(ctx, tk, 0.08, _d);
    if (hips) fall = Math.max(fall, 0.9 * smoothstep(0.95, 1.75, Math.hypot(hips.x - p.x, hips.z + p.z)) * smoothstep(0, 0.36, T));
  }
  const u = fall * (1 - up);
  // The hit: hips sunk, back flat, eyes up, head to one side of the runner,
  // then the legs drive through him.
  const strike = smoothstep(0, 0.16, T) * s, drive = bump(0.06, 0.5, T) * s;
  const head = -tk.lane * (tk.layout === 'lanes' ? 0 : 1);     // his own left (+) or right
  pose.pelvis.y = lerp(pose.pelvis.y, d.hipY - (dive ? 0.2 : 0.31) * k + 0.05 * k * drive, strike);
  pose.pelvis.x += head * 0.08 * strike;
  pose.pelvis.z += 0.1 * drive;
  pose.hips.x = lerp(pose.hips.x, 0.82, strike);
  pose.spine.set(lerp(pose.spine.x, 0.26, strike), pose.spine.y * (1 - strike), head * -0.14 * strike);
  pose.head.set(lerp(pose.head.x, -0.45, strike), -head * 0.3 * strike, head * 0.25 * strike);
  // His feet are under him in a wide stagger, chopping, whatever the runner's
  // momentum is doing to his root.
  const chop = Math.sin(ctx.time * 16 + anim.seed * 6), lead = tk.lane > 0 ? 0 : 1;
  for (let i = 0; i < 2; i++) {
    _w.set(SIDES[i] * 0.2, d.ankle + 0.05 * Math.max(0, i ? chop : -chop) * (1 - fall), i === lead ? 0.14 : -0.3);
    pose.feet[i].lerp(_w, strike);
    pose.footRot[i].x = lerp(pose.footRot[i].x, i === lead ? 0 : 0.5, strike);
  }

  const wrap = smoothstep(0, 0.14, T) * (1 - smoothstep(0, 0.35, rise));
  const pushing = up > 0 ? bump(0, 1, clamp((1 - u) / 0.75, 0, 1)) ** 0.6 * smoothstep(0.3, 0.6, u + 0.3) : 0;
  if (tk.layout === 'lanes') {
    // Pulled down beside the runner: he falls the way the pile goes.
    pose.yaw = tk.ttwist * smoothstep(0.05, 0.8, u);
    goDown(anim, pose, tk.tmode, tk.tside, u, { push: pushing });
    const w = smoothstep(0.1, 0.95, u), yaw = anim.yaw + pose.yaw, cs = Math.cos(yaw), sn = Math.sin(yaw);
    pose.tiltSide = (tk.shiftX * cs - tk.shiftZ * sn) * w;
    pose.tiltFwd = (tk.shiftX * sn + tk.shiftZ * cs) * w;
    // The arm nearest the runner stays hooked on him while it reaches.
    const rig = ctx.rigs.get(tk.carrier);
    if (rig && wrap > 0) {
      anim.worldToChest(pose, wrapPoint(ctx, tk, 0.1, _d), _c);
      const near = _c.x > 0 ? 0 : 1, far = 1 - near;
      const reach = _w.set(SIDES[near] * d.shoulder[0], d.shoulder[1], d.shoulder[2]).distanceTo(_c);
      const hold = wrap * (1 - smoothstep(0.95, 1.25, reach / (d.upperArm + d.forearm)));
      pose.hands[near].lerp(_c, hold);
      pose.elbows[near].lerp(_w.set(SIDES[near], -0.3, -0.1), hold);
      // The other arm clutches at him until they are on the turf.
      _c.x += SIDES[far] * 0.2;
      pose.hands[far].lerp(_c, hold * (1 - smoothstep(0.2, 0.7, u)));
    }
    return;
  }

  // On the runner's legs: prone, chest up on his thighs (or out flat at his
  // shins after a dive), head to the outside, arms locked around them.
  goDown(anim, pose, 'prone', 0, u, { pitch: 1.43, arch: dive ? 0.1 : 0.26, look: -head * 0.5, arms: true, push: pushing, squat: up > 0 ? 0.46 : 0 });
  const frac = dive ? 0.66 : lerp(0.08, tk.mode === 'supine' ? 0.56 : 0.4, tk.u);
  const W = wrapPoint(ctx, tk, frac, _d);
  if (!W) return;
  // Slide the ground pivot so the chest comes down where the legs are, a
  // little to his own side of them.
  const place = smoothstep(0.12, 0.95, u), lat = (dive ? 0.07 : tk.mode === 'supine' ? 0.3 : 0.2) * tk.lane * place;
  _c.set(W.x + tk.fz * lat, 0, W.z - tk.fx * lat);
  const local = anim.worldToRoot(_c, _w);
  // Standing, his shoulder is in the runner's hip; down, his chest is over
  // the thighs (a diver's shoulders are at the shins).
  const short = dive ? 0.27 * k : lerp(0.3, 0.02, place);
  // The arms get there first; the body follows them in.
  const chest = anim.chestInBody(pose, _b), near = Math.max(smoothstep(0, 0.24, T) * s, place);
  pose.tiltFwd = clamp(local.z - short - chest.z, -1.4, 0.5) * near;
  pose.tiltSide = clamp(local.x - chest.x, -0.8, 0.8) * near;
  if (dive) pose.tiltLift = 0.2 * bump(0.02, 0.42, T) * s;
  if (wrap <= 0) return;
  // Arms: around the legs from both sides, hands meeting behind them.
  const ux = Math.sin(anim.yaw), uz = Math.cos(anim.yaw);
  for (let i = 0; i < 2; i++) {
    const side = SIDES[i];
    _c.set(W.x + ux * 0.11 + uz * side * 0.15, Math.max(0.15, W.y + (dive ? 0 : 0.03)), W.z + uz * 0.11 - ux * side * 0.15);
    anim.worldToChest(pose, _c, _b);
    pose.hands[i].lerp(_b, wrap);
    pose.elbows[i].lerp(_w.set(side, -0.3, -0.1), wrap);
    pose.wrists[i].lerp(_w.set(-0.4, 0, side * 0.8), wrap);
  }
}

// The second man in: he hits high, rides the runner down to a knee with his
// hands on him and stays on his feet over the pile.
function assist(anim, pose, p, ctx, tk) {
  const d = anim.dims, k = d.k, rig = ctx.rigs.get(tk.carrier);
  const Tj = tk.T - (tk.helpers.get(p.id) ?? 0);
  const up = smoothstep(0, 1, riseOf(anim, tk, 'assist')), s = 1 - up;
  const hit = smoothstep(0, 0.16, Tj) * s, down = Math.min(tk.u, smoothstep(0.05, 0.45, Tj)) * s;
  pose.pelvis.y = lerp(pose.pelvis.y, d.hipY - (0.2 + 0.3 * down) * k, hit);
  pose.hips.x = lerp(pose.hips.x, 0.6 + 0.25 * down, hit);
  pose.spine.x = lerp(pose.spine.x, 0.3 + 0.3 * down, hit);
  // Down on the back knee.
  const back = anim.seed < 0.5 ? 0 : 1;
  pose.feet[back].z -= 0.26 * down; pose.footRot[back].x = lerp(pose.footRot[back].x, 0.9, down);
  pose.feet[1 - back].z += 0.14 * down;
  for (let i = 0; i < 2; i++) pose.feet[i].x += SIDES[i] * 0.06 * hit;
  if (!rig) return;
  const C = rig.world.chest, P = rig.world.pelvis;
  // Keep his feet off the runner: step back from the line of his body.
  const sx = C.x - P.x, sz = C.z - P.z, len2 = sx * sx + sz * sz || 1;
  const t = clamp(((p.x - P.x) * sx + (-p.z - P.z) * sz) / len2, -0.6, 1.4);
  let ox = p.x - (P.x + sx * t), oz = -p.z - (P.z + sz * t);
  const off = Math.hypot(ox, oz);
  if (off < 0.55 && down > 0) {
    if (off < 1e-3) { ox = sz; oz = -sx; }
    const n = Math.hypot(ox, oz), push = (0.55 - off) * down;
    const c = Math.cos(anim.yaw), sn = Math.sin(anim.yaw);
    ox *= push / n; oz *= push / n;
    pose.tiltSide = ox * c - oz * sn; pose.tiltFwd = ox * sn + oz * c;
  }
  // Hands on him, if he is within reach.
  _a.copy(C); _a.y += 0.1;
  for (let i = 0; i < 2; i++) {
    anim.worldToChest(pose, _a, _b);
    _b.x += SIDES[i] * 0.12;
    const reach = _w.set(SIDES[i] * d.shoulder[0], d.shoulder[1], d.shoulder[2]).distanceTo(_b) / (d.upperArm + d.forearm);
    const w = hit * (1 - smoothstep(0.98, 1.3, reach));
    pose.hands[i].lerp(_b, w);
    pose.elbows[i].lerp(_w.set(SIDES[i] * 0.8, -0.6, -0.3), w);
    pose.wrists[i].lerp(_w.set(-0.7, 0, 0), w);
  }
  anim.lookAt(pose, C, 0.7 * hit);
}

// ---------------------------------------------------------------------------
// Before contact. A free defender closing on the ball breaks down (weights by
// id in `out`); the return value is how hard the runner braces for a man in
// front of him.
export function contactThreats(ctx, out) {
  out.clear();
  const c = ctx.byId.get(ctx.carrierId);
  if (!c || ctx.tackle || (ctx.phase !== 'run' && ctx.phase !== 'live')) return 0;
  const cs = Math.hypot(c.vx || 0, c.vz || 0);
  let brace = 0;
  for (const q of ctx.state.players) {
    if (q.id === c.id || q.engaged != null || q.action === 'stumble') continue;
    const dx = c.x - q.x, dz = c.z - q.z, gap = Math.hypot(dx, dz);
    if (gap > 3.4 || gap < 1e-3) continue;
    if (ctx.rigs.get(q.id)?.spec.team !== 'defense') continue;
    const closing = (((q.vx || 0) - (c.vx || 0)) * dx + ((q.vz || 0) - (c.vz || 0)) * dz) / gap;
    const w = (1 - smoothstep(1.2, 3.2, gap)) * smoothstep(0.5, 2.5, closing);
    if (w > 0.01) out.set(q.id, w);
    const ahead = cs > 1 ? smoothstep(0.2, 0.7, -((c.vx || 0) * dx + (c.vz || 0) * dz) / (cs * gap)) : 0;
    brace = Math.max(brace, (1 - smoothstep(1.0, 2.2, gap)) * smoothstep(1, 3.5, closing) * ahead);
  }
  return brace;
}

// ---------------------------------------------------------------------------
// A missed tackle, from the snapshot's `misses`.

// The runner for the half second after a man fails to bring him down: he
// lurches, stiff-arms a tackler on his free side (or turns his shoulders away
// from one on the ball side) and gets his feet back under him.
export function shrugOff(anim, pose, p, ctx) {
  const m = ctx.miss;
  if (!m) return;
  const w = smoothstep(0, 0.05, m.age) * (1 - smoothstep(0.12, 0.5, m.age));
  if (w <= 0) return;
  const q = ctx.byId.get(m.tackler), rig = ctx.rigs.get(m.tackler);
  if (!q) return;
  const local = anim.worldToRoot(_c.set(q.x, 0, -q.z), _w), dist = Math.hypot(local.x, local.z) || 1;
  const lx = local.x / dist, lz = local.z / dist, side = lx >= 0 ? 0 : 1;      // the arm on his side
  const arm = carryArm(anim, p), d = anim.dims;
  // Knocked off his stride: hips sink, he leans away from the hands on him.
  pose.pelvis.y -= 0.09 * d.k * w;
  pose.pelvis.x -= lx * 0.07 * w;
  pose.spine.x += 0.14 * w;
  pose.spine.z += lx * 0.2 * w;
  pose.hips.z += lx * 0.1 * w;
  if (side !== arm && lz > -0.5 && rig) {
    // Stiff-arm: the free hand in the tackler's pads, arm locked out.
    _a.copy(rig.world.chest); _a.y += 0.12;
    anim.worldToChest(pose, _a, _b);
    const max = 0.97 * (d.upperArm + d.forearm);
    _d.set(SIDES[side] * d.shoulder[0], d.shoulder[1], d.shoulder[2]);
    _b.sub(_d); if (_b.length() > max) _b.setLength(max); _b.add(_d);
    pose.hands[side].lerp(_b, w);
    pose.elbows[side].lerp(_w.set(SIDES[side] * 0.6, -0.8, -0.2), w);
    pose.wrists[side].lerp(_w.set(-1.0, 0, 0), w);
    pose.spine.y += (lx >= 0 ? 0.25 : -0.25) * w;
    pose.head.y += (lx >= 0 ? 0.4 : -0.4) * w;
  } else {
    // Ball side or behind: both arms on the ball, shoulders turned away.
    cover(pose, arm, w);
    pose.spine.y += (lx >= 0 ? -0.4 : 0.4) * w;
  }
}

// Which miss (if any) the frame's ball carrier is shrugging off.
export function recentMiss(state, clock, holderId) {
  let found = null;
  for (const m of state.misses || []) {
    const age = clock - m.at;
    if (m.carrier === holderId && age >= 0 && age < 0.5) found = { tackler: m.tackler, age };
  }
  return found;
}

// For the man who missed: which way the runner went past him (+1 = to his
// right) and whether he had left his feet for it.
export function missFor(anim, p, ctx) {
  let found = null;
  for (const m of ctx.state.misses || []) if (m.tackler === p.id) found = m;
  if (!found) return null;
  const c = ctx.byId.get(found.carrier);
  if (!c) return null;
  const local = anim.worldToRoot(_c.set(c.x, 0, -c.z), _w);
  return { side: local.x > 0 ? -1 : 1, deep: Math.hypot(found.dx, found.dz) > DIVE_GAP, carrier: found.carrier };
}

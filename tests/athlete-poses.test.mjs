import test from 'node:test';
import assert from 'node:assert/strict';

// The procedural athletes posed by the real simulation, without WebGL. The
// jersey and marker textures draw on a canvas, so a do-nothing 2D context
// stands in for one.
const THREE = await import('../dist/vendor/three.module.js').catch(() => null);
const poseTest = (name, fn) => test(name, { skip: THREE ? false : 'run npm run check to vendor three.js' }, fn);
const noop = new Proxy(function () {}, { get: (t, k) => (k === 'width' ? 10 : k === 'data' ? new Uint8ClampedArray(4) : noop), apply: () => noop, set: () => true });
const context = new Proxy({}, { get: (t, k) => (k in t ? t[k] : noop), set: (t, k, v) => { t[k] = v; return true; } });
globalThis.document ??= { createElement: () => ({ width: 0, height: 0, style: {}, getContext: () => context }) };
const { Simulation, STEP } = await import('../dist/js/sim.js');
const { Athletes } = THREE ? await import('../dist/js/athletes.js') : {};

function rep(seed, options) {
  const sim = new Simulation(seed, { mode: 'reps', difficulty: 'pro', ...options });
  const athletes = new Athletes(new THREE.Scene(), sim.players, { camera: new THREE.PerspectiveCamera(46, 1.6, 0.1, 500) });
  athletes.setQuality({ id: 'high' });
  athletes.update(sim.snapshot(), 1 / 60);
  return { sim, athletes };
}
// Simulation at 120 Hz, athletes at 60 Hz; `each` sees every rendered frame.
function play({ sim, athletes }, seconds, each = () => {}, input = () => ({})) {
  sim.snap();
  for (let i = 0; i < seconds / STEP && sim.phase !== 'dead'; i++) {
    sim.step(STEP, input(sim));
    if (i % 2) { const s = sim.snapshot(); athletes.update(s, 1 / 60); each(s); }
  }
}

// A body as a box in its chest frame (the pads, rounded, so a little inside
// the mesh's bounds); signed distance from a scene point, negative inside.
// Without the vendored three.js the tests skip, so these stay unset.
const _p = THREE && new THREE.Vector3(), _m = THREE && new THREE.Matrix4();
function bodyDistance(rig, point) {
  const d = rig.dims, depth = (1 + d.torso) / 2;
  _p.copy(point).applyMatrix4(_m.copy(rig.chest.matrixWorld).invert());
  const hy = 0.22 * d.k, cy = 0.16 * d.k;
  const q = [Math.abs(_p.x) - 0.23 * d.torso, Math.abs(_p.y - cy) - hy, Math.abs(_p.z) - 0.15 * depth];
  return Math.hypot(...q.map(v => Math.max(v, 0))) + Math.min(Math.max(...q), 0);
}
const helmet = rig => new THREE.Vector3(0, 0.115, 0.02).applyMatrix4(rig.head.matrixWorld);

poseTest('engaged blockers and rushers keep helmets and pads apart with the hands on the other man', () => {
  let pairs = 0, overlaps = 0, inside = 0, hands = 0, reached = 0;
  for (const coverage of ['cover3', 'blitz']) for (const seed of [1, 2]) {
    const r = rep(seed, { offense: 'mesh', coverage });
    play(r, 3, s => {
      for (const p of s.players) {
        const A = r.athletes.rigs.get(p.id);
        if (!p.engaged || A.spec.team !== 'offense' || r.athletes.animators.get(p.id).action !== 'block') continue;
        const q = s.players.find(o => o.id === p.engaged), B = r.athletes.rigs.get(q.id);
        if (r.athletes.animators.get(q.id).action !== 'block' || Math.hypot(p.x - q.x, p.z - q.z) < 0.6) continue;
        pairs++;
        const ha = helmet(A), hb = helmet(B);
        if (ha.distanceTo(hb) < 0.28 || bodyDistance(B, ha) < 0.13 || bodyDistance(A, hb) < 0.13) overlaps++;
        for (const [X, Y] of [[A, B], [B, A]]) for (const hand of X.world.hands) {
          const gap = bodyDistance(Y, hand);
          hands++; if (gap < -0.02) inside++; if (gap < 0.12) reached++;
        }
      }
    });
  }
  assert.ok(pairs > 300, `engaged frames sampled: ${pairs}`);
  assert.ok(overlaps / pairs < 0.01, `helmets clip in ${overlaps} of ${pairs} frames`);
  assert.ok(inside / hands < 0.03, `hands inside the other body: ${inside} of ${hands}`);
  assert.ok(reached / hands > 0.85, `hands on the other body: ${reached} of ${hands}`);
});

poseTest('on a pass play unengaged linemen sit in a pass set and coverage players crouch', () => {
  const set = [], cover = [];
  // Sample where a posture has blended fully in: a beaten lineman eases back
  // into his set, and zone defenders match and help, so few stand still for long.
  for (const [seed, offense, coverage] of [[2, 'mesh', 'cover3'], [3, 'curlflat', 'cover2'], [4, 'spacing', 'cover3'], [6, 'spacing', 'cover4'], [8, 'stick', 'man']]) {
    const r = rep(seed, { offense, coverage });
    play(r, 3.5, s => {
      if (s.time < 0.6) return;
      for (const p of s.players) {
        const rig = r.athletes.rigs.get(p.id), anim = r.athletes.animators.get(p.id), role = rig.spec.role;
        // Settled frames only: no crossfade from the last action still running.
        if (anim.action !== 'run' || anim.blend < 1) continue;
        const drop = rig.dims.hipY - rig.world.pelvis.y;
        // Hands up in front of the chest, not hanging at the sides.
        if (role === 'ol' && p.speed < 3 && anim.postures.set > 0.95) set.push({ drop, hands: rig.world.hands.every(h => h.y > rig.world.chest.y - 0.05) });
        if (['cb', 's', 'lb'].includes(role) && p.speed < 1.5 && anim.postures.cover > 0.9) cover.push(drop);
      }
    });
  }
  assert.ok(set.length > 20 && cover.length > 5, `samples ${set.length} / ${cover.length}`);
  assert.ok(set.every(s => s.drop > 0.1), 'linemen bend their knees in the set');
  assert.ok(set.filter(s => s.hands).length / set.length > 0.9, 'linemen keep their hands up');
  assert.ok(cover.every(d => d > 0.09), 'slow coverage players stay in a crouch');
});

poseTest('run blockers never show the pass set; pass blockers do', () => {
  // Highest 'set' posture over the five linemen while the quarterback still
  // has the ball (before the handoff on a run).
  const peak = offense => {
    const r = rep(1, { offense, coverage: 'cover3' });
    let most = 0;
    play(r, 1.5, s => {
      if (s.carrier !== 'QB') return;
      for (const p of s.players) if (r.athletes.rigs.get(p.id).spec.role === 'ol') most = Math.max(most, r.athletes.animators.get(p.id).postures.set);
    });
    return most;
  };
  const run = peak('power'), pass = peak('mesh');
  assert.ok(run < 0.2, `run blockers set to ${run.toFixed(2)} before the handoff`);
  assert.ok(pass > 0.9, `pass blockers set to ${pass.toFixed(2)}`);
});

poseTest('the quarterback sets in the pocket on staggered feet with the ball at his chest', () => {
  const r = rep(3, { offense: 'mesh', coverage: 'cover3' });
  const set = [];
  play(r, 2.4, s => {
    const qb = s.players.find(p => p.id === 'QB'), rig = r.athletes.rigs.get('QB'), anim = r.athletes.animators.get('QB');
    if (anim.action !== 'pocket' || qb.speed > 0.3 || s.time < 1.2) return;
    const f = rig.world.feet, yaw = rig.root.rotation.y, along = (f[0].x - f[1].x) * Math.sin(yaw) + (f[0].z - f[1].z) * Math.cos(yaw);
    set.push({ along, knees: rig.dims.hipY - rig.world.pelvis.y, ball: r.athletes.ball.position.y - rig.world.chest.y });
  });
  assert.ok(set.length > 10, `pocket frames: ${set.length}`);
  for (const s of set) {
    assert.ok(s.along > 0.25 && s.along < 0.45, `left foot forward by ${s.along.toFixed(2)} yd`);
    assert.ok(s.knees > 0.05, 'knees flexed');
    assert.ok(s.ball > 0.05 && s.ball < 0.4, `ball ${s.ball.toFixed(2)} yd above the chest joint`);
  }
});

poseTest('a replay that opens just after the snap starts from the stances', () => {
  const r = rep(3, { offense: 'flood', coverage: 'cover3' });
  play(r, 3, () => {}, () => ({ z: 1, sprint: true }));
  while (r.sim.phase !== 'dead') r.sim.step(STEP, { z: 1 });
  for (let i = 0; i < 60; i++) { r.sim.step(STEP); r.athletes.update(r.sim.snapshot(), 1 / 60); }
  // The replay's first rendered frame is usually the one after the snap.
  r.athletes.update(r.sim.recording[1], 0.1);
  for (const id of ['C', 'LT', 'DT1', 'CB1', 'FS']) assert.equal(r.athletes.animators.get(id).action, 'ready', id);
});

poseTest('only players the ball passes within reach of reach for it, and never from a block', () => {
  const r = rep(42, { offense: 'mesh', coverage: 'cover3' });
  const reachers = new Map();
  play(r, 6, s => {
    if (s.phase !== 'air') return;
    for (const p of s.players) {
      const anim = r.athletes.animators.get(p.id);
      if (!anim.reach) continue;
      assert.equal(p.engaged, null, `${p.id} reaches from a block`);
      assert.ok(anim.reach.dist <= 1.3, `${p.id} reaches for a ball ${anim.reach.dist.toFixed(2)} yd away`);
      reachers.set(p.id, Math.min(reachers.get(p.id) ?? 9, anim.reach.dist));
    }
  }, sim => {
    if (sim.phase === 'live' && sim.time > 1.8 && !sim.threw && !sim.throwIntent) sim.requestThrow('X', 'touch');
    return { z: sim.phase === 'run' ? 1 : 0 };
  });
  assert.ok(reachers.has('X'), 'the receiver reaches for the pass');
});

// ---------------------------------------------------------------------------
// Tackles. The runner is driven straight upfield until someone brings him
// down, then the rep runs on past the whistle so both men get back up.
function tackleRep(seed, offense, each) {
  const r = rep(seed, { offense, coverage: 'cover3' });
  r.sim.snap();
  let i = 0;
  const frame = () => { if (i++ % 2) { const s = r.sim.snapshot(); r.athletes.update(s, 1 / 60); each(s, r); } };
  while (r.sim.phase !== 'dead' && r.sim.time < 12) { r.sim.step(STEP, { z: 1, sprint: true }); frame(); }
  for (let k = 0; k < 5.5 / STEP; k++) { r.sim.step(STEP); frame(); }
  return r;
}
const TACKLE_REPS = [[1, 'zone'], [2, 'zone'], [3, 'zone'], [5, 'zone'], [1, 'power'], [2, 'power'], [4, 'stretch'], [2, 'counter'], [6, 'mesh']];
const JOINTS = rig => [rig.world.pelvis, rig.world.chest, rig.world.head, ...rig.world.hands, ...rig.world.feet];
const JOINT_NAMES = ['pelvis', 'chest', 'head', 'left hand', 'right hand', 'left foot', 'right foot'];
// Most a joint may move in one 60 Hz frame.
const STEP_LIMIT = [0.22, 0.25, 0.3, 0.45, 0.45, 0.4, 0.4];
const FLOOR = [0.08, 0.09, 0.05, -0.04, -0.04, 0.02, 0.02];

poseTest('a tackle keeps both men on top of the turf and moves them without a pop', () => {
  let tackles = 0, frames = 0;
  for (const [seed, offense] of TACKLE_REPS) {
    const last = new Map();
    tackleRep(seed, offense, (s, r) => {
      const tk = s.tackle;
      if (!tk) return;
      if (!last.size) tackles++;
      frames++;
      for (const id of [tk.carrier, tk.tackler, ...tk.helpers.map(h => h.id)]) {
        const p = s.players.find(q => q.id === id), rig = r.athletes.rigs.get(id), anim = r.athletes.animators.get(id);
        // Joints against his own root and against the runner's (a tackler
        // hanging on travels with the runner while the simulation lets his own
        // root trail behind), so neither root's travel counts as a jump.
        const c = s.players.find(q => q.id === tk.carrier);
        const now = JOINTS(rig).map(v => [new THREE.Vector3(v.x - p.x, v.y, v.z + p.z), new THREE.Vector3(v.x - c.x, v.y, v.z + c.z)]), before = last.get(id);
        const where = `${offense}/${seed} ${id} (${anim.action}) at ${(s.time + s.deadTime).toFixed(2)} s`;
        now.forEach(([v, w], k) => {
          assert.ok(v.y > FLOOR[k], `${where}: ${JOINT_NAMES[k]} at height ${v.y.toFixed(2)}`);
          if (!before) return;
          const moved = Math.min(v.distanceTo(before[k][0]), w.distanceTo(before[k][1]));
          assert.ok(moved < STEP_LIMIT[k], `${where}: ${JOINT_NAMES[k]} jumped ${moved.toFixed(2)} yd in a frame`);
        });
        last.set(id, now);
      }
    });
  }
  assert.ok(tackles >= 7 && frames > 1500, `tackles ${tackles}, frames ${frames}`);
});

poseTest('the tackler wraps the runner, they come to rest without lying inside each other, and both get up', () => {
  let wraps = 0, held = 0, piles = 0;
  const kinds = new Set();
  for (const [seed, offense] of TACKLE_REPS) {
    let seen = false;
    const r = tackleRep(seed, offense, (s, r) => {
      const tk = s.tackle, info = r.athletes.tackleCache.value;
      if (!tk || !info) return;
      seen = true;
      const A = r.athletes.rigs.get(tk.carrier), B = r.athletes.rigs.get(tk.tackler), T = s.time + s.deadTime - tk.at;
      kinds.add(info.layout + ':' + info.mode);
      // On his legs (not pulled down beside him): both hands stay on the
      // runner between the hit and the ground.
      if (info.layout !== 'lanes' && T > 0.15 && T < info.land) {
        const feet = A.world.feet[0].clone().add(A.world.feet[1]).multiplyScalar(0.5), legs = new THREE.Line3(A.world.pelvis, feet), near = new THREE.Vector3();
        for (const hand of B.world.hands) {
          wraps++;
          if (legs.closestPointToPoint(hand, true, near).distanceTo(hand) < 0.42) held++;
        }
      }
      // At rest: neither helmet inside the other man's pads, nor the
      // tackler's chest inside the runner's.
      if (s.phase === 'dead' && T > info.land + 0.3 && T < info.land + 0.5) {
        piles++;
        const ha = helmet(A), hb = helmet(B), where = `${offense}/${seed} ${info.layout} ${info.mode}`;
        assert.ok(ha.distanceTo(hb) > 0.24, `${where}: helmets ${ha.distanceTo(hb).toFixed(2)} yd apart`);
        assert.ok(bodyDistance(B, ha) > -0.08 && bodyDistance(A, hb) > -0.08, `${where}: a helmet inside the other man`);
        assert.ok(bodyDistance(A, B.world.chest) > -0.08, `${where}: the tackler's chest inside the runner`);
      }
    });
    if (!seen) continue;
    // Five seconds after the whistle everyone in it is standing again.
    const tk = r.sim.snapshot().tackle;
    for (const id of [tk.carrier, tk.tackler]) {
      const rig = r.athletes.rigs.get(id), anim = r.athletes.animators.get(id);
      assert.ok(!['tackled', 'tackle', 'assist'].includes(anim.action), `${offense}/${seed} ${id} still ${anim.action}`);
      assert.ok(rig.world.pelvis.y > 0.85 * rig.dims.hipY && rig.world.head.y > 1.5 * rig.dims.k, `${offense}/${seed} ${id} is not back on his feet`);
    }
  }
  assert.ok(wraps > 100 && piles > 40, `wrap samples ${wraps}, pile samples ${piles}`);
  assert.ok(held / wraps > 0.9, `hands on the runner in ${held} of ${wraps} samples`);
  assert.ok(kinds.size >= 3, `kinds of tackle seen: ${[...kinds].join(', ')}`);
});

poseTest('a replay that jumps into a pile shows the same pile as playing up to it', () => {
  let checked = 0;
  for (const [seed, offense] of TACKLE_REPS.slice(0, 4)) {
    const r = tackleRep(seed, offense, () => {});
    const frames = r.sim.recording, tk = frames.at(-1).tackle;
    if (!tk) continue;
    const info = r.athletes.tackleCache.value;
    // The replay plays its 20 Hz frames forward; remember the pile...
    const k = frames.findIndex(f => f.phase === 'dead' && f.time + f.deadTime - tk.at > info.land + 0.45);
    assert.ok(k > 3, `${offense}/${seed}: a recorded frame on the ground`);
    r.athletes.update(frames[0], 0.05);
    for (let i = 1; i <= k; i++) r.athletes.update(frames[i], 0.05);
    const played = [tk.carrier, tk.tackler].map(id => JOINTS(r.athletes.rigs.get(id)).map(v => v.clone()));
    // ...then scrub back to just after the snap and jump straight to it.
    r.athletes.update(frames[2], 0.05);
    r.athletes.update(frames[k], 0.05);
    [tk.carrier, tk.tackler].forEach((id, n) => JOINTS(r.athletes.rigs.get(id)).forEach((v, j) => {
      assert.ok(v.distanceTo(played[n][j]) < 0.06, `${offense}/${seed} ${id} ${JOINT_NAMES[j]} is ${v.distanceTo(played[n][j]).toFixed(2)} yd from where it was`);
    }));
    checked++;
  }
  assert.ok(checked >= 3, `piles checked: ${checked}`);
});

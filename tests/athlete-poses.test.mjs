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
  for (const [seed, offense, coverage] of [[2, 'mesh', 'cover3'], [3, 'curlflat', 'cover2'], [4, 'spacing', 'cover3']]) {
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
        if (['cb', 's', 'lb'].includes(role) && p.speed < 1 && anim.postures.cover > 0.95) cover.push(drop);
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

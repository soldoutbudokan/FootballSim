import test from 'node:test';
import assert from 'node:assert/strict';

// The athletes' skeleton and skinning, posed directly and skinned on the CPU
// exactly as the vertex shader does it (skin.js skinVertex). No WebGL.
const THREE = await import('../dist/vendor/three.module.js').catch(() => null);
const rigTest = (name, fn) => test(name, { skip: THREE ? false : 'run npm run check to vendor three.js' }, fn);
const model = THREE ? await import('../dist/js/athletes/rig.js') : {};
const { Pose, armAngles } = THREE ? await import('../dist/js/athletes/pose.js') : {};
const { HAND, setHand, aimHand } = THREE ? await import('../dist/js/athletes/hands.js') : {};
const skin = THREE ? await import('../dist/js/athletes/skin.js') : {};
const shapes = THREE ? await import('../dist/js/athletes/geometry.js') : {};

// A squad of the given roles at full detail, and a way to walk one man's
// skinned vertices: each(rig, (point, boneName, vertex) => ...) where boneName
// is the bone that vertex mostly follows.
function build(roles) {
  const specs = roles.map((role, i) => ({ id: role + i, role, number: 10 + i, team: i % 2 ? 'defense' : 'offense' }));
  const materials = { body: new THREE.MeshStandardMaterial(), helmet: new THREE.MeshStandardMaterial() };
  const squad = new model.Squad(new THREE.Scene(), specs.length, materials, { lod: false }), full = model.createGeometries();
  const rigs = specs.map((spec, i) => new model.Rig(squad, spec, i, full, { offset: [0, 0], scale: [1, 1], white: [0.5, 0.5] }));
  squad.finish();
  const g = squad.meshes.body.geometry, point = new THREE.Vector3();
  const vertices = rigs.map((rig, owner) => {
    const { base: [start, count] } = g.userData.ranges[owner], seen = new Set();
    for (let i = start; i < start + count; i++) seen.add(g.index.getX(i));
    return [...seen];
  });
  const each = (rig, fn) => {
    for (const v of vertices[rig.index]) fn(skin.skinVertex(g, squad.bones.data, v, point), model.BONES[g.attributes.athBones.getX(v) - rig.boneBase], v);
  };
  const dispose = () => {
    for (const x of Object.values(full)) x.dispose();
    for (const m of Object.values(squad.meshes)) m.geometry.dispose();
    squad.bones.texture.dispose(); materials.body.dispose(); materials.helmet.dispose();
  };
  return { squad, rigs, g, each, dispose };
}

// Standing, arms out in front, elbows a little bent.
function standing(rig, change = () => {}) {
  const pose = new Pose(), d = rig.dims;
  pose.pelvis.set(0, d.hipY - 0.03, 0);
  pose.feet[0].set(0.15, d.ankle, 0); pose.feet[1].set(-0.15, d.ankle, 0);
  armAngles(pose, 0, d, 1.2, 0.5, 0.15); armAngles(pose, 1, d, 1.2, 0.5, 0.15);
  change(pose, d);
  rig.apply(pose, 0, 0, 0);
  return pose;
}

rigTest('the skeleton keeps its first sixteen bones in place and fits its row of the bone texture', () => {
  assert.deepEqual(model.BONES.slice(0, 16), ['pelvis', 'abdomen', 'chest', 'head', 'thigh0', 'shin0', 'foot0', 'thigh1', 'shin1', 'foot1', 'upper0', 'fore0', 'hand0', 'upper1', 'fore1', 'hand1']);
  assert.equal(new Set(model.BONES).size, model.BONES.length);
  assert.ok(model.BONES.length <= model.BONE_STRIDE, `${model.BONES.length} bones in a row of ${model.BONE_STRIDE}`);
  for (const name of ['neck', 'clav0', 'pad1', 'swing0', 'toe1', 'upMid0', 'elbow1', 'foreTwist0', 'knee1', 'thumb1_0', 'pinky3_1']) assert.ok(model.BONES.includes(name), name);
  const { squad, rigs, dispose } = build(['qb', 'ol', 'cb']);
  try {
    const image = squad.bones.texture.image;
    assert.equal(image.width, 4 * model.BONE_STRIDE);
    assert.equal(image.height, rigs.length);
    assert.equal(rigs[2].boneBase, 2 * model.BONE_STRIDE);
  } finally { dispose(); }
});

rigTest('every vertex follows at most four bones of its own athlete, and their shares add up to one', () => {
  const { squad, rigs, dispose } = build(['wr', 'ol']);
  try {
    let blended = 0, all = 0;
    for (const mesh of Object.values(squad.meshes)) {
      const g = mesh.geometry, bones = g.attributes.athBones, w = g.attributes.athWeights;
      assert.equal(bones.itemSize, 4); assert.equal(w.itemSize, 3);
      for (const rig of rigs) {
        const { base: [start, count] } = g.userData.ranges[rig.index];
        for (let i = start; i < start + count; i++) {
          const v = g.index.getX(i), rest = w.getX(v) + w.getY(v) + w.getZ(v);
          assert.ok(rest >= 0 && rest <= 1 + 1e-6, `shares of vertex ${v}: ${rest}`);
          for (let k = 0; k < 4; k++) {
            const bone = bones.getComponent(v, k) - rig.boneBase;
            assert.ok(bone >= 0 && bone < model.BONES.length, `vertex ${v} follows bone ${bone} of another athlete`);
          }
          all++; if (rest > 0) blended++;
        }
      }
    }
    // Most of a body is rigid on one bone: those vertices fetch a single matrix.
    assert.ok(blended / all < 0.6, `blended vertex share ${(blended / all).toFixed(2)}`);
  } finally { dispose(); }
});

rigTest('poses carry the hands, toes, shoulders and neck when they are copied and blended', () => {
  const a = new Pose(), b = new Pose();
  assert.deepEqual([...a.fingers[0]], HAND.RELAXED.map(Math.fround), 'a new pose has relaxed hands');
  setHand(b, 1, HAND.FIST); b.toes[0] = 0.4; b.shoulders[1].set(0.2, 0.1); b.neck.set(0.3, 0, 0);
  aimHand(b, 0, new THREE.Vector3(0, -1, 0), new THREE.Vector3(0, 0, 1));
  const c = new Pose().copy(b);
  assert.deepEqual([...c.fingers[1]], [...b.fingers[1]]);
  assert.deepEqual([c.toes[0], c.shoulders[1].x, c.neck.x, c.aim[0], c.palm[0].y, c.point[0].z], [0.4, 0.2, 0.3, 1, -1, 1]);
  a.lerp(b, 0.5);
  assert.ok(Math.abs(a.fingers[1][1] - (HAND.RELAXED[1] + HAND.FIST[1]) / 2) < 1e-6);
  assert.ok(Math.abs(a.toes[0] - 0.2) < 1e-9 && Math.abs(a.neck.x - 0.15) < 1e-9 && Math.abs(a.aim[0] - 0.5) < 1e-9);
  // A hand that was not aimed takes the other's attitude whole; only the aim fades in.
  assert.deepEqual(a.palm[0].toArray(), [0, -1, 0]);
});

rigTest('a fist closes, a spread hand opens, and the right hand mirrors the left', () => {
  const { rigs: [rig], dispose } = build(['wr']);
  const tips = () => [0, 1].map(i => rig.digits[i].map(({ joints, length }, n) => {
    const tip = new THREE.Vector3(0, -length * (1 - shapes.HAND_DIGITS[n].joints[1]), 0).applyMatrix4(joints[2].matrixWorld);
    return { tip, toPalm: tip.distanceTo(rig.world.palms[i]) };
  }));
  try {
    standing(rig, pose => { setHand(pose, 0, HAND.FLAT); setHand(pose, 1, HAND.FLAT); });
    const flat = tips();
    standing(rig, pose => { setHand(pose, 0, HAND.FIST); setHand(pose, 1, HAND.FIST); });
    const fist = tips();
    standing(rig, pose => { setHand(pose, 0, HAND.SPREAD); setHand(pose, 1, HAND.SPREAD); });
    const spread = tips();
    for (const i of [0, 1]) {
      for (let n = 1; n < 5; n++) {
        assert.ok(flat[i][n].toPalm > 0.1, `flat finger ${n} reaches out (${flat[i][n].toPalm.toFixed(3)})`);
        assert.ok(fist[i][n].toPalm < 0.06, `fist finger ${n} is on the palm (${fist[i][n].toPalm.toFixed(3)})`);
      }
      assert.ok(spread[i][1].tip.distanceTo(spread[i][4].tip) > 1.25 * flat[i][1].tip.distanceTo(flat[i][4].tip), 'a spread hand is wider than a flat one');
      assert.ok(spread[i][0].tip.distanceTo(spread[i][1].tip) > flat[i][0].tip.distanceTo(flat[i][1].tip) + 0.02, 'the thumb goes out with the spread');
    }
    for (const shape of [flat, fist, spread]) {
      for (let n = 0; n < 5; n++) {
        const l = shape[0][n].tip, r = shape[1][n].tip;
        assert.ok(Math.abs(l.x + r.x) < 1e-3 && Math.abs(l.y - r.y) < 1e-3 && Math.abs(l.z - r.z) < 1e-3, `digit ${n} mirrors`);
      }
    }
  } finally { dispose(); }
});

rigTest('a forearm turned over keeps its girth at the wrist, and an elbow and a knee bent double keep theirs', () => {
  const { rigs: [rig], each, dispose } = build(['lb']);
  // Mean distance from a line (a, b) of the vertices that mostly follow one of `bones`.
  const girth = (bones, a, b) => {
    const axis = new THREE.Vector3().subVectors(b, a).normalize(), rel = new THREE.Vector3();
    let sum = 0, n = 0;
    each(rig, (p, bone) => {
      if (!bones.includes(bone)) return;
      rel.subVectors(p, a); rel.addScaledVector(axis, -rel.dot(axis));
      sum += rel.length(); n++;
    });
    assert.ok(n > 20, `${bones}: ${n} vertices`);
    return sum / n;
  };
  // The size of the ring a hinge's helper bone carries: mean distance from the joint.
  const ring = (bone, joint) => { let sum = 0, n = 0; each(rig, (p, b) => { if (b === bone) { sum += p.distanceTo(joint); n++; } }); assert.ok(n > 10, `${bone}: ${n} vertices`); return sum / n; };
  try {
    const W = rig.world;
    standing(rig);
    const wrist = girth(['foreTwist0'], W.elbows[0], W.hands[0]);
    standing(rig, pose => { pose.wrists[0].y = 1.5; });
    assert.ok(girth(['foreTwist0'], W.elbows[0], W.hands[0]) > 0.93 * wrist, 'the wrist does not wring like a towel');

    standing(rig, (pose, d) => { armAngles(pose, 0, d, 0.5, 0.2, 0.15); });
    const elbow = ring('elbow0', W.elbows[0]);
    standing(rig, (pose, d) => { armAngles(pose, 0, d, 0.5, 2.5, 0.15); });
    assert.ok(ring('elbow0', W.elbows[0]) > 0.9 * elbow, 'the elbow keeps its girth at 2.5 rad');

    standing(rig);
    const knee = ring('knee0', W.knees[0]);
    standing(rig, (pose, d) => { pose.pelvis.y = 0.42 * d.hipY; pose.pelvis.z = -0.2; });
    assert.ok(rig.shins[0].quaternion.w < Math.cos(1.0), 'the knee is bent past two radians');
    assert.ok(ring('knee0', W.knees[0]) > 0.9 * knee, 'the knee keeps its girth in a deep squat');
  } finally { dispose(); }
});

rigTest('a limb reaching its length eases straight instead of snapping, and reports what it cannot reach', () => {
  const { rigs: [rig], dispose } = build(['qb']);
  try {
    const d = rig.dims, leg = d.thigh + d.shin, bends = [];
    for (let n = 0; n <= 40; n++) {
      // The ankle goes down from 92 % of the leg to 8 % past it.
      standing(rig, pose => { pose.pelvis.y = d.ankle + leg * (0.92 + 0.004 * n); pose.feet[0].set(d.hipX, d.ankle, 0); });
      bends.push(2 * Math.acos(Math.min(1, Math.abs(rig.shins[0].quaternion.w))));
    }
    for (let n = 1; n < bends.length; n++) {
      assert.ok(bends[n] <= bends[n - 1] + 1e-6, 'the knee opens steadily');
      assert.ok(bends[n - 1] - bends[n] < 0.12, `no snap: ${(bends[n - 1] - bends[n]).toFixed(3)} rad for 0.4 % of the leg`);
    }
    assert.ok(bends.at(-1) > 0.05, 'a leg never locks dead straight');
    assert.ok(rig.world.reachShort.feet[0] > 0.02, 'the shortfall is reported');
    standing(rig);
    assert.equal(rig.world.reachShort.feet[0], 0);
  } finally { dispose(); }
});

rigTest('the head turns on a neck, the shoulder rises with the arm and the pad cap stays on the torso', () => {
  const { rigs: [rig], dispose } = build(['wr']);
  try {
    const W = rig.world, d = rig.dims, up = new THREE.Vector3();
    standing(rig);
    const head = W.head.clone(), shoulder = W.shoulders[1].y;
    standing(rig, pose => { pose.head.x = 0.7; });
    assert.ok(W.head.z > head.z + 0.01 && W.head.z < head.z + 0.06, 'looking down carries the head forward');
    // Arm straight overhead.
    standing(rig, pose => { pose.hands[1].set(-d.shoulder[0], d.shoulder[1] + 0.68 * d.k, 0.05); pose.elbows[1].set(-1, 0, -0.3); });
    assert.ok(W.shoulders[1].y > shoulder + 0.04, `the shoulder lifts (${(W.shoulders[1].y - shoulder).toFixed(3)} yd)`);
    up.set(0, 1, 0).applyQuaternion(rig.pads[1].getWorldQuaternion(new THREE.Quaternion()));
    assert.ok(Math.acos(Math.min(1, up.y)) < 0.85, `the cap tips ${Math.acos(Math.min(1, up.y)).toFixed(2)} rad, not all the way over`);
    // Arm hanging: the cap does not move at all.
    standing(rig, (pose, dims) => { armAngles(pose, 1, dims, 0.1, 0.2, 0.15); });
    up.set(0, 1, 0).applyQuaternion(rig.pads[1].getWorldQuaternion(new THREE.Quaternion()));
    assert.ok(up.y > 0.999);
  } finally { dispose(); }
});

rigTest('heel up on the turf, the shoe bends at the ball of the foot; in the air it stays straight', () => {
  const { rigs: [rig], dispose } = build(['rb']);
  const forward = bone => new THREE.Vector3(0, 0, 1).applyQuaternion(bone.getWorldQuaternion(new THREE.Quaternion()));
  try {
    const d = rig.dims;
    standing(rig, pose => { pose.footRot[0].x = 0.8; pose.feet[0].y = d.ankle + 0.09 * d.k; });
    assert.ok(forward(rig.feet[0]).y < -0.6, 'the foot is pitched heel up');
    assert.ok(Math.abs(forward(rig.toes[0]).y) < 0.12, `the toes lie flat (${forward(rig.toes[0]).y.toFixed(2)})`);
    standing(rig, pose => { pose.footRot[0].x = 0.8; pose.feet[0].y = d.ankle + 0.4; });
    assert.ok(forward(rig.toes[0]).y < -0.6, 'a foot in the air is straight');
  } finally { dispose(); }
});

rigTest('a body that is down keeps its knees, ankles and toes on top of the turf', () => {
  const { rigs: [rig], dispose } = build(['lb']);
  try {
    const pose = new Pose(), d = rig.dims;
    // Face down, the pose asking for a leg driven into the ground.
    pose.tiltPitch = 1.45; pose.tiltLift = 0.14;
    pose.pelvis.set(0, d.hipY, 0);
    pose.feet[0].set(0.15, 0.1, -0.2); pose.feet[1].set(-0.2, 0.3, -0.35);
    pose.footRot[0].x = pose.footRot[1].x = 1.25;
    rig.apply(pose, 0, 0, 0);
    for (const i of [0, 1]) {
      assert.ok(rig.world.knees[i].y > 0.05, `knee ${i} at ${rig.world.knees[i].y.toFixed(3)}`);
      assert.ok(rig.world.feet[i].y > 0.05, `ankle ${i} at ${rig.world.feet[i].y.toFixed(3)}`);
      assert.ok(rig.world.toes[i].y > 0, `toes ${i} at ${rig.world.toes[i].y.toFixed(3)}`);
    }
  } finally { dispose(); }
});

rigTest('the pants are one surface per side: the halves meet on the midline and only the waist is open', () => {
  for (const low of [false, true]) {
    const g = shapes.pants({ low }), p = g.attributes.position, seat = g.attributes.seat, H = shapes.PANTS.hip;
    let front = 0, back = 0;
    for (let i = 0; i < p.count; i++) {
      assert.ok(p.getX(i) >= -H - 1e-6, 'nothing crosses the midline');
      if (Math.abs(p.getX(i) + H) < 1e-6 && p.getY(i) > 0) { if (p.getZ(i) > 0) front++; else back++; }
      // Above the split the hips panel of the atlas, below it the leg panel.
      assert.equal(seat.getX(i) >= 0, seat.getY(i) >= 0);
      if (p.getY(i) > shapes.PANTS.split + 1e-6) assert.ok(seat.getX(i) >= 0 && seat.getX(i) <= 1, 'the seat has its place on the hips panel');
      if (p.getY(i) < shapes.PANTS.split - 1e-6) assert.ok(seat.getX(i) < 0, 'the leg does not');
    }
    assert.ok(front > 3 && back > 3, 'the fly and the seat seam lie on the midline');
    // Open edges, with the doubled ring welded: only the waistband and the cut at the midline.
    const key = i => [p.getX(i), p.getY(i), p.getZ(i)].map(v => Math.round(v * 1e5)).join(','), edges = new Map();
    for (let i = 0; i < g.index.count; i += 3) {
      const t = [0, 1, 2].map(k => g.index.getX(i + k));
      for (let k = 0; k < 3; k++) { const a = key(t[k]), b = key(t[(k + 1) % 3]), e = a < b ? a + '|' + b : b + '|' + a; edges.set(e, [(edges.get(e)?.[0] || 0) + 1, t[k], t[(k + 1) % 3]]); }
    }
    for (const [n, a, b] of edges.values()) {
      if (n !== 1) continue;
      const waist = Math.abs(p.getY(a) - shapes.PANTS.top) < 1e-6 && Math.abs(p.getY(b) - shapes.PANTS.top) < 1e-6;
      const midline = Math.abs(p.getX(a) + H) < 1e-6 && Math.abs(p.getX(b) + H) < 1e-6;
      assert.ok(waist || midline, `an open edge at y ${p.getY(a).toFixed(3)}`);
    }
    g.dispose();
  }
});

rigTest('a tackle stands a head over a corner and carries a belly; no two men are built alike', () => {
  const { rigs, each, dispose } = build(['ol', 'cb', 'wr', 'wr']);
  try {
    const [ol, cb, wr, wr2] = rigs;
    assert.ok(ol.dims.k > cb.dims.k * 1.06, 'height by position');
    assert.ok(wr.dims.torso !== wr2.dims.torso || wr.dims.limb !== wr2.dims.limb, 'two receivers differ');
    // Bind pose: how far the front of the jersey stands out at the navel and at the chest plate.
    const frontAt = (rig, lo, hi) => { let z = 0; const y0 = rig.dims.hipY + rig.dims.waist; each(rig, (p, bone) => { if ((bone === 'abdomen' || bone === 'chest') && p.y > y0 + lo && p.y < y0 + hi) z = Math.max(z, p.z); }); return z; };
    for (const rig of rigs) rig.apply(new Pose(), 0, 0, 0);
    const pose = new Pose();
    for (const rig of [ol, cb]) { pose.pelvis.set(0, rig.dims.hipY, 0); pose.feet[0].set(0.15, rig.dims.ankle, 0); pose.feet[1].set(-0.15, rig.dims.ankle, 0); rig.apply(pose, 0, 0, 0); }
    assert.ok(frontAt(ol, 0, 0.12) > frontAt(ol, 0.3, 0.45) - 0.01, 'the lineman\'s belly is level with his chest plate or ahead of it');
    assert.ok(frontAt(cb, 0, 0.12) < frontAt(cb, 0.3, 0.45) - 0.02, 'the corner\'s waist is behind his');
  } finally { dispose(); }
});

rigTest('sideline staff are the athletes\' body in plain clothes: posed, baked, bare-headed under a cap', async () => {
  const { bakeFigure, FIGURE_POSES } = await import('../dist/js/athletes/figures.js');
  const box = new THREE.Box3(), hands = {};
  for (const pose of FIGURE_POSES) {
    const figure = bakeFigure(pose);
    assert.equal(bakeFigure(pose), figure, 'a pose is baked once');
    box.makeEmpty();
    for (const kind of ['shirt', 'trousers', 'skin', 'shoes', 'cap', 'dark', 'white']) {
      const g = figure[kind];
      assert.ok(g && g.index.count > 0 && g.attributes.normal, `${pose}: ${kind}`);
      assert.ok([...g.attributes.position.array].every(Number.isFinite), `${pose}: ${kind} is finite`);
      g.computeBoundingBox(); box.union(g.boundingBox);
    }
    assert.ok(box.min.y > -0.02 && box.min.y < 0.03, `${pose}: stands on the ground (${box.min.y.toFixed(3)})`);
    assert.ok(box.max.y > 1.9 && box.max.y < 2.12, `${pose}: about 5 ft 10 in under his cap (${box.max.y.toFixed(2)} yd)`);
    assert.equal(!!figure.sheet, pose === 'clipboard');
    const triangles = Object.values(figure).reduce((n, g) => n + (g ? g.index.count / 3 : 0), 0);
    assert.ok(triangles < 5000, `${pose}: ${triangles} triangles`);
    figure.skin.computeBoundingBox();
    hands[pose] = figure.skin.boundingBox.min.y;
  }
  // The poses are different people: hands hang by the thigh at ease and are up at the hips or the chest otherwise.
  assert.ok(hands.atEase < 0.95 && hands.armsCrossed > 1.2, `hands at ${hands.atEase.toFixed(2)} at ease, ${hands.armsCrossed.toFixed(2)} folded`);
});

rigTest('the close-up level: a finer body baked for one athlete from any pose, drawn in place of his share of the squad', () => {
  const { squad, rigs, g, each, dispose } = build(['wr', 'ol']);
  const hero = model.createGeometries({ hero: true });
  try {
    const [wr, ol] = rigs, point = new THREE.Vector3();
    // Baked while he is in a pose, not standing in the bind pose.
    const pose = standing(ol, (p, d) => { p.pelvis.y = 0.7 * d.hipY; p.hips.x = 0.6; setHand(p, 0, HAND.FIST); });
    const posed = squad.bones.data.slice(), hand = ol.world.hands[0].clone();
    const geometry = ol.buildHero(hero);
    assert.deepEqual(squad.bones.data, posed, 'the bake leaves the bones as they were');
    ol.apply(pose, 0, 0, 0);
    assert.ok(ol.world.hands[0].distanceTo(hand) < 1e-9, 'and the joints in the pose they were in');
    // Twice the triangles of his full body and more, within the budget for a few men.
    const { base, detail } = g.userData.ranges[ol.index], full = (base[1] + detail[1]) / 3, fine = geometry.index.count / 3;
    assert.ok(fine > 1.8 * full && fine < 32000, `close-up body: ${fine} triangles against ${full}`);
    // The same man in the same place: skinned, the two bodies fill the same box.
    const box = new THREE.Box3(), fineBox = new THREE.Box3();
    each(ol, p => box.expandByPoint(p));
    for (let i = 0; i < geometry.attributes.position.count; i++) fineBox.expandByPoint(skin.skinVertex(geometry, squad.bones.data, i, point));
    for (const axis of ['x', 'y', 'z']) {
      assert.ok(Math.abs(box.min[axis] - fineBox.min[axis]) < 0.012 && Math.abs(box.max[axis] - fineBox.max[axis]) < 0.012, `${axis}: ${fineBox.min[axis].toFixed(3)}..${fineBox.max[axis].toFixed(3)} against ${box.min[axis].toFixed(3)}..${box.max[axis].toFixed(3)}`);
    }
    // Drawing: his body from his own mesh, his helmet still from the squad's.
    const drawn = mesh => mesh.geometry.groups.reduce((n, group) => n + group.count, 0);
    const bodyAll = drawn(squad.meshes.body), helmetAll = drawn(squad.meshes.helmet);
    squad.setLevels(Uint8Array.of(0, model.HERO));
    assert.equal(drawn(squad.meshes.body), bodyAll, 'without a close-up mesh he stays in the full one');
    squad.addHero(ol.index, geometry);
    assert.equal(squad.hero.get(ol.index).visible, false);
    squad.setLevels(Uint8Array.of(0, model.HERO));
    assert.equal(squad.hero.get(ol.index).visible, true);
    assert.equal(drawn(squad.meshes.body), bodyAll - base[1] - detail[1]);
    assert.equal(drawn(squad.meshes.helmet), helmetAll);
    squad.removeHero(ol.index);
    assert.equal(squad.hero.size, 0);
    assert.equal(drawn(squad.meshes.body), bodyAll, 'and returns to it when the close-up mesh is dropped');
    assert.ok(wr);
  } finally { for (const x of Object.values(hero)) x.dispose(); dispose(); }
});

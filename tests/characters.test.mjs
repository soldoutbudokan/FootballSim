// Skinned-character pipeline: the decisions that do not need WebGL.
// Only renderer-free modules are imported here (CI runs `npm test` before
// the vendored three.js files exist).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mapSkeleton, classifyBone, stripRigPrefix, retargetNames, renameMap, MIXAMO_MAP, REQUIRED_BONES, CANONICAL_BONES } from '../dist/js/characters/bones.js';
import { CLIP_SLOTS, REQUIRED_SLOTS, slotForClipName, assignSlots, resolveSlot, resolveModelIndex, buildModelIndex } from '../dist/js/characters/clips.js';
import { analyseGait, strideRate, targetCadence, blendSpace1D, CADENCE_RANGE } from '../dist/js/characters/gait.js';
import { planAnimation, locomotionPoints, derive, visualAction, stanceFor, ActionClock, approachWeights, estimateLean, THROW_RELEASE } from '../dist/js/characters/blend.js';
import { uniformFor, slotForMaterial, recolourMode, classifyRegions, REGIONS, COLORS, SKIN_TONES } from '../dist/js/characters/palette.js';
import { clusterVertices, remapTriangles, gather } from '../dist/js/characters/lod.js';
import { athletesChoice, athletesParam, modelPublished, readModelIndex, CHARACTER_MODEL_URL, DEV_CHARACTER_URL } from '../dist/js/characters/choose.js';

const near = (actual, expected, tolerance, message) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message ?? ''} expected ${expected} ± ${tolerance}, got ${actual}`);

// [name, parentName] pairs -> the {name, parent index} list mapSkeleton takes.
function skeleton(pairs) {
  const index = new Map(pairs.map(([name], i) => [name, i]));
  return pairs.map(([name, parent]) => ({ name, parent: parent ? index.get(parent) : -1 }));
}

// A humanoid with the given naming function: name(canonical) -> bone name.
function humanoid(name, { root = null } = {}) {
  const pairs = root ? [[root, null]] : [];
  const add = (c, parent) => pairs.push([name(c), parent ? name(parent) : root]);
  add('Hips', null);
  add('Spine', 'Hips'); add('Spine1', 'Spine'); add('Spine2', 'Spine1'); add('Neck', 'Spine2'); add('Head', 'Neck');
  for (const s of ['Left', 'Right']) {
    add(s + 'Shoulder', 'Spine2'); add(s + 'Arm', s + 'Shoulder'); add(s + 'ForeArm', s + 'Arm'); add(s + 'Hand', s + 'ForeArm');
    pairs.push([name(s + 'Hand') + '_Index1', name(s + 'Hand')]);
    add(s + 'UpLeg', 'Hips'); add(s + 'Leg', s + 'UpLeg'); add(s + 'Foot', s + 'Leg'); add(s + 'ToeBase', s + 'Foot');
  }
  return skeleton(pairs);
}

// ---- bone mapping -------------------------------------------------------------

test('Mixamo rigs map exactly, with or without the namespace three.js strips', () => {
  for (const prefix of ['mixamorig:', 'mixamorig', 'mixamorig1:', 'mixamorig7_']) {
    const result = mapSkeleton(humanoid(c => prefix + c, { root: 'Armature' }));
    assert.ok(result.ok, prefix);
    assert.deepEqual(result.missing, [], prefix);
    for (const c of CANONICAL_BONES) assert.equal(result.map[c], prefix + c, `${prefix}${c}`);
    assert.ok(Object.values(result.how).every(h => h === 'exact'), prefix);
  }
  assert.equal(MIXAMO_MAP['mixamorig:LeftForeArm'], 'LeftForeArm');
  assert.equal(MIXAMO_MAP.mixamorigHips, 'Hips');
  assert.equal(stripRigPrefix('Armature|mixamorig:RightHand'), 'RightHand');
});

test('the generic humanoid map covers Unreal, VRM/Unity and 3ds Max Biped rigs', () => {
  const unreal = { Hips: 'pelvis', Spine: 'spine_01', Spine1: 'spine_02', Spine2: 'spine_03', Neck: 'neck_01', Head: 'head' };
  const ue = c => unreal[c] || c.replace(/^(Left|Right)(.*)$/, (_, s, p) => ({ Shoulder: 'clavicle', Arm: 'upperarm', ForeArm: 'lowerarm', Hand: 'hand', UpLeg: 'thigh', Leg: 'calf', Foot: 'foot', ToeBase: 'ball' }[p] + '_' + s[0].toLowerCase()));
  const vrm = { Hips: 'Hips', Spine: 'Spine', Spine1: 'Chest', Spine2: 'UpperChest', Neck: 'Neck', Head: 'Head' };
  const unity = c => vrm[c] || c.replace(/^(Left|Right)(.*)$/, (_, s, p) => ({ Shoulder: 'Shoulder', Arm: 'UpperArm', ForeArm: 'LowerArm', Hand: 'Hand', UpLeg: 'UpperLeg', Leg: 'LowerLeg', Foot: 'Foot', ToeBase: 'Toes' }[p] + '.' + s[0]));
  const biped = { Hips: 'Bip01 Pelvis', Spine: 'Bip01 Spine', Spine1: 'Bip01 Spine1', Spine2: 'Bip01 Spine2', Neck: 'Bip01 Neck', Head: 'Bip01 Head' };
  const max = c => biped[c] || c.replace(/^(Left|Right)(.*)$/, (_, s, p) => 'Bip01 ' + s[0] + ' ' + ({ Shoulder: 'Clavicle', Arm: 'UpperArm', ForeArm: 'Forearm', Hand: 'Hand', UpLeg: 'Thigh', Leg: 'Calf', Foot: 'Foot', ToeBase: 'Toe0' }[p]));
  for (const [label, name] of [['unreal', ue], ['unity', unity], ['biped', max]]) {
    const result = mapSkeleton(humanoid(name, { root: 'root' }));
    assert.ok(result.ok, label);
    assert.deepEqual(result.missing, [], label);
    for (const c of CANONICAL_BONES) assert.equal(result.map[c], name(c), `${label} ${c}`);
  }
});

test('unknown naming schemes are auto-detected from words, the hierarchy and name similarity', () => {
  // Words: "LeftThighJnt", "RightCollarJnt"; two spine bones resolved by the chain.
  const rig = skeleton([
    ['Root', null], ['PelvisJnt', 'Root'], ['SpineLower', 'PelvisJnt'], ['SpineUpper', 'SpineLower'], ['NeckJnt', 'SpineUpper'], ['HeadJnt', 'NeckJnt'],
    ['LeftCollarJnt', 'SpineUpper'], ['LeftUpperArmJnt', 'LeftCollarJnt'], ['LeftForearmJnt', 'LeftUpperArmJnt'], ['LeftHandJnt', 'LeftForearmJnt'],
    ['RightCollarJnt', 'SpineUpper'], ['RightUpperArmJnt', 'RightCollarJnt'], ['RightForearmJnt', 'RightUpperArmJnt'], ['RightHandJnt', 'RightForearmJnt'],
    ['LeftThighJnt', 'PelvisJnt'], ['LeftShinJnt', 'LeftThighJnt'], ['LeftFootJnt', 'LeftShinJnt'],
    ['RightThighJnt', 'PelvisJnt'], ['RightShinJnt', 'RightThighJnt'], ['RightFootJnt', 'RightShinJnt'],
  ]);
  const result = mapSkeleton(rig);
  assert.ok(result.ok);
  assert.equal(result.map.Hips, 'PelvisJnt');
  assert.equal(result.map.Spine, 'SpineLower');
  assert.equal(result.map.Spine2, 'SpineUpper');
  assert.equal(result.map.LeftShoulder, 'LeftCollarJnt');
  assert.equal(result.map.RightForeArm, 'RightForearmJnt');
  assert.equal(result.map.LeftLeg, 'LeftShinJnt');
  assert.equal(result.how.Spine, 'chain');
  // A misspelling only the similarity pass recognises, kept on its own side.
  const typo = humanoid(c => (c === 'LeftForeArm' ? 'Left_Forarm' : c === 'RightForeArm' ? 'Right_Forarm' : c));
  const fuzzy = mapSkeleton(typo);
  assert.equal(fuzzy.map.LeftForeArm, 'Left_Forarm');
  assert.equal(fuzzy.map.RightForeArm, 'Right_Forarm');
  assert.equal(fuzzy.how.LeftForeArm, 'similar');
  // Fingers and helper bones never become limbs.
  assert.equal(classifyBone('LeftHandIndex1'), null);
  assert.equal(classifyBone('upperarm_twist_01_l'), null);
  assert.equal(classifyBone('DEF-thigh.L'), 'LeftUpLeg');
});

test('a rig without hands or feet is rejected with the missing bones named', () => {
  const pairs = humanoid(c => c).filter(b => !/Hand|Foot|Toe/.test(b.name));
  // Re-index parents after filtering.
  const names = humanoid(c => c).map(b => b.name);
  const kept = pairs.map(b => ({ name: b.name, parent: b.parent < 0 ? -1 : pairs.findIndex(p => p.name === names[b.parent]) }));
  const result = mapSkeleton(kept);
  assert.equal(result.ok, false);
  for (const bone of ['LeftHand', 'RightHand', 'LeftFoot', 'RightFoot']) assert.ok(result.missing.includes(bone), bone);
  assert.ok(REQUIRED_BONES.includes('LeftFoot'));
});

test('retargeting names join two rigs through the canonical skeleton', () => {
  const target = mapSkeleton(humanoid(c => 'mixamorig' + c)).map;
  const source = mapSkeleton(humanoid(c => ({ Hips: 'pelvis', LeftArm: 'upperarm_l' }[c] || c))).map;
  const names = retargetNames(target, source);
  assert.equal(names.mixamorigHips, 'pelvis');
  assert.equal(names.mixamorigLeftArm, 'upperarm_l');
  assert.equal(Object.keys(names).length, CANONICAL_BONES.length);
  // Two Mixamo characters share every bone (fingers too) by stripped name.
  const rename = renameMap(['mixamorigHips', 'mixamorigLeftHandIndex1'], ['mixamorig:Hips', 'mixamorig:LeftHandIndex1', 'Extra']);
  assert.deepEqual(rename, { 'mixamorig:Hips': 'mixamorigHips', 'mixamorig:LeftHandIndex1': 'mixamorigLeftHandIndex1' });
});

// ---- clip slots ---------------------------------------------------------------

test('clip files and clip names find their slot (Mixamo names included)', () => {
  const cases = {
    'clips/run.glb': 'run', 'clips/shuffle-left.fbx': 'shuffle-left', 'clips/stance3.glb': 'stance3', 'clips/getup.fbx': 'getup',
    'Running (1).fbx': 'run', 'Fast_Run': 'sprint', 'Standing Idle': 'idle', 'Breathing Idle.fbx': 'idle',
    'Running Backward': 'backpedal', 'Jog Strafe Left': 'shuffle-left', 'Quarterback Pass': 'throw', 'Football Hike': 'stance3',
    'run_inplace': 'run', 'Catching': 'catch', 'Armature|Walking': 'walk',
    'Armature|mixamo.com|Layer0': null, 'Samba Dancing': null, '': null,
  };
  for (const [name, slot] of Object.entries(cases)) assert.equal(slotForClipName(name), slot, name);
  for (const slot of CLIP_SLOTS) assert.equal(slotForClipName(`clips/${slot}.fbx`), slot, slot);
  assert.deepEqual(REQUIRED_SLOTS, ['idle', 'run']);
});

test('separate clip files win over clips embedded in the model; aliases force a slot', () => {
  const clips = [
    { name: 'Run', source: 'model' }, { name: 'mixamo.com', fileName: 'run', source: 'file' },
    { name: 'Idle', source: 'model' }, { name: 'Take 001', source: 'model' },
  ];
  const slots = assignSlots(clips, { throw: 'Take 001' });
  assert.equal(slots.run.source, 'file');
  assert.equal(slots.idle.name, 'Idle');
  assert.equal(slots.throw.name, 'Take 001');
  assert.equal(Object.keys(slots).length, 3);
});

test('a missing locomotion slot falls back to a neighbouring clip; actions do not borrow', () => {
  const available = new Set(['idle', 'walk', 'run']);
  assert.equal(resolveSlot('jog', available), 'run');
  assert.equal(resolveSlot('sprint', available), 'run');
  assert.equal(resolveSlot('stance3', available), 'idle');
  assert.equal(resolveSlot('throw', available), null);
  assert.equal(resolveSlot('catch', new Set(['throw'])), null);
});

test('the model index lists dist/models/player.glb and its clip files', () => {
  const index = buildModelIndex(['clips/run.fbx', 'player.glb', 'README.txt', 'clips/idle.glb', 'clips/nested/x.glb']);
  assert.deepEqual(index, { model: 'player.glb', clips: ['clips/idle.glb', 'clips/run.fbx'] });
  const resolved = resolveModelIndex(index, './models/');
  assert.equal(resolved.modelUrl, './models/player.glb');
  assert.deepEqual(resolved.clipUrls, { idle: './models/clips/idle.glb', run: './models/clips/run.fbx' });
  assert.equal(resolveModelIndex({ clips: [] }), null);
});

// ---- gait and time scale ----------------------------------------------------

// One cycle of a synthetic in-place run: each foot is planted for 60 % of
// the cycle sliding back at a constant speed, then swings forward.
function syntheticGait({ period = 0.7, reach = 0.5, n = 64 } = {}) {
  const s = { times: [], leftY: [], leftZ: [], rightY: [], rightZ: [], hipsZ: [] };
  const foot = u => {
    u -= Math.floor(u);
    if (u < 0.6) return { z: reach - 2 * reach * (u / 0.6), y: 0 };
    const k = (u - 0.6) / 0.4;
    return { z: -reach + 2 * reach * k, y: 0.25 * Math.sin(Math.PI * k) };
  };
  for (let i = 0; i < n; i++) {
    const u = i / n, l = foot(u), r = foot(u + 0.5);
    s.times.push(u * period); s.leftY.push(l.y); s.leftZ.push(l.z); s.rightY.push(r.y); s.rightZ.push(r.z); s.hipsZ.push(0);
  }
  return { samples: s, period, groundSpeed: (2 * reach) / (0.6 * period) };
}

test('gait analysis measures steps, cadence and the natural ground speed of a clip', () => {
  const { samples, period, groundSpeed } = syntheticGait();
  const gait = analyseGait(samples, period);
  assert.equal(gait.steps, 2);
  assert.equal(gait.cycles, 1);
  near(gait.cadence, 2 / period, 1e-9, 'cadence');
  near(gait.speed, groundSpeed, groundSpeed * 0.05, 'speed');
  near(gait.stride, groundSpeed / gait.cadence, 0.06, 'stride');
  assert.equal(gait.rootMotion, false);
  // A standing clip is not a gait.
  const still = { times: [], leftY: [], leftZ: [], rightY: [], rightZ: [], hipsZ: [] };
  for (let i = 0; i < 32; i++) { still.times.push(i / 16); still.leftY.push(0); still.rightY.push(0); still.leftZ.push(0.1 + 0.005 * Math.sin(i)); still.rightZ.push(-0.1); still.hipsZ.push(0); }
  assert.equal(analyseGait(still, 2), null);
});

test('cadence follows the human curve and sets each clip\'s time scale', () => {
  near(targetCadence(5), 3.2, 1e-9);
  near(targetCadence(9), 4.5, 1e-9);
  assert.ok(targetCadence(0) < targetCadence(3) && targetCadence(3) < targetCadence(7));
  // A clip whose stride fits: cadence = speed / stride, feet do not slide.
  const fits = { steps: 2, cadence: 2.857, stride: 1.5 };
  const a = strideRate(fits, 5);
  near(a.timeScale, (5 / 1.5) / 2.857, 1e-9, 'timeScale');
  near(a.cycleRate, (5 / 1.5) / 2, 1e-9, 'cycleRate');
  assert.equal(a.stretch, 1);
  // A short-strided jog clip at sprint speed: cadence capped near the curve,
  // stride stretched to make up the rest.
  const jog = { steps: 2, cadence: 2.857, stride: 1.206 };
  const b = strideRate(jog, 9);
  const cadence = b.timeScale * jog.cadence;
  near(cadence, targetCadence(9) * CADENCE_RANGE[1], 1e-9, 'capped cadence');
  near(b.stretch, 9 / (cadence * jog.stride), 1e-9, 'stretch');
  assert.ok(b.stretch > 1.3 && b.stretch <= 1.6);
  // No gait data: play as authored.
  assert.deepEqual(strideRate(null, 4), { timeScale: 1, cycleRate: 0, stretch: 1 });
});

test('the 1D blend space returns two neighbours whose weights sum to one', () => {
  const points = [{ slot: 'idle', speed: 0 }, { slot: 'walk', speed: 1.6 }, { slot: 'run', speed: 6 }, { slot: 'sprint', speed: 8.6 }];
  assert.deepEqual(blendSpace1D(points, 0), [{ slot: 'idle', weight: 1 }]);
  assert.deepEqual(blendSpace1D(points, 12), [{ slot: 'sprint', weight: 1 }]);
  const mid = blendSpace1D(points, 7.3);
  assert.deepEqual(mid.map(e => e.slot), ['run', 'sprint']);
  near(mid[0].weight + mid[1].weight, 1, 1e-12);
  near(mid[1].weight, 0.5, 1e-12);
});

// ---- the blend tree -------------------------------------------------------------

const XBOT_GAITS = {
  walk: { steps: 2, cycles: 1, duration: 0.967, cadence: 2.069, speed: 1.722, stride: 0.832, leftStrike: 0.27 },
  run: { steps: 2, cycles: 1, duration: 0.7, cadence: 2.857, speed: 3.447, stride: 1.206, leftStrike: 0.28 },
};
const MINIMAL = { available: new Set(['idle', 'walk', 'run']), gaits: XBOT_GAITS };
const FULL = {
  available: new Set(CLIP_SLOTS),
  gaits: { ...XBOT_GAITS, jog: { steps: 2, cadence: 2.6, stride: 1.4, speed: 3.6 }, sprint: { steps: 2, cadence: 4.3, stride: 2.0, speed: 8.6 }, backpedal: { steps: 2, cadence: 3, stride: 1, speed: 3 } },
};
const RB = { id: 'R', role: 'rb', team: 'offense' };
const runner = (speed, extra = {}) => ({ id: 'R', x: 0, z: 30, vx: 0, vz: speed, facing: 0, action: 'run', actionTime: 0, ...extra });
const weightsOf = plan => Object.fromEntries(plan.locomotion.map(e => [e.slot, e.weight]));

test('locomotion blends idle, walk, jog, run and sprint by speed', () => {
  assert.deepEqual(locomotionPoints(FULL.available, FULL.gaits).map(p => p.slot), ['idle', 'walk', 'jog', 'run', 'sprint']);
  const live = { phase: 'live' };
  assert.deepEqual(weightsOf(planAnimation(runner(0), RB, live, 0, FULL)), { idle: 1 });
  const jogging = weightsOf(planAnimation(runner(4.8), RB, live, 0, FULL));
  assert.deepEqual(Object.keys(jogging), ['jog', 'run']);
  near(jogging.jog + jogging.run, 1, 1e-9);
  assert.deepEqual(weightsOf(planAnimation(runner(9.3), RB, live, 0, FULL)), { sprint: 1 });
  // With only idle/walk/run (the stand-in), measured speeds place the clips.
  const minimal = weightsOf(planAnimation(runner(2.5), RB, live, 0, MINIMAL));
  near(minimal.walk, 1 - (2.5 - 1.722) / (3.447 - 1.722), 1e-9, 'walk weight');
  near(minimal.run, (2.5 - 1.722) / (3.447 - 1.722), 1e-9, 'run weight');
  // Faster running means a faster stride cycle, and the stride stretches
  // beyond what the stand-in's jog-like run clip covers.
  const slow = planAnimation(runner(5), RB, live, 0, MINIMAL), fast = planAnimation(runner(9), RB, live, 0, MINIMAL);
  assert.ok(fast.cycleRate > slow.cycleRate);
  assert.ok(fast.stretch > slow.stretch && fast.stretch > 1.2);
  near(fast.cycleRate * 2, targetCadence(9) * CADENCE_RANGE[1], 1e-9, 'steps per second at 9 yd/s');
});

test('backpedal and side shuffles: a dedicated clip when present, else reversed locomotion with posture', () => {
  const cb = { id: 'CB1', role: 'cb', team: 'defense' };
  const back = { id: 'CB1', vx: 0, vz: 3, facing: Math.PI, action: 'run', backpedal: true };
  const withClip = planAnimation(back, cb, { phase: 'live' }, 0, FULL);
  assert.equal(withClip.mode, 'backpedal');
  assert.equal(withClip.locomotion[0].slot, 'backpedal');
  assert.equal(withClip.reverse, false);
  const without = planAnimation(back, cb, { phase: 'live' }, 0, MINIMAL);
  assert.equal(without.reverse, true);
  assert.equal(without.procedural.backpedal, true);
  // The backpedal flag is derived when the snapshot does not carry it.
  assert.equal(derive({ vx: 0, vz: -3, facing: 0 }).backpedal, true);
  assert.equal(derive({ vx: 0, vz: 3, facing: 0 }).backpedal, false);
  // Facing downfield (facing 0) the player's right is sim +x.
  const shuffle = planAnimation({ vx: 2.2, vz: 0.2, facing: 0, action: 'run' }, { role: 'lb' }, { phase: 'live' }, 0, MINIMAL);
  assert.equal(shuffle.mode, 'shuffle-right');
  assert.ok(shuffle.procedural.strafe > 1);
  const clipShuffle = planAnimation({ vx: -2.2, vz: 0.2, facing: 0, action: 'run' }, { role: 'lb' }, { phase: 'live' }, 0, FULL);
  assert.equal(clipShuffle.locomotion[0].slot, 'shuffle-left');
});

test('every action has an overlay clip, a left/right twin or a procedural stand-in', () => {
  const live = { phase: 'live', carrier: 'X' };
  const overlays = {
    cut: ['cut-right', { lean: 0.6 }], juke: ['juke-left', { vx: -3, vz: 4 }], block: ['block', { engaged: 'DT1' }],
    throw: ['throw', { actionTime: 0.3 }], catch: ['catch', { actionTime: 0.4 }], carry: ['carry', {}], tackle: ['tackle', { actionTime: 0.9 }],
    wrapped: ['wrapped', {}], down: ['fall', {}], stumble: ['stumble', { actionTime: 0.5 }],
  };
  for (const [action, [slot, extra]] of Object.entries(overlays)) {
    const p = { id: action === 'carry' ? 'X' : 'Y', vx: 0, vz: 4, facing: 0, action, ...extra };
    const full = planAnimation(p, { role: 'wr', team: 'offense' }, live, 0.1, FULL);
    assert.equal(full.overlay?.slot, slot, action);
    const minimal = planAnimation(p, { role: 'wr', team: 'offense' }, live, 0.1, MINIMAL);
    assert.equal(minimal.overlay, null, action);
    assert.equal(minimal.procedural.action, action, action);
    assert.ok(minimal.locomotion.length > 0, action);
  }
  // Down stays down: the fall clip holds its last frame.
  assert.equal(planAnimation({ action: 'down' }, {}, { phase: 'dead' }, 3, FULL).overlay.hold, true);
  // A left cut picks the left clip.
  assert.equal(planAnimation({ vx: -3, vz: 4, action: 'cut', lean: -0.7 }, {}, live, 0.05, FULL).overlay.slot, 'cut-left');
});

test('upper-body overlays let the legs keep running at speed', () => {
  const carry = (speed, ctx) => planAnimation({ id: 'X', vx: 0, vz: speed, facing: 0, action: 'carry' }, RB, { phase: 'run', carrier: 'X' }, 0.5, ctx);
  assert.equal(carry(0, FULL).overlay.upper, 0);
  assert.equal(carry(6, FULL).overlay.upper, 1);
  assert.deepEqual(weightsOf(carry(6, FULL)), { run: 1 });
  const throwing = planAnimation({ id: 'QB', vx: 0, vz: 0, action: 'throw', actionTime: 0.17 }, { role: 'qb' }, { phase: 'live', carrier: 'QB' }, 0.23, FULL);
  assert.equal(throwing.overlay.slot, 'throw');
  near(throwing.overlay.elapsed, THROW_RELEASE, 1e-12, 'release point');
});

test('pre-snap stances depend on the role', () => {
  assert.equal(stanceFor({ role: 'ol' }), 'three');
  assert.equal(stanceFor({ role: 'dl' }), 'three');
  assert.equal(stanceFor({ role: 'qb' }), 'gun');
  assert.equal(stanceFor({ role: 'wr' }), 'split');
  assert.equal(stanceFor({ role: 'lb' }), 'two');
  assert.equal(stanceFor({ role: 'cb' }), 'two');
  const pre = { phase: 'presnap' };
  const plan = (role, ctx) => planAnimation({ id: 'X', action: 'run' }, { role }, pre, 0, ctx);
  assert.equal(plan('ol', FULL).overlay.slot, 'stance3');
  assert.equal(plan('lb', FULL).overlay.slot, 'stance2');
  assert.equal(plan('ol', { available: new Set(['idle', 'stance2']) }).overlay.slot, 'stance2');
  assert.equal(plan('qb', FULL).overlay, null);
  assert.equal(plan('qb', FULL).procedural.stance, 'gun');
  assert.equal(plan('ol', MINIMAL).procedural.stance, 'three');
  assert.equal(plan('wr', MINIMAL).procedural.stance, 'split');
});

test('the blend tree tolerates missing and unknown snapshot fields', () => {
  for (const p of [{}, { id: 'A' }, { vx: NaN, vz: undefined, facing: null, action: 'celebrate', speed: undefined, lean: 'x' }]) {
    const plan = planAnimation(p, {}, {}, 0, MINIMAL);
    assert.equal(plan.action, 'run');
    assert.ok(Number.isFinite(plan.speed) && Number.isFinite(plan.cycleRate) && Number.isFinite(plan.stretch));
    assert.deepEqual(weightsOf(plan), { idle: 1 });
  }
  assert.doesNotThrow(() => planAnimation({ action: 'run' }, {}, {}, 0, { available: new Set(), gaits: {} }));
  // The carrier carries; an engaged runner blocks.
  assert.equal(visualAction({ id: 'R', action: 'run' }, {}, { phase: 'run', carrier: 'R' }), 'carry');
  assert.equal(visualAction({ id: 'LT', action: 'run', engaged: 'DE1' }, {}, { phase: 'live' }), 'block');
  assert.equal(visualAction({ id: 'R', action: 'juke' }, {}, { phase: 'run', carrier: 'R' }), 'juke');
});

test('the action clock follows actionTime (replay-safe) and the throw keeps its follow-through', () => {
  const clock = new ActionClock();
  near(clock.update('throw', 0.4, 1 / 60), 0, 1e-12);
  near(clock.update('throw', 0.17, 1 / 60), THROW_RELEASE, 1e-12);
  near(clock.update('throw', 0.05, 1 / 60), 0.35, 1e-12);
  // Untimed actions (carry, down) run on real time.
  const carry = new ActionClock();
  carry.update('down', 0, 0.1); carry.update('down', 0, 0.1);
  near(carry.update('down', 0, 0.1), 0.2, 1e-12);
  // Joining a timed action midway (a replay scrub) starts from its timer.
  near(new ActionClock().update('catch', 0.15, 1 / 60), 0.3, 1e-12);
});

test('weights cross-fade over a fixed time and lean is estimated from the heading change', () => {
  const half = approachWeights({ walk: 1 }, { run: 1 }, 0.08, 0.16);
  near(half.walk, 0.5, 1e-12); near(half.run, 0.5, 1e-12);
  const done = approachWeights(half, { run: 1 }, 0.5, 0.16);
  assert.deepEqual(done, { run: 1 });
  assert.ok(estimateLean(0, 0.1, 8, 1 / 60) > 0);
  assert.ok(estimateLean(0, -0.1, 8, 1 / 60) < 0);
  assert.equal(estimateLean(null, 0.1, 8, 1 / 60), 0);
  assert.equal(estimateLean(3.1, -3.1, 8, 1 / 60) > 0, true, 'wraps around ±π');
});

// ---- uniforms -------------------------------------------------------------------

test('uniforms follow the practice palette: navy offense, white defense, red quarterback, silver pants', () => {
  assert.equal(uniformFor({ id: 'LT', role: 'ol', team: 'offense' }).jersey, COLORS.navy);
  assert.equal(uniformFor({ id: 'LT', role: 'ol', team: 'offense' }).number, COLORS.white);
  assert.equal(uniformFor({ id: 'CB1', role: 'cb', team: 'defense' }).jersey, COLORS.white);
  assert.equal(uniformFor({ id: 'CB1', role: 'cb', team: 'defense' }).number, COLORS.navy);
  assert.equal(uniformFor({ id: 'QB', role: 'qb', team: 'offense' }).jersey, '#c8322b');
  for (const spec of [{ id: 'QB', role: 'qb', team: 'offense' }, { id: 'FS', role: 's', team: 'defense' }]) {
    const u = uniformFor(spec);
    assert.equal(u.pants, '#c9ccd1');
    assert.equal(u.helmet, '#0f2742');
    assert.equal(u.socks, '#0f2742');
  }
  const ids = ['LT', 'LG', 'C', 'RG', 'RT', 'QB', 'R', 'X', 'Y', 'Z', 'B', 'DE1', 'DT1', 'DT2', 'DE2', 'LB1', 'LB2', 'LB3', 'CB1', 'CB2', 'FS', 'SS'];
  const tones = new Set(ids.map(id => uniformFor({ id }).skin));
  assert.ok(tones.size >= 5, `varied skin tones (${tones.size})`);
  assert.ok([...tones].every(t => SKIN_TONES.includes(t)));
  assert.equal(uniformFor({ id: 'LT' }).skin, uniformFor({ id: 'LT' }).skin, 'stable per player');
  assert.equal(uniformFor({ id: 'X', team: 'offense' }, { offense: { jersey: '#123456' } }).jersey, '#123456');
});

test('materials are recoloured by material or mesh name, with a vertex-region fallback', () => {
  const cases = {
    Jersey: 'jersey', Shirt: 'jersey', 'Wolf3D_Outfit_Top': 'jersey', Pants: 'pants', Shorts: 'pants', 'Wolf3D_Outfit_Bottom': 'pants',
    Helmet: 'helmet', 'Helmet_Shell': 'helmet', Facemask: 'facemask', Visor: 'visor', Skin: 'skin', 'Body_Skin': 'skin',
    Socks: 'socks', Shoes: 'shoes', Cleats: 'shoes', 'Wolf3D_Outfit_Footwear': 'shoes', Gloves: 'gloves', Number: 'number',
    'Wolf3D_Eye': 'keep', 'Hair': 'keep', 'laptop': null,
  };
  for (const [name, slot] of Object.entries(cases)) assert.equal(slotForMaterial(name), slot, name);
  assert.equal(slotForMaterial('Material.001', 'Shirt_Mesh'), 'jersey', 'mesh name when the material is unnamed');
  assert.equal(recolourMode([{ materialName: 'Jersey' }, { materialName: 'Skin' }]), 'materials');
  assert.equal(recolourMode([{ materialName: 'Beta_Surface_MAT', meshName: 'Beta_Surface' }]), 'regions', 'single material');
  assert.equal(recolourMode([{ materialName: 'Alpha_Body_MAT' }, { materialName: 'Alpha_Joints_MAT' }]), 'regions');
});

test('the region fallback paints helmet, jersey, pants, socks and shoes from skin weights', () => {
  const joints = {
    Hips: [0, 1.0, 0], Spine2: [0, 1.4, 0], Neck: [0, 1.65, 0], Head: [0, 1.8, 0],
    LeftArm: [0.25, 1.55, 0], LeftForeArm: [0.55, 1.55, 0], LeftHand: [0.8, 1.55, 0],
    LeftUpLeg: [0.1, 0.95, 0], LeftLeg: [0.1, 0.5, 0], LeftFoot: [0.1, 0.1, 0],
  };
  const bones = ['Head', 'Spine2', 'Hips', 'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'LeftArm', 'LeftHand'];
  const vertices = [[0, 0, 1.9, 0], [1, 1, 1.4, 0], [2, 2, 0.9, 0], [3, 3, 0.8, 0], [4, 4, 0.2, 0], [5, 5, 0.05, 0.05], [6, 6, 1.55, 0], [7, 7, 1.55, 0]];
  const skinIndex = [], skinWeight = [], position = [];
  for (const [, bone, y, z] of vertices) { skinIndex.push(bone, 0, 0, 0); skinWeight.push(1, 0, 0, 0); position.push(bone === 6 ? 0.3 : 0.1, y, z); }
  const regions = [...classifyRegions({ count: vertices.length, skinIndex, skinWeight, position, boneCanon: bones, joints })].map(r => REGIONS[r]);
  assert.deepEqual(regions, ['helmet', 'jersey', 'pants', 'pants', 'socks', 'shoes', 'jersey', 'gloves']);
});

// ---- mesh LOD ---------------------------------------------------------------------

test('vertex clustering merges nearby vertices and drops collapsed triangles', () => {
  // Two triangles sharing an edge, plus a sliver that collapses.
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0, 1.01, 1.01, 0]);
  const { rep, source } = clusterVertices(positions, 0.5);
  assert.equal(source.length, 4);
  assert.equal(rep[3], rep[4]);
  const tris = remapTriangles([0, 1, 2, 1, 3, 2, 3, 4, 2, 1, 4, 2], rep);
  assert.deepEqual(tris, [0, 1, 2, 1, 3, 2]);
  assert.deepEqual([...gather(new Float32Array([0, 1, 10, 11, 20, 21]), 2, Uint32Array.from([2, 0]))], [20, 21, 0, 1]);
});

// ---- which athletes layer the scene builds ------------------------------------------

test('the athletes layer is chosen from the URL and whether a model is published', () => {
  assert.deepEqual(athletesChoice('', true), { kind: 'skinned', modelUrl: CHARACTER_MODEL_URL, dev: false });
  assert.deepEqual(athletesChoice('', false), { kind: 'procedural' });
  assert.deepEqual(athletesChoice('?athletes=procedural', true), { kind: 'procedural' });
  assert.deepEqual(athletesChoice('?debug=1&athletes=skinned', false), { kind: 'skinned', modelUrl: CHARACTER_MODEL_URL, dev: false });
  assert.deepEqual(athletesChoice('?athletes=dev', false), { kind: 'skinned', modelUrl: DEV_CHARACTER_URL, dev: true });
  assert.deepEqual(athletesChoice('?athletes=nonsense', false), { kind: 'procedural' });
  assert.equal(athletesChoice('?athletes=auto', true).kind, 'skinned');
});

test('the model probe reads the committed index and HEADs the model it names', async () => {
  const requests = [];
  const site = files => async (url, init = {}) => {
    requests.push((init.method || 'GET') + ' ' + url);
    if (!(url in files)) return { ok: false, status: 404 };
    return { ok: true, status: 200, json: async () => files[url] };
  };
  const fetchIndex = site({ './models/index.json': { model: 'player.fbx', clips: ['clips/run.fbx', 'clips/throw.glb', 'clips/notes.txt'] } });
  const index = await readModelIndex(undefined, fetchIndex);
  assert.deepEqual(index, { modelUrl: './models/player.fbx', clipUrls: { run: './models/clips/run.fbx', throw: './models/clips/throw.glb' } });
  assert.equal(await modelPublished(index.modelUrl, site({ './models/player.fbx': {} })), true);
  assert.equal(await modelPublished(undefined, site({})), false);
  assert.ok(requests.includes('HEAD ./models/player.glb'), 'defaults to player.glb');
  assert.equal(await modelPublished(undefined, async () => { throw new Error('offline'); }), false);
  assert.equal(await readModelIndex(undefined, site({})), null);
  assert.equal(athletesChoice('', true, index.modelUrl).modelUrl, './models/player.fbx');
  assert.equal(athletesParam('?athletes=DEV'), 'dev');
  assert.equal(athletesParam('not a query %%'), 'auto');
});

import * as THREE from '../../vendor/three.module.js';
import { loft, mounds, angleBetween, shadeBy, helmetShell, helmetHardware, chinStrap, helmetVisor, glove, digits, HAND_DIGITS, cleat, cleatStuds, athleteFace, faceDetails, HELMET_UV } from './geometry.js';
import { solveTwoBone } from './ik.js';
import { eulerQuat, SPINE_SPLIT } from './pose.js';
import { hashString, SIDES, smoothstep, clamp, lerp } from './math.js';
import { jerseyFor, accessoriesFor, TEAM, SURFACE, REGIONS, GRAIN, GRAIN_TILE } from './uniform.js';
import { BoneTexture, SkinnedGeometryBuilder, jointWeights, chainWeights, skinnedMesh } from './skin.js';

// ---------------------------------------------------------------------------
// Skeleton. Sixty-five bones per athlete; every visible part is skinned to
// them, with the vertices around each joint shared between the bones that
// meet there. The first sixteen are the limbs and spine the pose solver
// places; the rest refine them: a neck, collarbones, the shoulder-pad caps
// and the twist-free direction of each upper arm, toes, the halves of the
// twist along the upper arm and the forearm, half-way helpers inside the
// elbows and knees, and three joints for each finger and thumb.

const FINGERS = i => ['thumb', 'index', 'middle', 'ring', 'pinky'].flatMap(d => [1, 2, 3].map(n => d + n + '_' + i));
export const BONES = [
  'pelvis', 'abdomen', 'chest', 'head',
  'thigh0', 'shin0', 'foot0', 'thigh1', 'shin1', 'foot1',
  'upper0', 'fore0', 'hand0', 'upper1', 'fore1', 'hand1',
  'neck', 'clav0', 'clav1', 'pad0', 'pad1', 'swing0', 'swing1', 'toe0', 'toe1',
  'upMid0', 'elbow0', 'foreMid0', 'foreTwist0', 'upMid1', 'elbow1', 'foreMid1', 'foreTwist1',
  'knee0', 'knee1',
  ...FINGERS(0), ...FINGERS(1),
];
const BONE_INDEX = Object.fromEntries(BONES.map((b, i) => [b, i]));
// Bone rows per athlete in the bone texture (with room to spare).
export const BONE_STRIDE = 72;

// ---------------------------------------------------------------------------
// The whole squad's meshes: one skinned body mesh (cloth, skin, rubber) and
// one skinned helmet mesh (clear-coated shells, facemasks, visors), sharing a
// bone texture, plus a reduced pair (level of detail 1) for distant athletes
// on the same bones. Parts flagged `detail` (belts, towels, tape, chin
// straps) are stored after every athlete's base parts; the lowest tier drops
// them and the reduced meshes never have them.
//
// Each athlete's triangles are a contiguous range of his mesh's index, so a
// mesh draws exactly the athletes at its level: one draw range per run of
// neighbouring athletes at the same level (geometry groups), usually a
// handful of draw calls instead of one, and no vertex work for the others.

// The level of an athlete who is not drawn at all (no mesh has it).
export const HIDDEN = 2;

export class Squad {
  constructor(scene, count, materials, { lod = true } = {}) {
    this.scene = scene;
    this.count = count;
    this.materials = materials;
    this.bones = new BoneTexture(count, BONE_STRIDE);
    this.builders = { body: new SkinnedGeometryBuilder(), helmet: new SkinnedGeometryBuilder() };
    if (lod) Object.assign(this.builders, { bodyLow: new SkinnedGeometryBuilder(), helmetLow: new SkinnedGeometryBuilder() });
    this.group = new THREE.Group();
    this.group.name = 'athletes';
    scene.add(this.group);
    this.meshes = {};
    this.detail = true;
    this.levels = new Uint8Array(count);   // per athlete: 0 full, 1 reduced
    this.groupsKey = null;
  }

  finish() {
    const t = this.bones.texture;
    const names = { body: 'athletes:bodies', helmet: 'athletes:helmets', bodyLow: 'athletes:bodies-lod1', helmetLow: 'athletes:helmets-lod1' };
    for (const [key, builder] of Object.entries(this.builders)) {
      const material = key.startsWith('body') ? this.materials.body : this.materials.helmet;
      const mesh = skinnedMesh(builder.build(), material, t, names[key], key.startsWith('body') ? this.materials.detail || null : null);
      // A material array makes the renderer (and the shadow pass) draw the
      // geometry groups, i.e. only the athletes at this mesh's level.
      mesh.material = [mesh.material];
      mesh.userData.level = key.endsWith('Low') ? 1 : 0;
      this.meshes[key] = mesh;
      this.group.add(mesh);
    }
    this.builders = null;
    this.updateGroups();
  }

  setDetail(visible) {
    this.detail = visible;
    this.updateGroups();
  }

  // Fabric shading (the weave detail layers and the cloth sheen) on or off;
  // the lowest graphics tier keeps the plain surface.
  setFabric(on) {
    const body = this.materials.body;
    if (!body || (body.userData.athDetail !== false) === on) return;
    body.userData.athDetail = on;
    if ('sheen' in body) body.sheen = on ? 1 : 0;
    body.needsUpdate = true;
  }

  // levels: per athlete 0 (full), 1 (reduced) or HIDDEN (not drawn: a
  // squad member who is not on the field this rep). Without the reduced
  // meshes 1 draws full detail.
  setLevels(levels) {
    let changed = false;
    for (let i = 0; i < this.count; i++) {
      const level = levels[i] === 1 && !this.meshes.bodyLow ? 0 : levels[i];
      if (this.levels[i] !== level) { this.levels[i] = level; changed = true; }
    }
    if (changed) this.updateGroups();
  }

  updateGroups() {
    const key = this.levels.join('') + (this.detail ? 'd' : '');
    if (key === this.groupsKey) return;
    this.groupsKey = key;
    for (const mesh of Object.values(this.meshes)) {
      const g = mesh.geometry, level = mesh.userData.level, ranges = g.userData.ranges;
      g.clearGroups();
      const runs = [];
      const push = ([start, count]) => {
        if (!count) return;
        const last = runs[runs.length - 1];
        if (last && last[0] + last[1] === start) last[1] += count;
        else runs.push([start, count]);
      };
      for (let i = 0; i < this.count; i++) if (ranges[i] && this.levels[i] === level) push(ranges[i].base);
      if (this.detail && level === 0) for (let i = 0; i < this.count; i++) if (ranges[i] && this.levels[i] === 0) push(ranges[i].detail);
      for (const [start, count] of runs) g.addGroup(start, count, 0);
    }
  }

  commit() {
    this.bones.commit();
  }
}

// ---------------------------------------------------------------------------
// Body types. Proportions follow a 6 ft 2 in athlete (H = 2.06 yd): head and
// helmet about 0.135 H, shoulder-to-hip 0.31 H, hip-to-ground 0.50 H,
// shoulder-to-wrist 0.36 H. Linemen are taller with a broader torso and more upper-leg mass.

export const BODY_TYPES = {
  ol: { height: 2.12, torso: 1.29, limb: 1.24, belly: 1.2 },
  dl: { height: 2.12, torso: 1.25, limb: 1.2, belly: 1.12 },
  te: { height: 2.1, torso: 1.1, limb: 1.07, belly: 1.04 },
  lb: { height: 2.07, torso: 1.1, limb: 1.07, belly: 1.03 },
  rb: { height: 2.0, torso: 1.07, limb: 1.13, belly: 1.0 },
  qb: { height: 2.08, torso: 1.0, limb: 1.0, belly: 1.0 },
  wr: { height: 2.05, torso: 0.96, limb: 0.95, belly: 0.95 },
  cb: { height: 2.01, torso: 0.95, limb: 0.95, belly: 0.94 },
  s: { height: 2.03, torso: 0.98, limb: 0.97, belly: 0.96 },
};

function dimensionsFor(spec) {
  const type = BODY_TYPES[spec.role] || BODY_TYPES.wr;
  const k = (type.height + (hashString(spec.id) - 0.5) * 0.05) / 2.06;
  return {
    ...type, k,
    hipY: 1.03 * k,            // hip joint height standing straight
    hipX: 0.112 * (1 + (type.torso - 1) * 0.7),
    thigh: 0.47 * k, shin: 0.47 * k, ankle: 0.09 * k,
    waist: 0.13 * k,           // pelvis -> abdomen joint
    mid: 0.25 * k,             // abdomen -> chest joint
    shoulder: [0.225 * type.torso ** 0.85, 0.255 * k, -0.012],
    neck: 0.39 * k,            // chest -> head joint
    upperArm: 0.37 * k, forearm: 0.34 * k,
  };
}

// ---------------------------------------------------------------------------
// Shared part geometry, built once (see geometry.js for the shapes). Each
// rig bakes scaled copies of these into the squad meshes.

// Baked occlusion for the cloth: armpits and the sides under the arms, the
// jersey tucked into the belt, the seat and crotch of the pants, skin under
// the sleeves and socks under the pant cuffs.
const side = t => Math.abs(Math.cos(t)) ** 6;
const AO = {
  // Under the arms, under the edge of the shoulder pads (front and back), and
  // down by the belt.
  chest: (v, t) => (1 - 0.34 * side(t) * smoothstep(0.15, 0.5, v) * (1 - smoothstep(0.58, 0.8, v)))
    * (1 - 0.3 * bumpAt(v, 0.335, 0.045) * Math.abs(Math.sin(t)))
    * (1 - 0.3 * smoothstep(0.93, 1, v)),
  abdomen: (v, t) => (0.66 + 0.34 * smoothstep(0.08, 0.5, v)) * (1 - 0.1 * side(t)),
  pelvis: (v, t) => (0.8 + 0.2 * smoothstep(0, 0.4, v)) * (1 - 0.22 * smoothstep(0.84, 1, v)) * (1 - 0.1 * bumpAt(Math.sin(t), -1, 0.25) * (1 - smoothstep(0.2, 0.5, v))),
  // v = 0 at the hip: the crotch side is shaded, as is the cloth just above
  // the knee pad and the tucked hem.
  leg: (v, t) => (1 - 0.26 * (1 - smoothstep(0.05, 0.3, v)) * smoothstep(0.2, 1, -Math.cos(t))) * (1 - 0.3 * smoothstep(0.95, 1, v)) * (1 - 0.2 * bumpAt(v, 0.74, 0.03) * smoothstep(-0.2, 0.6, Math.sin(t))) * (1 - 0.14 * bumpAt(v, 0.92, 0.025) * smoothstep(-0.2, 0.6, Math.sin(t))),
  upperArm: v => 1 - 0.36 * (1 - smoothstep(0.3, 0.62, v)),       // v = 0 at the shoulder, under the sleeve
  sleeve: (v, t) => (1 - 0.3 * smoothstep(0.3, 1, Math.cos(t)) * smoothstep(0.15, 0.6, v)) * (1 - 0.18 * bumpAt(v, 0.63, 0.05)),
  neck: v => 0.5 + 0.38 * v,
  sock: v => 1 - 0.4 * (1 - smoothstep(0.1, 0.22, v)),
  forearm: v => 0.9 + 0.1 * smoothstep(0, 0.6, v),
  collar: v => 0.8 + 0.2 * v,
};
// A soft 0..1 bump of half-width w centred on c.
function bumpAt(x, c, w) { const d = (x - c) / w; return Math.exp(-d * d); }

const FRONT = Math.PI / 2, BACK = -Math.PI / 2, OUT = 0, IN = Math.PI;

// `low`: the distant-athlete set (level of detail 1): about half the
// segments around and no in-between rings on the lofted parts, a coarser
// helmet shell, a simpler facemask and mitten hands. Detail-only parts are
// never drawn at that distance, so their low versions are not used.
//
// Limbs are authored for the left side, running down from the joint: the
// outside of a leg is +X and its front +Z; the inside of an arm is +X and its
// back +Z (the bind pose turns the arms half a turn, see Rig). The right-hand
// copies are mirrored when they are baked.
export function createGeometries({ low = false } = {}) {
  const L = (radial, subdiv) => (low ? { radial: Math.max(6, Math.round(radial / 2)), subdiv: 1 } : { radial, subdiv });
  return {
    // The seat of the pants, from the crotch up to the waistband, with the
    // glutes and a hip pad on each side under the cloth.
    pelvis: loft([
      { y: -0.078, w: 0.03, d: 0.04, z: -0.004 }, { y: -0.056, w: 0.092, d: 0.074, z: -0.006 }, { y: -0.02, w: 0.166, d: 0.104, z: -0.01 },
      { y: 0.02, w: 0.205, d: 0.122, z: -0.014 }, { y: 0.06, w: 0.211, d: 0.129, z: -0.013 },
      { y: 0.1, w: 0.2, d: 0.126, z: -0.006 }, { y: 0.15, w: 0.186, d: 0.124, z: -0.002 },
      { y: 0.166, w: 0.168, d: 0.112 },
    ], {
      ...L(20, 2), ao: AO.pelvis,
      sculpt: mounds([
        { y: 0.035, t: BACK - 0.55, sy: 0.06, st: 0.5, a: 0.017 }, { y: 0.035, t: BACK + 0.55, sy: 0.06, st: 0.5, a: 0.017 },
        { y: 0.02, t: BACK, sy: 0.07, st: 0.12, a: -0.008 },
        { y: 0.115, t: OUT + 0.25, sy: 0.03, st: 0.4, a: 0.006, flat: 0.6 }, { y: 0.115, t: IN - 0.25, sy: 0.03, st: 0.4, a: 0.006, flat: 0.6 },
      ]),
    }),
    // The jersey is tucked in: its hem stays well inside the pants, whose top
    // edge and belt sit clearly outside it, so the two never intersect.
    belt: loft([{ y: 0.124, w: 0.1935, d: 0.13 }, { y: 0.158, w: 0.188, d: 0.128 }], { ...L(20, 1), capTop: false, capBottom: false }),
    // The jersey below the pads: pulled into the belt, blousing a little over
    // it, with soft folds where it bunches at the waist.
    abdomen: loft([
      { y: -0.04, w: 0.156, d: 0.104 }, { y: 0.028, w: 0.169, d: 0.116 }, { y: 0.068, w: 0.183, d: 0.128 },
      { y: 0.15, w: 0.188, d: 0.134 }, { y: 0.27, w: 0.199, d: 0.142 },
    ], {
      ...L(20, 2), capTop: false, capBottom: false, ao: AO.abdomen,
      sculpt: (y, t) => (0.0045 * Math.sin(t * 5 + y * 30 + 1.3) + 0.003 * Math.sin(t * 3 - y * 55)) * smoothstep(0.0, 0.05, y) * (1 - smoothstep(0.09, 0.2, y)),
    }),
    // The jersey over the shoulder pads: a wide, squared yoke whose edge shows
    // through the cloth front and back, split down the sternum and the spine.
    chest: loft([
      { y: -0.06, w: 0.188, d: 0.131, n: 2.1 }, { y: 0.03, w: 0.21, d: 0.15, n: 2.1 },
      { y: 0.11, w: 0.232, d: 0.158, n: 2.2 }, { y: 0.17, w: 0.248, d: 0.164, n: 2.3 },
      { y: 0.23, w: 0.264, d: 0.154, n: 2.2 }, { y: 0.275, w: 0.264, d: 0.143, n: 2.15 },
      { y: 0.305, w: 0.247, d: 0.131, n: 2.1 }, { y: 0.328, w: 0.214, d: 0.118, n: 2.1 },
      { y: 0.348, w: 0.166, d: 0.104, n: 2.1 }, { y: 0.362, w: 0.124, d: 0.092 }, { y: 0.374, w: 0.1, d: 0.084 },
    ], {
      ...L(24, 2), capBottom: false, flipU: true, ao: AO.chest,
      sculpt: (y, t) => {
        const face = Math.abs(Math.sin(t)), plate = smoothstep(0.085, 0.12, y) * (1 - smoothstep(0.2, 0.3, y));
        // The back plate shows less than the chest plate: it would stand off
        // the spine as a ledge when he bends over.
        return (Math.sin(t) > 0 ? 0.019 : 0.011) * plate * face ** 1.5
          - 0.007 * plate * (bumpAt(angleBetween(t, FRONT), 0, 0.14) + bumpAt(angleBetween(t, BACK), 0, 0.14)) * smoothstep(0.1, 0.16, y)
          + 0.004 * Math.sin(t * 4 + y * 26) * (1 - smoothstep(0.02, 0.1, y));
      },
    }),
    collar: loft([{ y: 0.35, w: 0.103, d: 0.091 }, { y: 0.37, w: 0.097, d: 0.086 }, { y: 0.384, w: 0.092, d: 0.081 }], { ...L(16, 1), capTop: false, capBottom: false, ao: AO.collar }),
    // Neck and the slope of the trapezius under the collar.
    neck: loft([
      { y: 0.3, w: 0.11, d: 0.082 }, { y: 0.35, w: 0.088, d: 0.076, z: -0.004 }, { y: 0.39, w: 0.077, d: 0.072, z: -0.004 }, { y: 0.47, w: 0.067, d: 0.067 },
    ], { ...L(10, 1), capBottom: false, ao: AO.neck }),
    // One pant leg from inside the pelvis, over the thigh and knee pads, to
    // the cuff below the knee; it is skinned across the knee so it bends as
    // one piece. Quadriceps to the front and outside, hamstrings behind.
    leg: loft([
      { y: 0.075, w: 0.07, d: 0.084 }, { y: 0.02, w: 0.096, d: 0.108, x: -0.004 }, { y: -0.04, w: 0.106, d: 0.118, x: -0.004, z: 0.002 },
      { y: -0.105, w: 0.108, d: 0.121, x: -0.002, z: 0.003 }, { y: -0.2, w: 0.103, d: 0.115, z: 0.006 },
      { y: -0.3, w: 0.089, d: 0.095, z: 0.005 }, { y: -0.39, w: 0.075, d: 0.08, z: 0.002 },
      { y: -0.45, w: 0.066, d: 0.073, z: 0.008 }, { y: -0.5, w: 0.064, d: 0.072, z: 0.011 },
      { y: -0.545, w: 0.058, d: 0.062, z: 0.004 }, { y: -0.566, w: 0.056, d: 0.058 },
      { y: -0.574, w: 0.046, d: 0.047 },
    ], {
      ...L(20, 2), ao: AO.leg,
      sculpt: mounds([
        { y: -0.2, t: FRONT - 0.15, sy: 0.085, st: 0.5, a: 0.011, flat: 0.7 },   // thigh pad
        { y: -0.27, t: OUT + 0.35, sy: 0.1, st: 0.45, a: 0.006 },               // outer quad
        { y: -0.37, t: IN - 0.5, sy: 0.04, st: 0.4, a: 0.006 },                 // teardrop above the knee
        { y: -0.2, t: BACK, sy: 0.11, st: 0.6, a: 0.008 },                      // hamstrings
        { y: -0.475, t: FRONT, sy: 0.036, st: 0.55, a: 0.012, flat: 0.5 },      // knee pad
        { y: -0.47, t: BACK, sy: 0.03, st: 0.5, a: -0.006 },                    // back of the knee
        { y: -0.562, t: 0, sy: 0.008, st: 0, a: 0.003 },                        // cuff band
      ]),
    }),
    // The lower leg in its sock: calf high at the back, shin to the front, a
    // slim ankle.
    sock: loft([
      { y: -0.05, w: 0.05, d: 0.052 }, { y: -0.1, w: 0.054, d: 0.058, z: -0.004 }, { y: -0.17, w: 0.06, d: 0.068, z: -0.012 },
      { y: -0.25, w: 0.054, d: 0.06, z: -0.01 }, { y: -0.33, w: 0.043, d: 0.047, z: -0.004 }, { y: -0.4, w: 0.036, d: 0.04 },
      { y: -0.45, w: 0.034, d: 0.04 }, { y: -0.5, w: 0.034, d: 0.041 },
    ], {
      ...L(14, 2), capTop: false, capBottom: false, ao: AO.sock,
      sculpt: mounds([
        { y: -0.16, t: BACK - 0.6, sy: 0.06, st: 0.5, a: 0.006 }, { y: -0.18, t: BACK + 0.5, sy: 0.05, st: 0.45, a: 0.004 },
        { y: -0.3, t: FRONT, sy: 0.12, st: 0.3, a: 0.003 },
      ]),
    }),
    // Upper arm: biceps to the front (-Z), triceps behind.
    upperArm: loft([
      { y: 0.05, w: 0.064, d: 0.066 }, { y: -0.02, w: 0.077, d: 0.082 }, { y: -0.12, w: 0.075, d: 0.085, z: -0.003 },
      { y: -0.21, w: 0.07, d: 0.08, z: -0.004 }, { y: -0.3, w: 0.059, d: 0.064, z: -0.001 }, { y: -0.36, w: 0.052, d: 0.055 }, { y: -0.4, w: 0.045, d: 0.047 },
    ], {
      ...L(14, 2), capTop: false, capBottom: false, ao: AO.upperArm,
      sculpt: mounds([
        { y: -0.2, t: BACK, sy: 0.06, st: 0.6, a: 0.007 },       // -Z is the front of the arm: the biceps
        { y: -0.15, t: FRONT - 0.2, sy: 0.07, st: 0.5, a: 0.006 }, // triceps
        { y: -0.37, t: FRONT, sy: 0.025, st: 0.4, a: 0.004 },     // elbow
      ]),
    }),
    // The shoulder-pad cap under the jersey, and the tight sleeve that ends
    // on the biceps. The cap sits out over the deltoid, away from the neck.
    sleeve: loft([
      { y: 0.066, w: 0.03, d: 0.05, x: -0.004, z: -0.004 }, { y: 0.052, w: 0.07, d: 0.088, x: -0.006, z: -0.006, n: 2.1 },
      { y: 0.016, w: 0.097, d: 0.113, x: -0.007, z: -0.008, n: 2.2 }, { y: -0.035, w: 0.103, d: 0.116, x: -0.005, z: -0.008, n: 2.25 },
      { y: -0.08, w: 0.097, d: 0.106, x: -0.003, z: -0.005, n: 2.2 }, { y: -0.103, w: 0.089, d: 0.095 },
      { y: -0.15, w: 0.085, d: 0.092, z: -0.002 }, { y: -0.196, w: 0.081, d: 0.087, z: -0.003 }, { y: -0.203, w: 0.072, d: 0.077, z: -0.003 },
    ], { ...L(18, 2), capBottom: false, ao: AO.sleeve }),
    // Forearm: full below the elbow, tapering to a narrow wrist.
    forearm: loft([
      { y: 0.035, w: 0.047, d: 0.049 }, { y: -0.012, w: 0.055, d: 0.056, z: -0.002 },
      { y: -0.07, w: 0.065, d: 0.065, z: -0.005 }, { y: -0.13, w: 0.06, d: 0.058, z: -0.004 },
      { y: -0.2, w: 0.049, d: 0.046 }, { y: -0.27, w: 0.035, d: 0.032, z: 0.002 },
      { y: -0.33, w: 0.03, d: 0.027, z: 0.002 }, { y: -0.36, w: 0.03, d: 0.026 },
    ], {
      ...L(14, 2), capTop: false, capBottom: false, ao: AO.forearm,
      sculpt: mounds([{ y: -0.08, t: OUT + 2.6, sy: 0.06, st: 0.6, a: 0.005 }, { y: -0.1, t: BACK, sy: 0.07, st: 0.5, a: 0.003 }]),
    }),
    // A sweatband around the biceps, below the sleeve.
    band: loft([{ y: -0.232, w: 0.074, d: 0.087, z: -0.004 }, { y: -0.247, w: 0.0735, d: 0.086, z: -0.004 }, { y: -0.262, w: 0.07, d: 0.081, z: -0.003 }], { ...L(14, 1), capTop: false, capBottom: false }),
    // The back plate hanging from the shoulder pads over the small of the
    // back: a padded shell, curved to the body and narrower at the bottom.
    backPlate: (() => {
      const g = new THREE.BoxGeometry(0.2, 0.15, 0.014, 6, 4, 1), p = g.attributes.position;
      for (let i = 0; i < p.count; i++) {
        const x = p.getX(i), y = p.getY(i), taper = 1 - 0.28 * smoothstep(0.02, -0.075, y);
        const round = Math.abs(y) > 0.07 ? 0.9 : 1;
        p.setX(i, x * taper * round);
        p.setZ(i, p.getZ(i) + 2.6 * (x * taper) ** 2 - (p.getZ(i) < 0 ? 0.004 * Math.cos(x * 15) * Math.cos(y * 20) : 0));
      }
      g.computeVertexNormals();
      // Darker grooves between its four pads.
      return shadeBy(g, (x, y) => (Math.abs(x) < 0.006 || Math.abs(y + 0.005) < 0.004 ? 0.6 : 1));
    })(),
    tape: loft([{ y: -0.25, w: 0.042, d: 0.038 }, { y: -0.29, w: 0.038, d: 0.0345 }, { y: -0.34, w: 0.0345, d: 0.031 }], { ...L(14, 1), capTop: false, capBottom: false }),
    glove: glove({ low }),
    // Thumb and fingers (digit0..digit4); the reduced hand is a mitten.
    ...(low ? {} : Object.fromEntries(digits().map((g, n) => ['digit' + n, g]))),
    cleat: cleat({ low }),
    studs: cleatStuds(),
    helmet: helmetShell({ low }),
    hardware: helmetHardware({ low }),
    hardwareCage: helmetHardware({ low, cage: true }),
    strap: chinStrap(),
    visor: helmetVisor({ low }),
    face: athleteFace({ low }),
    faceDetails: faceDetails(),
    // A hand towel, curved around the front of the thigh.
    towel: (() => {
      const g = new THREE.BoxGeometry(0.085, 0.2, 0.006, 3, 6, 1);
      g.translate(0, -0.1, 0);
      const p = g.attributes.position;
      for (let i = 0; i < p.count; i++) p.setZ(i, p.getZ(i) - 2.2 * p.getX(i) ** 2 + 0.04 * Math.max(0, -p.getY(i) - 0.05) + 0.004 * Math.sin(p.getX(i) * 150) * -p.getY(i) * 5);
      g.computeVertexNormals();
      return g;
    })(),
  };
}

// ---------------------------------------------------------------------------
// One athlete: joint hierarchy, the parts baked into the squad meshes, and
// the pose solver.

const HELMET_CENTRE = 0.115;
// The neck joint sits at the seventh vertebra, this far up from the chest
// joint to the base of the skull; it takes this share of a turn of the head.
const NECK_BASE = 0.78, NECK_SPLIT = 0.45, NECK_LIMIT = 1.15;
// The joints of the rig being built whose bone stands above them.
const SPINE = new Set();
const UP = [0, 1, 0], DOWN = [0, -1, 0], FORWARD = [0, 0, 1];
// How far each finger fans out for a full spread (radians about the palm
// normal; the thumb side is positive).
const FAN = [0.5, 0.26, 0.07, -0.1, -0.28];

const _q = new THREE.Quaternion(), _qi = new THREE.Quaternion(), _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion(), _qc = new THREE.Quaternion();
const _t = new THREE.Vector3(), _pole = new THREE.Vector3(), _origin = new THREE.Vector3(), _u = new THREE.Vector3();
const _vx = new THREE.Vector3(), _vy = new THREE.Vector3(), _vz = new THREE.Vector3();
const _e = new THREE.Euler(), X_AXIS = new THREE.Vector3(1, 0, 0), Y_AXIS = new THREE.Vector3(0, 1, 0), Z_AXIS = new THREE.Vector3(0, 0, 1);
const HANG = new THREE.Vector3(0, -1, 0), IDENTITY = new THREE.Quaternion();
const HALF_TURN = new THREE.Quaternion().setFromAxisAngle(Y_AXIS, Math.PI);
const _m = new THREE.Matrix4(), _local = new THREE.Matrix4(), _c = new THREE.Color();
const _ik = { stretch: 0, short: 0 };

// The turn of a quaternion about the Y axis (its twist), in -PI..PI.
function twistY(q) {
  return 2 * Math.atan2(q.w < 0 ? -q.y : q.y, Math.abs(q.w));
}

// Limits a hand's rotation on the forearm to what a wrist and forearm do:
// the turn about the forearm's length (pronation) and the bend away from it.
function limitWrist(q) {
  const twist = clamp(twistY(q), -1.6, 1.6);
  _qc.setFromAxisAngle(Y_AXIS, twistY(q)).invert().premultiply(q);       // the bend, twist removed
  const bend = 2 * Math.acos(Math.min(1, Math.abs(_qc.w)));
  if (bend > 1.15) _qc.slerp(IDENTITY, 1 - 1.15 / bend);
  return q.copy(_qc).multiply(_qb.setFromAxisAngle(Y_AXIS, twist));
}

export class Rig {
  // lowGeometry: createGeometries({ low: true }), baked into the squad's
  // reduced meshes when it has them.
  constructor(squad, spec, index, geometry, atlas, lowGeometry = null) {
    this.id = spec.id;
    this.spec = spec;
    this.squad = squad;
    this.index = index;
    this.level = '';   // '' while baking the full meshes, 'Low' for the reduced ones
    this.boneBase = index * BONE_STRIDE;
    const d = this.dims = dimensionsFor(spec);
    const look = this.look = accessoriesFor(spec, index);
    const { jersey } = jerseyFor(spec);
    this.headSize = 1.1 * (1 + (d.torso - 1) * 0.2);
    this.gloveScale = [1.13 * d.limb ** 0.5, 1.13 * d.k, 1.13 * d.limb ** 0.5];

    const bone = this.bone = {};
    const joint = (name, parent, x = 0, y = 0, z = 0) => {
      const o = new THREE.Object3D();
      o.position.set(x, y, z);
      if (parent) parent.add(o);
      if (name) bone[name] = o;
      return o;
    };
    this.root = joint(null, null);
    this.tilt = joint(null, this.root);
    this.pelvis = joint('pelvis', this.tilt, 0, d.hipY, 0);
    this.abdomen = joint('abdomen', this.pelvis, 0, d.waist, 0);
    this.chest = joint('chest', this.abdomen, 0, d.mid, 0);
    this.neck = joint('neck', this.chest, 0, NECK_BASE * d.neck, 0);
    this.head = joint('head', this.neck, 0, (1 - NECK_BASE) * d.neck, 0.012);
    this.thighs = []; this.shins = []; this.feet = []; this.kneeBones = []; this.toes = [];
    this.clavs = []; this.pads = []; this.swings = []; this.uppers = []; this.upMids = []; this.elbowBones = [];
    this.forearms = []; this.foreMids = []; this.foreTwists = []; this.hands = []; this.digits = [];
    const [sx, sy, sz] = d.shoulder, gs = this.gloveScale;
    SIDES.forEach((s, i) => {
      const thigh = joint('thigh' + i, this.pelvis, s * d.hipX, 0, 0);
      const shin = joint('shin' + i, thigh, 0, -d.thigh, 0);
      const foot = joint('foot' + i, shin, 0, -d.shin, 0);
      this.thighs.push(thigh); this.shins.push(shin); this.feet.push(foot);
      // The knee's helper turns half as far as the shin; the toes hinge at
      // the ball of the foot.
      this.kneeBones.push(joint('knee' + i, thigh, 0, -d.thigh, 0));
      this.toes.push(joint('toe' + i, foot, 0, -0.69 * d.ankle, 1.5 * d.ankle));

      // The collarbone pivots at the breastbone and carries the shoulder
      // joint; the arm itself stays a child of the chest (hand targets and
      // elbow poles are chest-frame), its shoulder moved to where the
      // collarbone puts it. `pad` is the shoulder-pad cap and `swing` the
      // arm's direction without its twist: the cloth over the shoulder rides
      // those two instead of spinning with the upper arm.
      this.clavs.push(joint('clav' + i, this.chest, s * 0.15 * sx, 1.05 * sy, 0.03));
      const upper = joint('upper' + i, this.chest, s * sx, sy, sz);
      this.pads.push(joint('pad' + i, this.chest, s * sx, sy, sz));
      this.swings.push(joint('swing' + i, this.chest, s * sx, sy, sz));
      this.upMids.push(joint('upMid' + i, upper));
      this.elbowBones.push(joint('elbow' + i, upper, 0, -d.upperArm, 0));
      const fore = joint('fore' + i, upper, 0, -d.upperArm, 0);
      this.foreMids.push(joint('foreMid' + i, fore));
      this.foreTwists.push(joint('foreTwist' + i, fore));
      const hand = joint('hand' + i, fore, 0, -d.forearm, 0);
      this.uppers.push(upper); this.forearms.push(fore); this.hands.push(hand);
      // Three joints per digit, hanging along the digit's own -Y.
      this.digits.push(HAND_DIGITS.map(({ name, base, lean, length, joints: [j1, j2] }) => {
        const L = length * gs[1], rest = new THREE.Quaternion();
        if (lean) rest.setFromAxisAngle(Z_AXIS, s * lean[1]).multiply(_q.setFromAxisAngle(X_AXIS, lean[0]));
        const a = joint(name + '1_' + i, hand, s * base[0] * gs[0], base[1] * gs[1], base[2] * gs[2]);
        a.quaternion.copy(rest);
        const b = joint(name + '2_' + i, a, 0, -j1 * L, 0), c = joint(name + '3_' + i, b, 0, -(j2 - j1) * L, 0);
        return { rest, joints: [a, b, c], length: L };
      }));
    });
    SPINE.clear(); SPINE.add(this.abdomen).add(this.chest).add(this.neck).add(this.head);
    this.joints = BONES.map(name => bone[name]);

    // Rest pose = bind pose: standing straight, arms hanging, hands flat, at
    // the origin. The arm solver points each upper arm's local +Z at the
    // elbow, which hangs behind him, so the bind arms are turned the same way
    // (half a turn about their length); otherwise the shoulder blend would
    // average two orientations 180 degrees apart and pinch the sleeves. Rigid
    // parts look the same whatever the bind pose.
    for (const list of [this.uppers, this.pads, this.swings]) for (const o of list) o.quaternion.copy(HALF_TURN);
    this.root.updateMatrixWorld(true);
    this.bindInverse = this.joints.map(j => j.matrixWorld.clone().invert());
    this.buildParts(geometry, atlas, jersey, look);
    if (lowGeometry && squad.builders.bodyLow) {
      this.level = 'Low';
      this.buildParts(lowGeometry, atlas, jersey, look);
      this.level = '';
    }

    // Resolved points in world space, refreshed after every apply(). palms
    // are the middle of each palm, palmNormals the way it faces, fingerDirs
    // the way straight fingers run; headTop is the crown of the helmet;
    // reachShort is how far each hand and foot stayed from a target the limb
    // could not reach.
    const pair = () => [new THREE.Vector3(), new THREE.Vector3()];
    this.world = {
      pelvis: new THREE.Vector3(), chest: new THREE.Vector3(), neck: new THREE.Vector3(), head: new THREE.Vector3(), headTop: new THREE.Vector3(),
      hands: pair(), elbows: pair(), shoulders: pair(), palms: pair(), palmNormals: pair(), fingerDirs: pair(),
      feet: pair(), knees: pair(), toes: pair(),
      reachShort: { hands: [0, 0], feet: [0, 0] },
    };
    this.chestQuat = new THREE.Quaternion();
  }

  // Bakes one part into a squad mesh. `bone` is the bone it rides on.
  // `blend` lists the joints it bends across: [otherBone, radius, crease] or
  // { bone, radius, crease, helper, pivot, ownIsChild, dir } (see
  // jointWeights; pivot, ownIsChild and dir default from the hierarchy).
  // `chain` = { from, to, bones: [[bone, t], ...] } spreads the part's own
  // share along the line between two joints (twist that builds up down an
  // arm). `weights(p, field, i)` overrides: field(p) is what blend and chain
  // give. `warp(v)` reshapes the part's own vertices before they are placed.
  part(target, bone, geometry, { pos = [0, 0, 0], rot = [0, 0, 0], scale = [1, 1, 1], color = '#ffffff', surface = SURFACE.cloth, grain = undefined, uv = null, blend = [], chain = null, weights = null, warp = null, detail = false } = {}) {
    // Small details are not drawn on distant athletes.
    if (detail && this.level) return;
    const own = this.bone[bone], index = name => this.boneBase + BONE_INDEX[name];
    _local.compose(_t.set(...pos), _q.setFromEuler(_e.set(...rot)), _origin.set(...scale));
    const bind = new THREE.Matrix4().multiplyMatrices(own.matrixWorld, _local);
    const joints = blend.map(entry => {
      const b = Array.isArray(entry) ? { bone: entry[0], radius: entry[1], crease: entry[2] } : entry;
      const other = this.bone[b.bone];
      // The joint is the origin of whichever bone is the child of the pair.
      // Down a limb the child hangs below its joint; up the spine (abdomen,
      // chest, neck, head) it stands above it.
      const ownIsChild = b.ownIsChild ?? own.parent === other;
      const pivot = b.pivot ? this.bone[b.pivot] : ownIsChild ? own : other, upper = ownIsChild ? other : own;
      const dir = b.dir || (SPINE.has(pivot) ? UP : DOWN);
      _t.setFromMatrixPosition(pivot.matrixWorld);
      const j = { x: _t.x, y: _t.y, z: _t.z, dx: dir[0], dy: dir[1], dz: dir[2], radius: b.radius, ownIsChild, other: index(b.bone) };
      if (b.helper) j.helper = index(b.helper);
      // The fold side of a hinge, given in the upper bone's frame.
      if (b.crease) {
        const fold = _origin.set(0, 0, b.crease.side).transformDirection(upper.matrixWorld);
        j.crease = { x: fold.x, z: fold.z, radius: b.crease.radius };
      }
      return j;
    });
    let field = jointWeights(index(bone), joints);
    if (chain) {
      const a = new THREE.Vector3().setFromMatrixPosition(this.bone[chain.from].matrixWorld), b = new THREE.Vector3().setFromMatrixPosition(this.bone[chain.to].matrixWorld);
      const spread = chainWeights(a, b, chain.bones.map(([name, t]) => [index(name), t])), jointed = field;
      field = p => { const list = jointed(p); return spread(p, list.pop()[1], list); };
    }
    this.squad.builders[target + this.level].add(geometry, {
      bind, weights: weights ? (p, i) => weights(p, field, i) : field, warp,
      color: _c.set(color), uv, surface, grain, detail, owner: this.index,
    });
  }

  buildParts(geometry, atlas, jersey, look) {
    const d = this.dims, torso = d.torso, depth = (1 + torso) / 2, limb = d.limb, k = d.k;
    const body = (...args) => this.part('body', ...args);
    const helmet = (...args) => this.part('helmet', ...args);
    const index = name => this.boneBase + BONE_INDEX[name];
    const white = atlas.white, plain = () => white;
    // (u, v) of a part -> a region of this player's atlas cell, or of the
    // cell everybody shares (pants and socks).
    const region = (name, { shared = false, flipU = false, flipV = false } = {}) => {
      const [rx, ry, rw, rh] = REGIONS[name], o = shared ? atlas.shared || atlas.offset : atlas.offset, s = atlas.scale;
      return (u, v) => [o[0] + (rx + (flipU ? 1 - u : u) * rw) * s[0], o[1] + (ry + (flipV ? 1 - v : v) * rh) * s[1]];
    };
    // Detail tiles for a tube of this girth and length (yards).
    const grain = (layer, around, length, strength = 1) => [layer, Math.max(1, Math.round(around / GRAIN_TILE[layer])), length / GRAIN_TILE[layer], strength];
    const trim = jerseyFor(this.spec).trim;
    // Takes `share` of every entry of a weight list for another bone.
    const give = (list, bone, share) => {
      if (share <= 0) return list;
      for (const entry of list) entry[1] *= 1 - share;
      list.push([index(bone), share]);
      return list;
    };

    // Torso: pants and belt on the pelvis, the jersey over abdomen and chest.
    // Around each hip the pants pass from the pelvis to the thigh. The seat
    // and the pant leg are two shells there, so both take their weights from
    // this one field of the point in space, and what lies together moves
    // together. The share passes to the thigh over a deep band behind (the
    // glute rides with the leg) and a shallow one in front, where the hip
    // folds; close to the midline the crotch stays with the pelvis.
    const hips = [torso * 0.96, k, depth * d.belly ** 0.3];
    const hipY = _t.setFromMatrixPosition(this.thighs[0].matrixWorld).y;
    const thighShare = (p, s) => {
      const below = hipY - p.y, out = s * p.x - d.hipX;
      const front = smoothstep(-0.2, 0.9, p.z / (Math.hypot(out, p.z) || 1));
      const share = smoothstep(-lerp(0.1, 0.03, front) * k, lerp(0.08, 0.035, front) * k, below);
      return share * lerp(smoothstep(0.012, 0.07, s * p.x), 1, smoothstep(0.08 * k, 0.16 * k, below));
    };
    const seat = (p, waist) => { const s = p.x > 0 ? 1 : -1; return give(waist(p), s > 0 ? 'thigh0' : 'thigh1', thighShare(p, s)); };
    const belly = [torso * d.belly ** 0.2, k, depth * d.belly ** 0.5];
    body('pelvis', geometry.pelvis, { scale: hips, surface: SURFACE.pants, grain: grain(GRAIN.knit, 1.0 * torso, 0.23), uv: region('hips', { shared: true }), blend: [['abdomen', 0.06]], weights: seat });
    body('pelvis', geometry.belt, { scale: hips, color: TEAM.belt, surface: SURFACE.belt, grain: grain(GRAIN.leather, 1, 0.04, 0.6), uv: plain, blend: [['abdomen', 0.06]], detail: true });
    // The lower jersey takes the bottom row of the torso panel (its side
    // panels and the folds at the belt) all the way down.
    const hem = region('torso', { flipU: true });
    body('abdomen', geometry.abdomen, { scale: belly, surface: SURFACE.cloth, grain: grain(GRAIN.mesh, 1.05 * torso, 0.31, 0.55), uv: u => hem(u, 0.03), blend: [['pelvis', 0.06], ['chest', 0.1]] });
    // The top of the yoke, out toward each shoulder, lifts with the collarbone.
    const chestY = _t.setFromMatrixPosition(this.chest.matrixWorld).y, span = d.shoulder[0];
    const yoke = (p, waist) => give(waist(p), p.x > 0 ? 'clav0' : 'clav1', 0.85 * smoothstep(0.4 * span, 0.9 * span, Math.abs(p.x)) * smoothstep(0.15 * k, 0.25 * k, p.y - chestY));
    body('chest', geometry.chest, { scale: [torso, k, depth], surface: SURFACE.cloth, grain: grain(GRAIN.mesh, 1.36 * torso, 0.432, 0.55), uv: region('torso'), blend: [['abdomen', 0.1]], weights: yoke });
    body('chest', geometry.collar, { scale: [torso ** 0.6, k, depth ** 0.6], color: trim, surface: SURFACE.collar, grain: grain(GRAIN.rib, 0.66, 0.04, 0.8), uv: plain, detail: true });
    // The neck is modelled from the chest joint up; it rides the neck bone.
    body('neck', geometry.neck, { pos: [0, -NECK_BASE * d.neck, 0], scale: [torso ** 0.6, k, depth ** 0.6], color: look.skin, surface: SURFACE.skin, grain: grain(GRAIN.skin, 0.48, 0.17, 0.3), uv: plain, blend: [['chest', 0.04], ['head', 0.05]] });
    if (look.backPlate) body('abdomen', geometry.backPlate, { pos: [0, 0.07 * k, -(0.136 * depth * d.belly ** 0.5 + 0.012)], rot: [0.1, 0, 0], scale: [torso ** 0.6, k, 1], color: jerseyFor(this.spec).light ? TEAM.navy : '#e8e8e4', surface: SURFACE.plate, grain: [GRAIN.leather, 8, 6, 0.3], uv: plain, blend: [['chest', 0.1]], detail: true });
    // The towel tucked into the front of the pants hangs over the right thigh
    // and swings with it.
    if (look.towel) body('pelvis', geometry.towel, { pos: [-0.1 * torso, 0.125 * k, 0.128 * depth * d.belly ** 0.3], rot: [-0.1, 0.25, 0.04], color: '#ecebe6', surface: SURFACE.towel, grain: [GRAIN.weave, 3, 7, 1], uv: plain, blend: [['thigh1', 0.1]], detail: true });

    // Head: face under the helmet; shell, facemask, strap and visor.
    const shell = [0, HELMET_CENTRE, 0], headSize = this.headSize, helmetScale = [headSize, headSize, headSize];
    const whiteTexel = () => HELMET_UV.white;
    body('head', geometry.face, { pos: [0, HELMET_CENTRE - 0.052, 0.022], scale: helmetScale, color: look.skin, surface: SURFACE.skin, grain: grain(GRAIN.skin, 0.5, 0.22, 0.3), uv: plain });
    body('head', geometry.faceDetails, { pos: [0, HELMET_CENTRE - 0.052, 0.022], scale: helmetScale, surface: SURFACE.skin, uv: plain, detail: true });
    helmet('head', geometry.helmet, { pos: shell, scale: helmetScale, surface: SURFACE.shell });
    helmet('head', look.cage ? geometry.hardwareCage : geometry.hardware, { pos: shell, scale: helmetScale, surface: SURFACE.facemask, uv: whiteTexel });
    helmet('head', geometry.strap, { pos: shell, scale: helmetScale, color: '#e9e9e4', surface: SURFACE.strap, uv: whiteTexel, detail: true });
    if (look.visor) helmet('head', geometry.visor, { pos: shell, scale: helmetScale, color: '#0b0f15', surface: SURFACE.visor, uv: whiteTexel });

    const armColor = look.armSleeve || look.skin, armSurface = look.armSleeve ? SURFACE.sleeve : SURFACE.skin, armGrain = look.armSleeve ? GRAIN.rib : GRAIN.skin;
    const gs = this.gloveScale;
    SIDES.forEach((s, i) => {
      const thigh = 'thigh' + i, shin = 'shin' + i, foot = 'foot' + i, upper = 'upper' + i, fore = 'fore' + i, hand = 'hand' + i;
      // Right-hand limbs are mirror images of the left.
      const legScale = [s * limb, k, limb], armScale = [s * limb, k, limb], capScale = [s * limb ** 0.7, k, limb ** 0.7];
      // Knee and elbow fold on one side and turn about a helper bone that
      // goes half way, so the joint keeps its girth when it is bent double.
      const knee = other => ({ bone: other, radius: 0.09, crease: { side: -1, radius: 0.03 }, helper: 'knee' + i });
      const elbow = other => ({ bone: other, radius: 0.06, crease: { side: -1, radius: 0.035 }, helper: 'elbow' + i });
      const hip = (p, below) => give(below(p), 'pelvis', 1 - thighShare(p, s));
      body(thigh, geometry.leg, { scale: legScale, surface: SURFACE.pants, grain: grain(GRAIN.knit, 0.62 * limb, 0.64), uv: region('leg', { shared: true, flipV: true }), blend: [knee(shin)], weights: hip });
      body(shin, geometry.sock, { scale: legScale, surface: SURFACE.sock, grain: grain(GRAIN.rib, 0.34 * limb, 0.45, 0.7), uv: region('sock', { shared: true, flipV: true }), blend: [knee(thigh), [foot, 0.05]] });
      // The shoe bends at the ball of the foot.
      const ball = { bone: 'toe' + i, radius: 0.026 * k, dir: FORWARD };
      body(foot, geometry.cleat, { scale: [1, k, k], color: look.cleat, surface: SURFACE.cleat, grain: [GRAIN.leather, 12, 8, 0.25], uv: plain, blend: [[shin, 0.04], ball] });
      body(foot, geometry.studs, { scale: [1, k, k], color: '#101114', surface: SURFACE.sole, uv: plain, blend: [ball], detail: true });

      // Shoulder to elbow, everything around the arm takes its weights from
      // one chain, so the sleeve and the arm inside it cannot part: the cap
      // sits on the pad bone, the cloth below it follows the arm's swing, and
      // the arm's twist only builds up toward the elbow. The sleeve's tube
      // keeps clear of the biceps of the biggest builds.
      const arm = { from: upper, to: fore, bones: [['pad' + i, 0.09], ['swing' + i, 0.3], ['upMid' + i, 0.6], [upper, 0.95]] };
      const fit = 1.05 * limb / limb ** 0.7;
      const sleeveFit = fit > 1 ? v => { const w = lerp(1, fit, smoothstep(-0.05, -0.15, v.y)); v.x *= w; v.z *= w; } : null;
      body(upper, geometry.upperArm, { scale: armScale, color: armColor, surface: armSurface, grain: grain(armGrain, 0.44 * limb, 0.45, look.armSleeve ? 0.5 : 0.3), uv: plain, blend: [elbow(fore)], chain: arm });
      body(upper, geometry.sleeve, { scale: capScale, surface: SURFACE.cloth, grain: grain(GRAIN.mesh, 0.62 * limb ** 0.7, 0.29, 0.55), uv: region(i === 0 ? 'sleeveL' : 'sleeveR', { flipU: i === 0, flipV: true }), chain: arm, warp: sleeveFit });
      // Elbow to wrist the forearm turns over with the hand, a little at the
      // elbow and all the way at the wrist; tape and gloves follow the same
      // weights as the arm they wrap.
      const turn = { from: fore, to: hand, bones: [[fore, 0.2], ['foreMid' + i, 0.6], ['foreTwist' + i, 1]] };
      body(fore, geometry.forearm, { scale: armScale, color: armColor, surface: armSurface, grain: grain(armGrain, 0.33 * limb, 0.4, look.armSleeve ? 0.5 : 0.3), uv: plain, blend: [elbow(upper), [hand, 0.03]], chain: turn });
      if (look.band && !look.armSleeve) body(upper, geometry.band, { scale: armScale, color: look.band, surface: SURFACE.tape, grain: grain(GRAIN.rib, 0.46, 0.03, 0.7), uv: plain, chain: arm, detail: true });
      if (look.tape) body(fore, geometry.tape, { scale: armScale, color: '#ebe9e2', surface: SURFACE.tape, grain: grain(GRAIN.weave, 0.22, 0.09), uv: plain, blend: [[hand, 0.03]], chain: turn, detail: true });
      const gloveScale = [s * gs[0], gs[1], gs[2]], glove = { scale: gloveScale, color: look.glove, surface: SURFACE.glove, grain: [GRAIN.leather, 4, 5, 0.22], uv: plain };
      body(hand, geometry.glove, { ...glove, blend: [{ bone: 'foreTwist' + i, radius: 0.03, pivot: hand, ownIsChild: true }] });
      // Each digit is rigid between its joints and shared across them. The
      // reduced hand is a mitten with no digits.
      HAND_DIGITS.forEach(({ joints: [j1, j2] }, n) => {
        if (!geometry['digit' + n]) return;
        const { joints: [a, b, c], length } = this.digits[i][n], row = o => this.boneBase + this.joints.indexOf(o), e = 0.07;
        const root = new THREE.Vector3().setFromMatrixPosition(a.matrixWorld), tip = new THREE.Vector3(0, -length, 0).applyMatrix4(a.matrixWorld);
        const along = chainWeights(root, tip, [[index(hand), -e], [row(a), e], [row(a), j1 - e], [row(b), j1 + e], [row(b), j2 - e], [row(c), j2 + e]]);
        body(hand, geometry['digit' + n], { ...glove, weights: p => along(p, 1, []) });
      });
    });
  }

  // Poses the joint tree for a body at simulation (x, z) facing `yaw` (scene
  // radians), refreshes its world matrices and writes the skinning matrices.
  apply(pose, x, z, yaw) {
    const d = this.dims, W = this.world;
    this.root.position.set(x, 0, -z);
    this.root.rotation.set(0, yaw + pose.yaw, 0);
    this.tilt.position.set(pose.tiltSide, pose.tiltLift, pose.tiltFwd);
    this.tilt.rotation.set(pose.tiltPitch, 0, pose.tiltRoll, 'XZY');

    this.pelvis.position.copy(pose.pelvis);
    eulerQuat(pose.hips, this.pelvis.quaternion);
    eulerQuat(pose.spine, this.abdomen.quaternion, SPINE_SPLIT);
    eulerQuat(pose.spine, this.chest.quaternion, 1 - SPINE_SPLIT);
    // Chest orientation in the tilt frame, used to stabilise the head.
    const chestQ = this.chestQuat.copy(this.pelvis.quaternion).multiply(this.abdomen.quaternion).multiply(this.chest.quaternion);

    // Head: an absolute orientation in the tilt frame, limited relative to
    // the chest. The neck takes part of the turn, so a head that looks down
    // also comes forward instead of nodding on one pivot.
    eulerQuat(pose.head, _q);
    _qa.copy(chestQ).invert().multiply(_q);
    const angle = 2 * Math.acos(Math.min(1, Math.abs(_qa.w)));
    if (angle > NECK_LIMIT) _qa.slerp(IDENTITY, 1 - NECK_LIMIT / angle);
    this.neck.quaternion.copy(IDENTITY).slerp(_qa, NECK_SPLIT);
    if (pose.neck.x || pose.neck.y || pose.neck.z) this.neck.quaternion.premultiply(eulerQuat(pose.neck, _q));
    this.head.quaternion.copy(this.neck.quaternion).invert().multiply(_qa);

    // Legs: solve in the pelvis frame.
    _qi.copy(this.pelvis.quaternion).invert();
    for (let i = 0; i < 2; i++) {
      _t.copy(pose.feet[i]).sub(pose.pelvis).applyQuaternion(_qi);
      _pole.copy(pose.knees[i]).applyQuaternion(_qi);
      _origin.copy(this.thighs[i].position);
      const bend = solveTwoBone(_origin, _t, _pole, d.thigh, d.shin, this.thighs[i].quaternion, _ik);
      W.reachShort.feet[i] = _ik.short;
      this.shins[i].position.y = this.kneeBones[i].position.y = -d.thigh - _ik.stretch / 2;
      this.feet[i].position.y = -d.shin - _ik.stretch / 2;
      this.shins[i].quaternion.setFromAxisAngle(X_AXIS, bend);
      this.kneeBones[i].quaternion.setFromAxisAngle(X_AXIS, bend / 2);
      // Foot orientation is given in the tilt frame; convert to shin-local.
      _qa.copy(this.pelvis.quaternion).multiply(this.thighs[i].quaternion).multiply(this.shins[i].quaternion).invert();
      eulerQuat(pose.footRot[i], _qb);
      this.feet[i].quaternion.copy(_qa.multiply(_qb));
    }

    // Arms: targets are already in the chest frame.
    const [sx, sy, sz] = d.shoulder, reach = d.upperArm + d.forearm;
    for (let i = 0; i < 2; i++) {
      const s = SIDES[i], upper = this.uppers[i], hand = this.hands[i], target = pose.hands[i];
      // The shoulder girdle: a first solve from the resting shoulder says
      // where the arm is going; the collarbone lifts as the arm rises (about
      // a third of the way past the horizontal), comes forward as it reaches
      // across or ahead, and gives a little more to a target out of reach.
      _origin.set(s * sx, sy, sz);
      solveTwoBone(_origin, target, pose.elbows[i], d.upperArm, d.forearm, _q);
      _u.copy(HANG).applyQuaternion(_q);
      const phi = Math.acos(clamp(-_u.y, -1, 1));
      _t.subVectors(target, _origin);
      const far = _t.length(), over = smoothstep(0.9, 1.1, far / reach);
      _t.divideScalar(far || 1);
      const shrug = pose.shoulders[i];
      const lift = clamp(0.42 * smoothstep(0.6, 2.6, phi) + 0.25 * over * Math.max(0, _t.y) + shrug.x, -0.12, 0.6);
      const forward = clamp(0.3 * _u.z * Math.sin(phi) + 0.22 * smoothstep(0, 0.7, -s * _t.x) * (_t.z > 0 ? 1 : 0) + 0.3 * over * _t.z + shrug.y, -0.3, 0.5);
      const clav = this.clavs[i];
      clav.quaternion.setFromAxisAngle(Z_AXIS, s * lift).multiply(_q.setFromAxisAngle(Y_AXIS, -s * forward));
      _origin.sub(clav.position).applyQuaternion(clav.quaternion).add(clav.position);
      upper.position.copy(_origin); this.pads[i].position.copy(_origin); this.swings[i].position.copy(_origin);

      const bend = solveTwoBone(_origin, target, pose.elbows[i], d.upperArm, d.forearm, upper.quaternion, _ik);
      W.reachShort.hands[i] = _ik.short;
      this.forearms[i].position.y = this.elbowBones[i].position.y = -d.upperArm - _ik.stretch / 2;
      hand.position.y = -d.forearm - _ik.stretch / 2;
      this.forearms[i].quaternion.setFromAxisAngle(X_AXIS, bend);
      this.elbowBones[i].quaternion.setFromAxisAngle(X_AXIS, bend / 2);

      // The upper arm's turn is a swing (where it points) and a twist about
      // its own length. The twist is undefined for an arm straight overhead,
      // so it fades out there.
      _u.copy(HANG).applyQuaternion(upper.quaternion);
      const raise = Math.acos(clamp(-_u.y, -1, 1));
      _qa.setFromUnitVectors(HANG, _u).multiply(HALF_TURN);                       // the same direction, no twist
      const twist = twistY(_qb.copy(_qa).invert().multiply(upper.quaternion)) * (1 - smoothstep(2.4, 3.0, raise));
      this.swings[i].quaternion.copy(upper.quaternion).multiply(_q.setFromAxisAngle(Y_AXIS, -twist));
      this.upMids[i].quaternion.setFromAxisAngle(Y_AXIS, -twist / 2);
      // The pad cap stays put until the arm is well away from the side, then
      // tips part of the way with it (about forty degrees overhead).
      this.pads[i].quaternion.copy(HALF_TURN).slerp(this.swings[i].quaternion, 0.35 * smoothstep(0.35, 2.2, raise));

      // The hand on the forearm: the pose's Euler angles, or turned toward
      // the attitude it asks for (aim), within a wrist's range.
      const w = pose.wrists[i];
      hand.quaternion.setFromEuler(_e.set(w.x, w.y, w.z, 'XYZ'));
      if (pose.aim[i] > 0 && pose.palm[i].lengthSq() > 1e-8 && pose.point[i].lengthSq() > 1e-8) {
        // Hand axes: the palm faces +X on the left hand and -X on the right
        // (a mirror image), the fingers run along -Y.
        _vx.copy(pose.palm[i]).normalize().multiplyScalar(s);
        _vy.copy(pose.point[i]).normalize().negate();
        _vy.addScaledVector(_vx, -_vy.dot(_vx));
        if (_vy.lengthSq() > 1e-6) {
          _vy.normalize();
          _vz.crossVectors(_vx, _vy);
          _qa.setFromRotationMatrix(_m.makeBasis(_vx, _vy, _vz));
          _qi.copy(upper.quaternion).multiply(this.forearms[i].quaternion).invert();
          hand.quaternion.slerp(limitWrist(_qa.premultiply(_qi)), Math.min(1, pose.aim[i]));
        }
      }
      // The forearm turns over with the hand: half way at mid-forearm, all
      // the way at the wrist.
      const turn = twistY(hand.quaternion);
      this.foreMids[i].quaternion.setFromAxisAngle(Y_AXIS, turn / 2);
      this.foreTwists[i].quaternion.setFromAxisAngle(Y_AXIS, turn);

      // Fingers, from the hand shape. Flexion is about the hand's Z (toward
      // the palm, so mirrored on the right hand); the fan is about the palm
      // normal, the same way on both.
      const f = pose.fingers[i], digits = this.digits[i];
      for (let n = 1; n < 5; n++) {
        const [a, b, c] = digits[n].joints, curl = f[n];
        a.quaternion.setFromAxisAngle(X_AXIS, FAN[n] * f[5]).multiply(_q.setFromAxisAngle(Z_AXIS, s * 1.5 * f[0]));
        b.quaternion.setFromAxisAngle(Z_AXIS, s * 1.75 * curl);
        c.quaternion.setFromAxisAngle(Z_AXIS, s * 1.15 * curl);
      }
      // The thumb swings across the palm about the line of the fingers, rolls
      // to face them, and curls at its three joints.
      const [a, b, c] = digits[0].joints, tc = f[6], opp = f[7];
      a.quaternion.setFromAxisAngle(Y_AXIS, -s * 1.1 * opp).multiply(_qa.setFromAxisAngle(X_AXIS, FAN[0] * f[5])).multiply(digits[0].rest)
        .multiply(_q.setFromAxisAngle(Y_AXIS, -s * (0.5 + 0.5 * opp))).multiply(_qb.setFromAxisAngle(Z_AXIS, s * 0.45 * tc));
      b.quaternion.setFromAxisAngle(Z_AXIS, s * 0.7 * tc);
      c.quaternion.setFromAxisAngle(Z_AXIS, s * 0.9 * tc);
    }

    this.root.updateMatrixWorld(true);

    // Toes: when the heel is up and the ball of the foot is near the turf the
    // shoe bends there and the forefoot stays flat; in the air it is straight.
    for (let i = 0; i < 2; i++) {
      const foot = this.feet[i], toe = this.toes[i];
      const pitch = Math.asin(clamp(-foot.matrixWorld.elements[9], -1, 1));     // toe down is positive
      W.toes[i].copy(toe.position).applyMatrix4(foot.matrixWorld);
      const contact = 1 - smoothstep(0.03, 0.08, W.toes[i].y - 0.024 * d.k);
      toe.quaternion.setFromAxisAngle(X_AXIS, -(clamp(pitch, 0, 1.05) * contact + pose.toes[i]));
      toe.updateMatrixWorld(true);
    }

    const bones = this.squad.bones;
    for (let b = 0; b < this.joints.length; b++) bones.set(this.boneBase + b, _m.multiplyMatrices(this.joints[b].matrixWorld, this.bindInverse[b]));

    W.pelvis.setFromMatrixPosition(this.pelvis.matrixWorld);
    W.chest.setFromMatrixPosition(this.chest.matrixWorld);
    W.neck.setFromMatrixPosition(this.neck.matrixWorld);
    W.head.setFromMatrixPosition(this.head.matrixWorld);
    W.headTop.set(0, HELMET_CENTRE + 0.14 * this.headSize, 0).applyMatrix4(this.head.matrixWorld);
    const gs = this.gloveScale;
    for (let i = 0; i < 2; i++) {
      const hand = this.hands[i].matrixWorld, h = hand.elements, s = SIDES[i];
      W.hands[i].setFromMatrixPosition(hand);
      W.elbows[i].setFromMatrixPosition(this.forearms[i].matrixWorld);
      W.shoulders[i].setFromMatrixPosition(this.uppers[i].matrixWorld);
      W.palms[i].set(s * 0.016 * gs[0], -0.072 * gs[1], 0).applyMatrix4(hand);
      W.palmNormals[i].set(s * h[0], s * h[1], s * h[2]).normalize();
      W.fingerDirs[i].set(-h[4], -h[5], -h[6]).normalize();
      W.feet[i].setFromMatrixPosition(this.feet[i].matrixWorld);
      W.knees[i].setFromMatrixPosition(this.shins[i].matrixWorld);
    }
  }
}

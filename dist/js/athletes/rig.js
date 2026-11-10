import * as THREE from '../../vendor/three.module.js';
import { loft, mounds, angleBetween, helmetShell, helmetHardware, chinStrap, helmetVisor, glove, cleat, cleatStuds, athleteFace, faceDetails, HELMET_UV } from './geometry.js';
import { solveTwoBone } from './ik.js';
import { eulerQuat, SPINE_SPLIT } from './pose.js';
import { hashString, SIDES, smoothstep } from './math.js';
import { jerseyFor, accessoriesFor, TEAM, SURFACE, REGIONS, GRAIN, GRAIN_TILE } from './uniform.js';
import { BoneTexture, SkinnedGeometryBuilder, jointWeights, skinnedMesh } from './skin.js';

// ---------------------------------------------------------------------------
// Skeleton. Sixteen bones per athlete; every visible part is skinned to one of
// them, with the vertices around each joint shared between the two bones that
// meet there.

export const BONES = [
  'pelvis', 'abdomen', 'chest', 'head',
  'thigh0', 'shin0', 'foot0', 'thigh1', 'shin1', 'foot1',
  'upper0', 'fore0', 'hand0', 'upper1', 'fore1', 'hand1',
];
const BONE_INDEX = Object.fromEntries(BONES.map((b, i) => [b, i]));

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
    this.bones = new BoneTexture(count * BONES.length);
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
      { y: -0.065, w: 0.04, d: 0.045, z: -0.008 }, { y: -0.045, w: 0.16, d: 0.088, z: -0.009 }, { y: 0.0, w: 0.222, d: 0.12, z: -0.014 },
      { y: 0.04, w: 0.219, d: 0.13, z: -0.014 }, { y: 0.1, w: 0.201, d: 0.126, z: -0.006 }, { y: 0.15, w: 0.186, d: 0.124, z: -0.002 },
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
      { y: 0.23, w: 0.268, d: 0.152, n: 2.2 }, { y: 0.285, w: 0.276, d: 0.136, n: 2.2 },
      { y: 0.32, w: 0.262, d: 0.122, n: 2.3 }, { y: 0.34, w: 0.222, d: 0.11, n: 2.3 },
      { y: 0.355, w: 0.15, d: 0.1, n: 2.2 }, { y: 0.372, w: 0.1, d: 0.084 },
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
      { y: 0.065, w: 0.06, d: 0.07 }, { y: 0.0, w: 0.08, d: 0.094 }, { y: -0.05, w: 0.1, d: 0.113, z: 0.002 },
      { y: -0.105, w: 0.111, d: 0.122, z: 0.003 }, { y: -0.2, w: 0.106, d: 0.116, z: 0.006 },
      { y: -0.3, w: 0.086, d: 0.092, z: 0.005 }, { y: -0.39, w: 0.072, d: 0.077, z: 0.002 },
      { y: -0.45, w: 0.066, d: 0.073, z: 0.008 }, { y: -0.5, w: 0.064, d: 0.072, z: 0.011 },
      { y: -0.545, w: 0.058, d: 0.062, z: 0.004 }, { y: -0.566, w: 0.056, d: 0.058 },
      { y: -0.574, w: 0.046, d: 0.047 },
    ], {
      ...L(16, 2), ao: AO.leg,
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
      ...L(10, 2), capTop: false, capBottom: false, ao: AO.sock,
      sculpt: mounds([
        { y: -0.16, t: BACK - 0.6, sy: 0.06, st: 0.5, a: 0.006 }, { y: -0.18, t: BACK + 0.5, sy: 0.05, st: 0.45, a: 0.004 },
        { y: -0.3, t: FRONT, sy: 0.12, st: 0.3, a: 0.003 },
      ]),
    }),
    // Upper arm: biceps to the front (-Z), triceps behind.
    upperArm: loft([
      { y: 0.05, w: 0.064, d: 0.066 }, { y: -0.02, w: 0.077, d: 0.082 }, { y: -0.12, w: 0.075, d: 0.085, z: -0.003 },
      { y: -0.21, w: 0.068, d: 0.078, z: -0.004 }, { y: -0.3, w: 0.055, d: 0.06, z: -0.001 }, { y: -0.36, w: 0.049, d: 0.052 }, { y: -0.4, w: 0.042, d: 0.044 },
    ], {
      ...L(10, 2), capTop: false, capBottom: false, ao: AO.upperArm,
      sculpt: mounds([
        { y: -0.2, t: BACK, sy: 0.06, st: 0.6, a: 0.007 },       // -Z is the front of the arm: the biceps
        { y: -0.15, t: FRONT - 0.2, sy: 0.07, st: 0.5, a: 0.006 }, // triceps
        { y: -0.37, t: FRONT, sy: 0.025, st: 0.4, a: 0.004 },     // elbow
      ]),
    }),
    // The shoulder-pad cap under the jersey, and the tight sleeve that ends
    // on the biceps. The cap sits out over the deltoid, away from the neck.
    sleeve: loft([
      { y: 0.09, w: 0.034, d: 0.054, x: -0.008, z: -0.004 }, { y: 0.068, w: 0.076, d: 0.09, x: -0.008, z: -0.006, n: 2.3 },
      { y: 0.022, w: 0.099, d: 0.114, x: -0.007, z: -0.008, n: 2.4 }, { y: -0.035, w: 0.103, d: 0.116, x: -0.005, z: -0.008, n: 2.4 },
      { y: -0.08, w: 0.097, d: 0.106, x: -0.003, z: -0.005, n: 2.3 }, { y: -0.103, w: 0.089, d: 0.095 },
      { y: -0.15, w: 0.085, d: 0.092, z: -0.002 }, { y: -0.196, w: 0.081, d: 0.087, z: -0.003 }, { y: -0.203, w: 0.072, d: 0.077, z: -0.003 },
    ], { ...L(14, 2), capBottom: false, ao: AO.sleeve }),
    // Forearm: full below the elbow, tapering to a narrow wrist.
    forearm: loft([
      { y: 0.035, w: 0.044, d: 0.046 }, { y: -0.012, w: 0.052, d: 0.053, z: -0.002 },
      { y: -0.07, w: 0.062, d: 0.062, z: -0.005 }, { y: -0.13, w: 0.058, d: 0.056, z: -0.004 },
      { y: -0.2, w: 0.047, d: 0.044 }, { y: -0.27, w: 0.035, d: 0.032, z: 0.002 },
      { y: -0.33, w: 0.03, d: 0.027, z: 0.002 }, { y: -0.36, w: 0.03, d: 0.026 },
    ], {
      ...L(10, 2), capTop: false, capBottom: false, ao: AO.forearm,
      sculpt: mounds([{ y: -0.08, t: OUT + 2.6, sy: 0.06, st: 0.6, a: 0.005 }, { y: -0.1, t: BACK, sy: 0.07, st: 0.5, a: 0.003 }]),
    }),
    tape: loft([{ y: -0.25, w: 0.04, d: 0.036 }, { y: -0.29, w: 0.037, d: 0.0335 }, { y: -0.34, w: 0.0345, d: 0.031 }], { ...L(10, 1), capTop: false, capBottom: false }),
    glove: glove({ low }),
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
// The joints of the rig being built whose bone stands above them.
const SPINE = new Set();

const _q = new THREE.Quaternion(), _qi = new THREE.Quaternion(), _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion();
const _t = new THREE.Vector3(), _pole = new THREE.Vector3(), _origin = new THREE.Vector3();
const _e = new THREE.Euler(), X_AXIS = new THREE.Vector3(1, 0, 0);
const _m = new THREE.Matrix4(), _local = new THREE.Matrix4(), _c = new THREE.Color();

export class Rig {
  // lowGeometry: createGeometries({ low: true }), baked into the squad's
  // reduced meshes when it has them.
  constructor(squad, spec, index, geometry, atlas, lowGeometry = null) {
    this.id = spec.id;
    this.spec = spec;
    this.squad = squad;
    this.index = index;
    this.level = '';   // '' while baking the full meshes, 'Low' for the reduced ones
    this.boneBase = index * BONES.length;
    const d = this.dims = dimensionsFor(spec);
    const look = this.look = accessoriesFor(spec, index);
    const { jersey } = jerseyFor(spec);

    const joint = (parent, x = 0, y = 0, z = 0) => { const o = new THREE.Object3D(); o.position.set(x, y, z); if (parent) parent.add(o); return o; };
    this.root = joint(null);
    this.tilt = joint(this.root);
    this.pelvis = joint(this.tilt, 0, d.hipY, 0);
    this.abdomen = joint(this.pelvis, 0, d.waist, 0);
    this.chest = joint(this.abdomen, 0, d.mid, 0);
    this.head = joint(this.chest, 0, d.neck, 0.012);
    this.thighs = []; this.shins = []; this.feet = [];
    this.uppers = []; this.forearms = []; this.hands = [];
    SIDES.forEach(s => {
      const thigh = joint(this.pelvis, s * d.hipX, 0, 0);
      const shin = joint(thigh, 0, -d.thigh, 0);
      this.thighs.push(thigh); this.shins.push(shin); this.feet.push(joint(shin, 0, -d.shin, 0));
      const upper = joint(this.chest, s * d.shoulder[0], d.shoulder[1], d.shoulder[2]);
      const fore = joint(upper, 0, -d.upperArm, 0);
      this.uppers.push(upper); this.forearms.push(fore); this.hands.push(joint(fore, 0, -d.forearm, 0));
    });
    SPINE.clear(); SPINE.add(this.abdomen).add(this.chest).add(this.head);
    this.joints = [
      this.pelvis, this.abdomen, this.chest, this.head,
      this.thighs[0], this.shins[0], this.feet[0], this.thighs[1], this.shins[1], this.feet[1],
      this.uppers[0], this.forearms[0], this.hands[0], this.uppers[1], this.forearms[1], this.hands[1],
    ];

    // Rest pose = bind pose: standing straight, arms hanging, at the origin.
    // The arm solver points each upper arm's local +Z at the elbow, which
    // hangs behind him, so the bind arms are turned the same way (half a turn
    // about their length); otherwise the shoulder blend would average two
    // orientations 180 degrees apart and pinch the sleeves. Rigid parts look
    // the same whatever the bind pose.
    for (const upper of this.uppers) upper.quaternion.setFromAxisAngle(_t.set(0, 1, 0), Math.PI);
    this.root.updateMatrixWorld(true);
    this.bindInverse = this.joints.map(j => j.matrixWorld.clone().invert());
    this.buildParts(geometry, atlas, jersey, look);
    if (lowGeometry && squad.builders.bodyLow) {
      this.level = 'Low';
      this.buildParts(lowGeometry, atlas, jersey, look);
      this.level = '';
    }

    // Resolved joint positions in world space, refreshed after every apply().
    this.world = {
      pelvis: new THREE.Vector3(), chest: new THREE.Vector3(), head: new THREE.Vector3(),
      hands: [new THREE.Vector3(), new THREE.Vector3()], elbows: [new THREE.Vector3(), new THREE.Vector3()],
      feet: [new THREE.Vector3(), new THREE.Vector3()],
    };
    this.chestQuat = new THREE.Quaternion();
  }

  // Bakes one part into a squad mesh. `bone` is the bone it rides on;
  // `blend` lists [otherBone, radius] pairs for the joints it bends across.
  part(target, bone, geometry, { pos = [0, 0, 0], rot = [0, 0, 0], scale = [1, 1, 1], color = '#ffffff', surface = SURFACE.cloth, grain = undefined, uv = null, blend = [], weights = null, detail = false } = {}) {
    // Small details are not drawn on distant athletes.
    if (detail && this.level) return;
    const own = this.joints[BONE_INDEX[bone]];
    _local.compose(_t.set(...pos), _q.setFromEuler(_e.set(...rot)), _origin.set(...scale));
    const bind = new THREE.Matrix4().multiplyMatrices(own.matrixWorld, _local);
    const joints = blend.map(([name, radius, crease]) => {
      const other = this.joints[BONE_INDEX[name]];
      // The joint is the origin of whichever bone is the child of the pair.
      // Down a limb the child hangs below its joint; up the spine (abdomen,
      // chest, head) it stands above it.
      const ownIsChild = own.parent === other;
      const pivot = ownIsChild ? own : other, upper = ownIsChild ? other : own;
      const ownIsLower = ownIsChild !== SPINE.has(pivot);
      _t.setFromMatrixPosition(pivot.matrixWorld);
      const j = { x: _t.x, y: _t.y, z: _t.z, radius, ownIsLower, other: this.boneBase + BONE_INDEX[name] };
      // The fold side of a hinge, given in the upper bone's frame.
      if (crease) {
        const dir = _origin.set(0, 0, crease.side).transformDirection(upper.matrixWorld);
        j.crease = { x: dir.x, z: dir.z, radius: crease.radius };
      }
      return j;
    });
    const jointBlend = jointWeights(this.boneBase + BONE_INDEX[bone], joints);
    this.squad.builders[target + this.level].add(geometry, {
      bind, weights: weights ? p => weights(p, jointBlend) : jointBlend,
      color: _c.set(color), uv, surface, grain, detail, owner: this.index,
    });
  }

  buildParts(geometry, atlas, jersey, look) {
    const d = this.dims, torso = d.torso, depth = (1 + torso) / 2, limb = d.limb, k = d.k;
    const body = (...args) => this.part('body', ...args);
    const helmet = (...args) => this.part('helmet', ...args);
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

    // Torso: pants and belt on the pelvis, the jersey over abdomen and chest.
    // The seat and the sides of the crotch partly follow the thighs, so the
    // pants stretch over a lifted knee instead of splitting at the hip.
    const hips = [torso * 0.96, k, depth * d.belly ** 0.3];
    const hipY = _t.setFromMatrixPosition(this.thighs[0].matrixWorld).y, pelvisBone = this.boneBase + BONE_INDEX.pelvis;
    const seat = (p, waist) => {
      // More at the side and behind (the glute rides with the thigh), less
      // in front, where the hip folds.
      const share = 0.72 * smoothstep(-0.09, 0.05, hipY - p.y) * smoothstep(0.01, 0.075, Math.abs(p.x)) * (1 - 0.55 * smoothstep(0.0, 0.09, p.z));
      if (share <= 0.01) return waist(p);
      return [pelvisBone, this.boneBase + BONE_INDEX[p.x > 0 ? 'thigh0' : 'thigh1'], 1 - share];
    };
    const belly = [torso * d.belly ** 0.2, k, depth * d.belly ** 0.5];
    body('pelvis', geometry.pelvis, { scale: hips, surface: SURFACE.pants, grain: grain(GRAIN.knit, 1.0 * torso, 0.23), uv: region('hips', { shared: true }), blend: [['abdomen', 0.06]], weights: seat });
    body('pelvis', geometry.belt, { scale: hips, color: TEAM.belt, surface: SURFACE.belt, grain: grain(GRAIN.leather, 1, 0.04, 0.6), uv: plain, blend: [['abdomen', 0.06]], detail: true });
    // The lower jersey takes the bottom row of the torso panel (its side
    // panels and the folds at the belt) all the way down.
    const hem = region('torso', { flipU: true });
    body('abdomen', geometry.abdomen, { scale: belly, surface: SURFACE.cloth, grain: grain(GRAIN.mesh, 1.05 * torso, 0.31, 0.55), uv: u => hem(u, 0.03), blend: [['pelvis', 0.06], ['chest', 0.1]] });
    body('chest', geometry.chest, { scale: [torso, k, depth], surface: SURFACE.cloth, grain: grain(GRAIN.mesh, 1.36 * torso, 0.432, 0.55), uv: region('torso'), blend: [['abdomen', 0.1]] });
    body('chest', geometry.collar, { scale: [torso ** 0.6, k, depth ** 0.6], color: trim, surface: SURFACE.collar, grain: grain(GRAIN.rib, 0.66, 0.04, 0.8), uv: plain, detail: true });
    body('chest', geometry.neck, { scale: [torso ** 0.6, k, depth ** 0.6], color: look.skin, surface: SURFACE.skin, grain: grain(GRAIN.skin, 0.48, 0.17, 0.3), uv: plain, blend: [['head', 0.05]] });
    // The towel tucked into the front of the pants hangs over the right thigh
    // and swings with it.
    if (look.towel) body('pelvis', geometry.towel, { pos: [-0.1 * torso, 0.125 * k, 0.128 * depth * d.belly ** 0.3], rot: [-0.1, 0.25, 0.04], color: '#ecebe6', surface: SURFACE.towel, grain: [GRAIN.weave, 3, 7, 1], uv: plain, blend: [['thigh1', 0.1]], detail: true });

    // Head: face under the helmet; shell, facemask, strap and visor.
    const shell = [0, HELMET_CENTRE, 0], headSize = 1.1 * (1 + (torso - 1) * 0.2), helmetScale = [headSize, headSize, headSize];
    const whiteTexel = () => HELMET_UV.white;
    body('head', geometry.face, { pos: [0, HELMET_CENTRE - 0.052, 0.022], scale: helmetScale, color: look.skin, surface: SURFACE.skin, grain: grain(GRAIN.skin, 0.5, 0.22, 0.3), uv: plain });
    body('head', geometry.faceDetails, { pos: [0, HELMET_CENTRE - 0.052, 0.022], scale: helmetScale, surface: SURFACE.skin, uv: plain, detail: true });
    helmet('head', geometry.helmet, { pos: shell, scale: helmetScale, surface: SURFACE.shell });
    helmet('head', look.cage ? geometry.hardwareCage : geometry.hardware, { pos: shell, scale: helmetScale, surface: SURFACE.facemask, uv: whiteTexel });
    helmet('head', geometry.strap, { pos: shell, scale: helmetScale, color: '#e9e9e4', surface: SURFACE.strap, uv: whiteTexel, detail: true });
    if (look.visor) helmet('head', geometry.visor, { pos: shell, scale: helmetScale, color: '#0b0f15', surface: SURFACE.visor, uv: whiteTexel });

    const armColor = look.armSleeve || look.skin, armSurface = look.armSleeve ? SURFACE.sleeve : SURFACE.skin, armGrain = look.armSleeve ? GRAIN.rib : GRAIN.skin;
    SIDES.forEach((s, i) => {
      const thigh = 'thigh' + i, shin = 'shin' + i, foot = 'foot' + i, upper = 'upper' + i, fore = 'fore' + i, hand = 'hand' + i;
      // Right-hand limbs are mirror images of the left.
      const legScale = [s * limb, k, limb], armScale = [s * limb, k, limb], capScale = [s * limb ** 0.7, k, limb ** 0.7];
      body(thigh, geometry.leg, { scale: legScale, surface: SURFACE.pants, grain: grain(GRAIN.knit, 0.62 * limb, 0.64), uv: region('leg', { shared: true, flipV: true }), blend: [['pelvis', 0.08, { side: 1, radius: 0.035 }], [shin, 0.09, { side: -1, radius: 0.03 }]] });
      body(shin, geometry.sock, { scale: legScale, surface: SURFACE.sock, grain: grain(GRAIN.rib, 0.34 * limb, 0.45, 0.7), uv: region('sock', { shared: true, flipV: true }), blend: [[thigh, 0.09, { side: -1, radius: 0.03 }], [foot, 0.05]] });
      body(foot, geometry.cleat, { scale: [1, k, k], color: look.cleat, surface: SURFACE.cleat, grain: [GRAIN.leather, 12, 8, 0.25], uv: plain, blend: [[shin, 0.04]] });
      body(foot, geometry.studs, { scale: [1, k, k], color: '#101114', surface: SURFACE.sole, uv: plain, detail: true });

      // The shoulder is a ball joint that also twists, which linear blending
      // pinches; the sleeve top tucks rigidly under the shoulder pad instead.
      body(upper, geometry.upperArm, { scale: armScale, color: armColor, surface: armSurface, grain: grain(armGrain, 0.44 * limb, 0.45, look.armSleeve ? 0.5 : 0.3), uv: plain, blend: [[fore, 0.06, { side: -1, radius: 0.035 }]] });
      body(upper, geometry.sleeve, { scale: capScale, surface: SURFACE.cloth, grain: grain(GRAIN.mesh, 0.62 * limb ** 0.7, 0.29, 0.55), uv: region(i === 0 ? 'sleeveL' : 'sleeveR', { flipU: i === 0, flipV: true }) });
      body(fore, geometry.forearm, { scale: armScale, color: armColor, surface: armSurface, grain: grain(armGrain, 0.33 * limb, 0.4, look.armSleeve ? 0.5 : 0.3), uv: plain, blend: [[upper, 0.06, { side: -1, radius: 0.035 }], [hand, 0.03]] });
      if (look.tape) body(fore, geometry.tape, { scale: armScale, color: '#ebe9e2', surface: SURFACE.tape, grain: grain(GRAIN.weave, 0.22, 0.09), uv: plain, blend: [[hand, 0.03]], detail: true });
      body(hand, geometry.glove, { scale: [s * 1.08 * limb ** 0.5, 1.06 * k, 1.08 * limb ** 0.5], color: look.glove, surface: SURFACE.glove, grain: [GRAIN.leather, 4, 5, 0.22], uv: plain, blend: [[fore, 0.03]] });
    });
  }

  // Poses the joint tree for a body at simulation (x, z) facing `yaw` (scene
  // radians), refreshes its world matrices and writes the skinning matrices.
  apply(pose, x, z, yaw) {
    const d = this.dims;
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

    // Head: an absolute orientation in the tilt frame, limited relative to the chest.
    eulerQuat(pose.head, _q);
    this.head.quaternion.copy(_qi.copy(chestQ).invert().multiply(_q));
    const angle = 2 * Math.acos(Math.min(1, Math.abs(this.head.quaternion.w)));
    if (angle > 1.0) this.head.quaternion.slerp(_qa.identity(), 1 - 1.0 / angle);

    // Legs: solve in the pelvis frame.
    _qi.copy(this.pelvis.quaternion).invert();
    for (let i = 0; i < 2; i++) {
      _t.copy(pose.feet[i]).sub(pose.pelvis).applyQuaternion(_qi);
      _pole.copy(pose.knees[i]).applyQuaternion(_qi);
      _origin.copy(this.thighs[i].position);
      const bend = solveTwoBone(_origin, _t, _pole, d.thigh, d.shin, this.thighs[i].quaternion);
      this.shins[i].quaternion.setFromAxisAngle(X_AXIS, bend);
      // Foot orientation is given in the tilt frame; convert to shin-local.
      _qa.copy(this.pelvis.quaternion).multiply(this.thighs[i].quaternion).multiply(this.shins[i].quaternion).invert();
      eulerQuat(pose.footRot[i], _qb);
      this.feet[i].quaternion.copy(_qa.multiply(_qb));
    }

    // Arms: targets are already in the chest frame.
    for (let i = 0; i < 2; i++) {
      const bend = solveTwoBone(this.uppers[i].position, pose.hands[i], pose.elbows[i], d.upperArm, d.forearm, this.uppers[i].quaternion);
      this.forearms[i].quaternion.setFromAxisAngle(X_AXIS, bend);
      const w = pose.wrists[i];
      _e.set(w.x, w.y, w.z, 'XYZ');
      this.hands[i].quaternion.setFromEuler(_e);
    }

    this.root.updateMatrixWorld(true);
    const bones = this.squad.bones;
    for (let b = 0; b < this.joints.length; b++) bones.set(this.boneBase + b, _m.multiplyMatrices(this.joints[b].matrixWorld, this.bindInverse[b]));

    const W = this.world;
    W.pelvis.setFromMatrixPosition(this.pelvis.matrixWorld);
    W.chest.setFromMatrixPosition(this.chest.matrixWorld);
    W.head.setFromMatrixPosition(this.head.matrixWorld);
    for (let i = 0; i < 2; i++) {
      W.hands[i].setFromMatrixPosition(this.hands[i].matrixWorld);
      W.elbows[i].setFromMatrixPosition(this.forearms[i].matrixWorld);
      W.feet[i].setFromMatrixPosition(this.feet[i].matrixWorld);
    }
  }
}

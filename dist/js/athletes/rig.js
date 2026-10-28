import * as THREE from '../../vendor/three.module.js';
import { loft, helmetShell, helmetHardware, chinStrap, helmetVisor, glove, mirrorX, cleat, athleteFace, faceDetails } from './geometry.js';
import { solveTwoBone } from './ik.js';
import { eulerQuat, SPINE_SPLIT } from './pose.js';
import { hashString, SIDES, smoothstep } from './math.js';
import { jerseyFor, accessoriesFor, TEAM, SURFACE } from './uniform.js';
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
      const mesh = skinnedMesh(builder.build(), material, t, names[key]);
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

  // levels: per athlete 0 (full) or 1 (reduced); ignored without the
  // reduced meshes.
  setLevels(levels) {
    if (!this.meshes.bodyLow) return;
    let changed = false;
    for (let i = 0; i < this.count; i++) if (this.levels[i] !== levels[i]) { this.levels[i] = levels[i]; changed = true; }
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
  chest: (v, t) => 1 - 0.3 * side(t) * smoothstep(0.2, 0.55, v) * (1 - smoothstep(0.62, 0.86, v)) - 0.1 * (1 - smoothstep(0, 0.35, v)),
  abdomen: (v, t) => 0.78 + 0.22 * smoothstep(0, 0.55, v) - 0.08 * side(t),
  pelvis: v => (0.86 + 0.14 * smoothstep(0, 0.4, v)) * (1 - 0.12 * smoothstep(0.82, 1, v)),
  leg: v => 1 - 0.2 * smoothstep(0.88, 1, v),
  upperArm: v => 1 - 0.3 * (1 - smoothstep(0.04, 0.4, v)),        // v = 0 at the shoulder, under the sleeve
  sleeve: v => 0.86 + 0.14 * smoothstep(0, 0.6, v),
  neck: v => 0.55 + 0.25 * v,
  sock: v => 1 - 0.32 * smoothstep(0.84, 1, v),
  forearm: v => 0.92 + 0.08 * smoothstep(0, 0.8, v),
};

// `low`: the distant-athlete set (level of detail 1): about half the
// segments around and no in-between rings on the lofted parts, a coarser
// helmet shell, a simpler facemask. Detail-only parts are never drawn at that
// distance, so their low versions are not used.
export function createGeometries({ low = false } = {}) {
  const L = (radial, subdiv) => (low ? { radial: Math.max(6, Math.round(radial / 2)), subdiv: 1 } : { radial, subdiv });
  // Shared cross-sections keep the outer pant stripe on the cloth while the
  // thigh and knee deform. Full and reduced meshes use the same silhouette.
  const legShape = [
    { y: 0.065, w: 0.069, d: 0.078 }, { y: 0.0, w: 0.096, d: 0.104 },
    { y: -0.09, w: 0.105, d: 0.113, z: 0.002 }, { y: -0.2, w: 0.099, d: 0.105, z: 0.004 },
    { y: -0.3, w: 0.083, d: 0.087, z: 0.003 }, { y: -0.38, w: 0.071, d: 0.075 },
    { y: -0.44, w: 0.064, d: 0.072, z: 0.009 }, { y: -0.49, w: 0.064, d: 0.073, z: 0.013 },
    { y: -0.54, w: 0.06, d: 0.063, z: 0.006 }, { y: -0.585, w: 0.059, d: 0.06 },
    { y: -0.59, w: 0.048, d: 0.048 },
  ];
  const stripe = arcStart => loft(legShape.slice(1, -1).map(r => ({ ...r, w: r.w + 0.0015, d: r.d + 0.0015 })), {
    radial: 2, subdiv: low ? 1 : 2, arcStart, arcLength: 0.28, capTop: false, capBottom: false,
  });
  return {
    pelvis: loft([
      { y: -0.055, w: 0.045, d: 0.048, z: -0.008 }, { y: -0.035, w: 0.142, d: 0.091, z: -0.009 }, { y: 0.0, w: 0.189, d: 0.117, z: -0.012 },
      { y: 0.03, w: 0.202, d: 0.129, z: -0.012 }, { y: 0.1, w: 0.195, d: 0.126, z: -0.004 }, { y: 0.17, w: 0.187, d: 0.128 },
    ], { ...L(24, 3), ao: AO.pelvis }),
    // The jersey is tucked in: its hem stays well inside the pants, whose top
    // edge and belt sit clearly outside it, so the two never intersect.
    belt: loft([{ y: 0.126, w: 0.194, d: 0.134 }, { y: 0.152, w: 0.19, d: 0.135 }], { ...L(24, 1), capTop: false, capBottom: false }),
    abdomen: loft([
      { y: -0.035, w: 0.165, d: 0.111 }, { y: 0.04, w: 0.174, d: 0.12 }, { y: 0.14, w: 0.193, d: 0.136 }, { y: 0.27, w: 0.206, d: 0.142 },
    ], { ...L(16, 2), capTop: false, capBottom: false, ao: AO.abdomen }),
    chest: loft([
      { y: -0.06, w: 0.206, d: 0.143, n: 2.1 }, { y: 0.04, w: 0.22, d: 0.153, n: 2.1 },
      { y: 0.14, w: 0.239, d: 0.163, n: 2.15 }, { y: 0.205, w: 0.253, d: 0.164, n: 2.15 },
      { y: 0.255, w: 0.252, d: 0.15, n: 2.1 }, { y: 0.3, w: 0.222, d: 0.136 },
      { y: 0.335, w: 0.174, d: 0.114 }, { y: 0.36, w: 0.125, d: 0.089 },
      { y: 0.377, w: 0.083, d: 0.07 }, { y: 0.383, w: 0.068, d: 0.065 },
    ], { ...L(24, 2), capBottom: false, flipU: true, ao: AO.chest }),
    neck: loft([{ y: 0.3, w: 0.073, d: 0.068 }, { y: 0.47, w: 0.063, d: 0.062 }], { ...L(12, 2), capBottom: false, ao: AO.neck }),
    // One pant leg from inside the pelvis, over the knee pad, to the cuff
    // below the knee; it is skinned across the knee so it bends as one piece.
    leg: loft(legShape, { ...L(20, 2), ao: AO.leg }),
    stripeL: stripe(-0.14),
    stripeR: stripe(Math.PI - 0.14),
    sock: loft([
      { y: -0.07, w: 0.052, d: 0.053 }, { y: -0.115, w: 0.056, d: 0.059, z: -0.003 }, { y: -0.17, w: 0.061, d: 0.067, z: -0.01 },
      { y: -0.28, w: 0.054, d: 0.059, z: -0.008 }, { y: -0.4, w: 0.037, d: 0.041 }, { y: -0.5, w: 0.035, d: 0.042 },
    ], { ...L(12, 2), capTop: false, capBottom: false, ao: AO.sock }),
    upperArm: loft([
      { y: 0.05, w: 0.065, d: 0.066 }, { y: -0.02, w: 0.076, d: 0.078 }, { y: -0.14, w: 0.074, d: 0.079, z: 0.003 },
      { y: -0.24, w: 0.064, d: 0.067 }, { y: -0.32, w: 0.051, d: 0.052 }, { y: -0.37, w: 0.046, d: 0.048 }, { y: -0.4, w: 0.039, d: 0.04 },
    ], { ...L(12, 2), capTop: false, capBottom: false, ao: AO.upperArm }),
    sleeve: loft([
      { y: 0.082, w: 0.038, d: 0.054 }, { y: 0.045, w: 0.078, d: 0.09 },
      { y: 0.0, w: 0.099, d: 0.103 }, { y: -0.055, w: 0.101, d: 0.103 }, { y: -0.12, w: 0.09, d: 0.092 },
      { y: -0.18, w: 0.081, d: 0.084 }, { y: -0.2, w: 0.079, d: 0.082 },
    ], { ...L(12, 2), capBottom: false, ao: AO.sleeve }),
    cuff: loft([{ y: -0.176, w: 0.083, d: 0.086 }, { y: -0.191, w: 0.0815, d: 0.0845 }], { ...L(12, 1), capTop: false, capBottom: false }),
    forearm: loft([
      { y: 0.035, w: 0.042, d: 0.044 }, { y: -0.012, w: 0.051, d: 0.05, z: -0.002 },
      { y: -0.07, w: 0.06, d: 0.056, z: -0.004 }, { y: -0.13, w: 0.056, d: 0.051, z: -0.003 },
      { y: -0.2, w: 0.046, d: 0.041 }, { y: -0.27, w: 0.034, d: 0.03, z: 0.002 },
      { y: -0.33, w: 0.03, d: 0.026, z: 0.002 }, { y: -0.36, w: 0.03, d: 0.025 },
    ], { ...L(14, 2), capTop: false, capBottom: false, ao: AO.forearm }),
    tape: loft([{ y: -0.255, w: 0.039, d: 0.034 }, { y: -0.335, w: 0.034, d: 0.029 }], { ...L(10, 1), capTop: false, capBottom: false }),
    gloveL: glove({ low }),
    gloveR: mirrorX(glove({ low })),
    cleat: cleat({ low }),
    helmet: low ? helmetShell({ columns: 16, rows: 7 }) : helmetShell(),
    hardware: helmetHardware({ low }),
    strap: chinStrap(),
    visor: helmetVisor({ low }),
    face: athleteFace({ low }),
    faceDetails: faceDetails(),
    // A hand towel, curved around the front of the thigh.
    towel: (() => {
      const g = new THREE.BoxGeometry(0.085, 0.2, 0.006, 3, 6, 1);
      g.translate(0, -0.1, 0);
      const p = g.attributes.position;
      for (let i = 0; i < p.count; i++) p.setZ(i, p.getZ(i) - 2.2 * p.getX(i) ** 2 + 0.04 * Math.max(0, -p.getY(i) - 0.05));
      g.computeVertexNormals();
      return g;
    })(),
  };
}

// ---------------------------------------------------------------------------
// One athlete: joint hierarchy, the parts baked into the squad meshes, and
// the pose solver.

const HELMET_CENTRE = 0.115;

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
  part(target, bone, geometry, { pos = [0, 0, 0], rot = [0, 0, 0], scale = [1, 1, 1], color = '#ffffff', surface = SURFACE.cloth, uv = null, blend = [], weights = null, detail = false } = {}) {
    // Small details are not drawn on distant athletes.
    if (detail && this.level) return;
    const own = this.joints[BONE_INDEX[bone]];
    _local.compose(_t.set(...pos), _q.setFromEuler(_e.set(...rot)), _origin.set(...scale));
    const bind = new THREE.Matrix4().multiplyMatrices(own.matrixWorld, _local);
    const joints = blend.map(([name, radius, crease]) => {
      const other = this.joints[BONE_INDEX[name]];
      // The joint is the origin of whichever bone is the child of the pair.
      const ownIsLower = own.parent === other;
      const pivot = ownIsLower ? own : other, upper = ownIsLower ? other : own;
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
      color: _c.set(color), uv, surface, detail, owner: this.index,
    });
  }

  buildParts(geometry, atlas, jersey, look) {
    const d = this.dims, torso = d.torso, depth = (1 + torso) / 2, limb = d.limb;
    const body = (...args) => this.part('body', ...args);
    const helmet = (...args) => this.part('helmet', ...args);
    const white = atlas.white, chestUV = (u, v) => [atlas.offset[0] + u * atlas.scale[0], atlas.offset[1] + v * atlas.scale[1]];
    const plain = () => white;

    // Torso: pants and belt on the pelvis, the jersey over abdomen and chest.
    // The seat and the sides of the crotch partly follow the thighs, so the
    // pants stretch over a lifted knee instead of splitting at the hip.
    const hips = [torso * 0.96, d.k, depth * d.belly ** 0.3];
    const hipY = _t.setFromMatrixPosition(this.thighs[0].matrixWorld).y, pelvisBone = this.boneBase + BONE_INDEX.pelvis;
    const seat = (p, waist) => {
      const share = 0.55 * smoothstep(-0.03, 0.08, hipY - p.y) * smoothstep(0.01, 0.075, Math.abs(p.x));
      if (share <= 0) return waist(p);
      return [pelvisBone, this.boneBase + BONE_INDEX[p.x > 0 ? 'thigh0' : 'thigh1'], 1 - share];
    };
    body('pelvis', geometry.pelvis, { scale: hips, color: TEAM.silver, surface: SURFACE.pants, uv: plain, blend: [['abdomen', 0.06]], weights: seat });
    body('pelvis', geometry.belt, { scale: hips, color: TEAM.belt, surface: SURFACE.belt, uv: plain, blend: [['abdomen', 0.06]], detail: true });
    body('abdomen', geometry.abdomen, { scale: [torso, d.k, depth * d.belly ** 0.5], color: jersey, uv: plain, blend: [['pelvis', 0.06], ['chest', 0.08]] });
    body('chest', geometry.chest, { scale: [torso, d.k, depth], uv: chestUV, blend: [['abdomen', 0.08]] });
    body('chest', geometry.neck, { scale: [torso ** 0.5, 1, torso ** 0.5], color: look.skin, surface: SURFACE.skin, uv: plain, blend: [['head', 0.05]] });
    // The towel tucked into the front of the pants hangs over the right thigh
    // and swings with it.
    if (look.towel) body('pelvis', geometry.towel, { pos: [-0.1 * torso, 0.12 * d.k, 0.126 * depth], rot: [-0.1, 0.25, 0.04], color: '#f5f5f2', surface: SURFACE.towel, uv: plain, blend: [['thigh1', 0.1]], detail: true });

    // Head: face under the helmet; shell, facemask, strap and visor.
    const shell = [0, HELMET_CENTRE, 0], headSize = 1.1 * (1 + (torso - 1) * 0.2), helmetScale = [headSize, headSize, headSize];
    body('head', geometry.face, { pos: [0, HELMET_CENTRE - 0.052, 0.022], scale: helmetScale, color: look.skin, surface: SURFACE.skin, uv: plain });
    body('head', geometry.faceDetails, { pos: [0, HELMET_CENTRE - 0.052, 0.022], scale: helmetScale, surface: SURFACE.skin, uv: plain, detail: true });
    helmet('head', geometry.helmet, { pos: shell, scale: helmetScale, surface: SURFACE.shell, uv: (u, v) => [u, 0.2 + 0.8 * v] });
    helmet('head', geometry.hardware, { pos: shell, scale: helmetScale, surface: SURFACE.facemask, uv: () => [0.5, 0.08] });
    helmet('head', geometry.strap, { pos: shell, scale: helmetScale, color: '#f1f1ec', surface: SURFACE.strap, uv: () => [0.5, 0.08], detail: true });
    if (look.visor) helmet('head', geometry.visor, { pos: shell, scale: helmetScale, color: '#0c1117', surface: SURFACE.visor, uv: () => [0.5, 0.08] });

    const armColor = look.armSleeve || look.skin, armSurface = look.armSleeve ? SURFACE.sleeve : SURFACE.skin;
    SIDES.forEach((s, i) => {
      const thigh = 'thigh' + i, shin = 'shin' + i, foot = 'foot' + i, upper = 'upper' + i, fore = 'fore' + i, hand = 'hand' + i;
      body(thigh, geometry.leg, { scale: [limb, d.k, limb], color: TEAM.silver, surface: SURFACE.pants, uv: plain, blend: [['pelvis', 0.08, { side: 1, radius: 0.035 }], [shin, 0.09, { side: -1, radius: 0.03 }]] });
      body(thigh, i === 0 ? geometry.stripeL : geometry.stripeR, { scale: [limb, d.k, limb], color: TEAM.navy, surface: SURFACE.cloth, uv: plain, blend: [['pelvis', 0.08, { side: 1, radius: 0.035 }], [shin, 0.09, { side: -1, radius: 0.03 }]] });
      body(shin, geometry.sock, { scale: [limb, d.k, limb], color: TEAM.sock, surface: SURFACE.sock, uv: plain, blend: [[thigh, 0.09, { side: -1, radius: 0.03 }], [foot, 0.05]] });
      body(foot, geometry.cleat, { scale: [1, d.k, d.k], color: look.cleat, surface: SURFACE.cleat, uv: plain, blend: [[shin, 0.04]] });

      // The shoulder is a ball joint that also twists, which linear blending
      // pinches; the sleeve top tucks rigidly under the shoulder pad instead.
      body(upper, geometry.upperArm, { scale: [limb, d.k, limb], color: armColor, surface: armSurface, uv: plain, blend: [[fore, 0.06, { side: -1, radius: 0.035 }]] });
      body(upper, geometry.sleeve, { scale: [limb ** 0.7, d.k, limb ** 0.7], color: jersey, uv: plain });
      body(upper, geometry.cuff, { scale: [limb ** 0.7, d.k, limb ** 0.7], color: this.spec.team === 'defense' ? TEAM.navy : TEAM.silver, uv: plain, detail: true });
      body(fore, geometry.forearm, { scale: [limb, d.k, limb], color: armColor, surface: armSurface, uv: plain, blend: [[upper, 0.06, { side: -1, radius: 0.035 }], [hand, 0.03]] });
      if (look.tape) body(fore, geometry.tape, { scale: [limb, d.k, limb], color: '#f3f2ec', surface: SURFACE.tape, uv: plain, blend: [[hand, 0.03]], detail: true });
      body(hand, i === 0 ? geometry.gloveL : geometry.gloveR, { scale: [limb ** 0.5, d.k, limb ** 0.5], color: look.glove, surface: SURFACE.glove, uv: plain, blend: [[fore, 0.03]] });
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

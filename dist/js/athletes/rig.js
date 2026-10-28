import * as THREE from '../../vendor/three.module.js';
import { loft, helmetShell, helmetHardware, chinStrap, helmetVisor, glove, mirrorX, cleat, tint } from './geometry.js';
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
// bone texture. Parts flagged `detail` (belts, towels, tape, chin straps) are
// stored last in the index buffer so the lowest tier can drop them with a
// draw range instead of a separate draw call.

export class Squad {
  constructor(scene, count, materials) {
    this.scene = scene;
    this.materials = materials;
    this.bones = new BoneTexture(count * BONES.length);
    this.builders = { body: new SkinnedGeometryBuilder(), helmet: new SkinnedGeometryBuilder() };
    this.group = new THREE.Group();
    this.group.name = 'athletes';
    scene.add(this.group);
    this.meshes = {};
  }

  finish() {
    const t = this.bones.texture;
    this.meshes.body = skinnedMesh(this.builders.body.build(), this.materials.body, t, 'athletes:bodies');
    this.meshes.helmet = skinnedMesh(this.builders.helmet.build(), this.materials.helmet, t, 'athletes:helmets');
    for (const mesh of Object.values(this.meshes)) this.group.add(mesh);
    this.builders = null;
  }

  setDetail(visible) {
    for (const mesh of Object.values(this.meshes)) {
      const g = mesh.geometry;
      g.setDrawRange(0, visible ? g.userData.totalCount : g.userData.baseCount);
    }
  }

  commit() {
    this.bones.commit();
  }
}

// ---------------------------------------------------------------------------
// Body types. Proportions follow a 6 ft 2 in athlete (H = 2.06 yd): head and
// helmet about 0.135 H, shoulder-to-hip 0.31 H, hip-to-ground 0.50 H,
// shoulder-to-wrist 0.36 H. Linemen are taller with a 25 % wider torso.

export const BODY_TYPES = {
  ol: { height: 2.12, torso: 1.25, limb: 1.17, belly: 1.2 },
  dl: { height: 2.12, torso: 1.22, limb: 1.15, belly: 1.12 },
  te: { height: 2.1, torso: 1.1, limb: 1.07, belly: 1.04 },
  lb: { height: 2.07, torso: 1.1, limb: 1.07, belly: 1.03 },
  rb: { height: 2.0, torso: 1.06, limb: 1.07, belly: 1.0 },
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
    hipX: 0.095 * (1 + (type.torso - 1) * 0.7),
    thigh: 0.47 * k, shin: 0.47 * k, ankle: 0.09 * k,
    waist: 0.13 * k,           // pelvis -> abdomen joint
    mid: 0.25 * k,             // abdomen -> chest joint
    shoulder: [0.19 * type.torso ** 0.85, 0.255 * k, -0.012],
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
  pelvis: v => (0.72 + 0.28 * smoothstep(0, 0.5, v)) * (1 - 0.12 * smoothstep(0.82, 1, v)),
  leg: v => (0.86 + 0.14 * smoothstep(0, 0.12, v)) * (1 - 0.2 * smoothstep(0.88, 1, v)),
  upperArm: v => 1 - 0.32 * smoothstep(0.62, 0.95, v),
  sleeve: v => 0.86 + 0.14 * smoothstep(0, 0.6, v),
  neck: v => 0.55 + 0.25 * v,
  sock: v => 1 - 0.32 * smoothstep(0.84, 1, v),
  forearm: v => 0.92 + 0.08 * smoothstep(0, 0.8, v),
};

export function createGeometries() {
  return {
    pelvis: loft([
      { y: -0.094, w: 0.04, d: 0.045, z: -0.01 }, { y: -0.074, w: 0.12, d: 0.09, z: -0.016 }, { y: -0.03, w: 0.162, d: 0.11, z: -0.02 },
      { y: 0.03, w: 0.176, d: 0.116, z: -0.012 }, { y: 0.1, w: 0.174, d: 0.116, z: -0.004 }, { y: 0.17, w: 0.168, d: 0.116 },
    ], { radial: 16, subdiv: 2, ao: AO.pelvis }),
    belt: loft([{ y: 0.126, w: 0.173, d: 0.12 }, { y: 0.152, w: 0.17, d: 0.119 }], { radial: 16, subdiv: 1, capTop: false, capBottom: false }),
    abdomen: loft([
      { y: -0.035, w: 0.16, d: 0.11 }, { y: 0.04, w: 0.168, d: 0.12 }, { y: 0.14, w: 0.186, d: 0.132 }, { y: 0.27, w: 0.206, d: 0.142 },
    ], { radial: 16, subdiv: 2, capTop: false, capBottom: false, ao: AO.abdomen }),
    chest: loft([
      { y: -0.06, w: 0.212, d: 0.146, n: 2.2 }, { y: 0.04, w: 0.224, d: 0.153, n: 2.3 }, { y: 0.14, w: 0.244, d: 0.16, n: 2.45 },
      { y: 0.205, w: 0.26, d: 0.165, n: 2.6 }, { y: 0.255, w: 0.268, d: 0.166, n: 2.7 }, { y: 0.3, w: 0.254, d: 0.158, n: 2.6 },
      { y: 0.335, w: 0.22, d: 0.14, n: 2.4 }, { y: 0.36, w: 0.165, d: 0.115, n: 2.2 }, { y: 0.377, w: 0.105, d: 0.088 },
      { y: 0.383, w: 0.072, d: 0.068 },
    ], { radial: 22, subdiv: 2, capBottom: false, flipU: true, ao: AO.chest }),
    neck: loft([{ y: 0.3, w: 0.063, d: 0.064 }, { y: 0.47, w: 0.056, d: 0.058 }], { radial: 12, subdiv: 2, capBottom: false, ao: AO.neck }),
    // One pant leg from inside the pelvis, over the knee pad, to the cuff
    // below the knee; it is skinned across the knee so it bends as one piece.
    leg: loft([
      { y: 0.065, w: 0.07, d: 0.074 }, { y: 0.0, w: 0.094, d: 0.099 }, { y: -0.09, w: 0.095, d: 0.1 }, { y: -0.2, w: 0.087, d: 0.093 },
      { y: -0.3, w: 0.077, d: 0.082 }, { y: -0.38, w: 0.066, d: 0.07 }, { y: -0.44, w: 0.059, d: 0.066, z: 0.006 },
      { y: -0.49, w: 0.057, d: 0.066, z: 0.01 }, { y: -0.54, w: 0.054, d: 0.058, z: 0.004 }, { y: -0.585, w: 0.053, d: 0.056 },
      { y: -0.59, w: 0.04, d: 0.043 },
    ], { radial: 14, subdiv: 2, ao: AO.leg }),
    sock: loft([
      { y: -0.07, w: 0.046, d: 0.048 }, { y: -0.115, w: 0.05, d: 0.053, z: -0.003 }, { y: -0.17, w: 0.054, d: 0.06, z: -0.008 },
      { y: -0.28, w: 0.05, d: 0.054, z: -0.005 }, { y: -0.4, w: 0.037, d: 0.041 }, { y: -0.5, w: 0.035, d: 0.042 },
    ], { radial: 12, subdiv: 2, ao: AO.sock }),
    upperArm: loft([
      { y: 0.05, w: 0.055, d: 0.058 }, { y: -0.02, w: 0.066, d: 0.068 }, { y: -0.14, w: 0.064, d: 0.066 },
      { y: -0.28, w: 0.053, d: 0.054 }, { y: -0.37, w: 0.045, d: 0.046 }, { y: -0.4, w: 0.034, d: 0.036 },
    ], { radial: 12, subdiv: 2, ao: AO.upperArm }),
    sleeve: loft([
      { y: 0.065, w: 0.068, d: 0.07 }, { y: -0.04, w: 0.077, d: 0.079 }, { y: -0.15, w: 0.075, d: 0.077 }, { y: -0.178, w: 0.074, d: 0.076 },
    ], { radial: 12, subdiv: 2, capBottom: false, ao: AO.sleeve }),
    forearm: loft([
      { y: 0.035, w: 0.04, d: 0.042 }, { y: -0.01, w: 0.046, d: 0.046 }, { y: -0.06, w: 0.05, d: 0.048 }, { y: -0.2, w: 0.04, d: 0.037 },
      { y: -0.33, w: 0.031, d: 0.026 }, { y: -0.36, w: 0.029, d: 0.024 },
    ], { radial: 10, subdiv: 2, ao: AO.forearm }),
    tape: loft([{ y: -0.255, w: 0.039, d: 0.034 }, { y: -0.335, w: 0.034, d: 0.029 }], { radial: 10, subdiv: 1, capTop: false, capBottom: false }),
    gloveL: glove(),
    gloveR: mirrorX(glove()),
    cleat: cleat(),
    helmet: helmetShell(),
    hardware: helmetHardware(),
    strap: chinStrap(),
    visor: helmetVisor(),
    face: (() => { const g = new THREE.SphereGeometry(1, 12, 8); g.scale(0.078, 0.1, 0.09); return tint(g, '#ffffff'); })(),
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
  constructor(squad, spec, index, geometry, atlas) {
    this.id = spec.id;
    this.spec = spec;
    this.squad = squad;
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
    this.squad.builders[target].add(geometry, {
      bind, weights: weights ? p => weights(p, jointBlend) : jointBlend,
      color: _c.set(color), uv, surface, detail,
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
    const shell = [0, HELMET_CENTRE, 0], helmetScale = [1.05, 1.05, 1.05];
    body('head', geometry.face, { pos: [0, HELMET_CENTRE - 0.052, 0.022], scale: helmetScale, color: look.skin, surface: SURFACE.skin, uv: plain });
    helmet('head', geometry.helmet, { pos: shell, scale: helmetScale, surface: SURFACE.shell, uv: (u, v) => [u, 0.2 + 0.8 * v] });
    helmet('head', geometry.hardware, { pos: shell, scale: helmetScale, surface: SURFACE.facemask, uv: () => [0.5, 0.08] });
    helmet('head', geometry.strap, { pos: shell, scale: helmetScale, color: '#f1f1ec', surface: SURFACE.strap, uv: () => [0.5, 0.08], detail: true });
    if (look.visor) helmet('head', geometry.visor, { pos: shell, scale: helmetScale, color: '#0c1117', surface: SURFACE.visor, uv: () => [0.5, 0.08] });

    const armColor = look.armSleeve || look.skin, armSurface = look.armSleeve ? SURFACE.sleeve : SURFACE.skin;
    SIDES.forEach((s, i) => {
      const thigh = 'thigh' + i, shin = 'shin' + i, foot = 'foot' + i, upper = 'upper' + i, fore = 'fore' + i, hand = 'hand' + i;
      body(thigh, geometry.leg, { scale: [limb, d.k, limb], color: TEAM.silver, surface: SURFACE.pants, uv: plain, blend: [['pelvis', 0.08, { side: 1, radius: 0.035 }], [shin, 0.09, { side: -1, radius: 0.03 }]] });
      body(shin, geometry.sock, { scale: [limb, d.k, limb], color: TEAM.sock, surface: SURFACE.sock, uv: plain, blend: [[thigh, 0.09, { side: -1, radius: 0.03 }], [foot, 0.05]] });
      body(foot, geometry.cleat, { scale: [1, d.k, d.k], color: look.cleat, surface: SURFACE.cleat, uv: plain, blend: [[shin, 0.04]] });

      // The shoulder is a ball joint that also twists, which linear blending
      // pinches; the sleeve top tucks rigidly under the shoulder pad instead.
      body(upper, geometry.upperArm, { scale: [limb, d.k, limb], color: armColor, surface: armSurface, uv: plain, blend: [[fore, 0.06, { side: -1, radius: 0.025 }]] });
      body(upper, geometry.sleeve, { scale: [limb ** 0.7, d.k, limb ** 0.7], color: jersey, uv: plain });
      body(fore, geometry.forearm, { scale: [limb, d.k, limb], color: armColor, surface: armSurface, uv: plain, blend: [[upper, 0.06, { side: -1, radius: 0.025 }], [hand, 0.03]] });
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
    this.tilt.position.set(0, pose.tiltLift, pose.tiltFwd);
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

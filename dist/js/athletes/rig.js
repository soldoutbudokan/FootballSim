import * as THREE from '../../vendor/three.module.js';
import { loft, helmetShell, helmetHardware, chinStrap, helmetVisor, glove, mirrorX, cleat } from './geometry.js';
import { solveTwoBone } from './ik.js';
import { eulerQuat, SPINE_SPLIT } from './pose.js';
import { hashString, SIDES, smoothstep } from './math.js';
import { tint } from './geometry.js';
import { jerseyFor, accessoriesFor } from './uniform.js';

// ---------------------------------------------------------------------------
// Instancing. Each rig is a tree of plain Object3D joints kept OUT of the
// scene graph; every visible part is a leaf node registered here. Parts that
// share a geometry and a material become one InstancedMesh, so 22 athletes
// cost about twenty draw calls regardless of how many parts each one has.

export class RigBatch {
  constructor(scene) {
    this.scene = scene;
    this.batches = new Map();
  }

  part(parent, geometry, material, { pos = [0, 0, 0], rot = [0, 0, 0], scale = [1, 1, 1], color = null, atlas = null, detail = false } = {}) {
    const node = new THREE.Object3D();
    node.position.set(...pos);
    node.rotation.set(...rot);
    node.scale.set(...scale);
    parent.add(node);
    const key = geometry.uuid + '/' + material.uuid;
    if (!this.batches.has(key)) this.batches.set(key, { geometry, material, nodes: [], colors: [], atlas: [], detail });
    const batch = this.batches.get(key);
    batch.nodes.push(node);
    batch.colors.push(color);
    batch.atlas.push(atlas);
    return node;
  }

  finish() {
    const color = new THREE.Color();
    for (const b of this.batches.values()) {
      const count = b.nodes.length;
      if (b.atlas[0]) {
        const data = new Float32Array(count * 2);
        b.atlas.forEach((o, i) => { data[i * 2] = o[0]; data[i * 2 + 1] = o[1]; });
        b.geometry.setAttribute('atlasOffset', new THREE.InstancedBufferAttribute(data, 2));
      }
      b.mesh = new THREE.InstancedMesh(b.geometry, b.material, count);
      b.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      b.mesh.castShadow = true;
      b.mesh.receiveShadow = true;
      b.mesh.frustumCulled = false;
      b.mesh.name = 'athletes:' + (b.material.name || b.geometry.type);
      if (b.colors.some(c => c)) b.colors.forEach((c, i) => b.mesh.setColorAt(i, color.set(c || '#ffffff')));
      this.scene.add(b.mesh);
    }
  }

  setDetail(visible) {
    for (const b of this.batches.values()) if (b.detail) b.mesh.visible = visible;
  }

  // Copies every part's world matrix into its instance slot.
  update() {
    for (const b of this.batches.values()) {
      const array = b.mesh.instanceMatrix.array;
      for (let i = 0; i < b.nodes.length; i++) array.set(b.nodes[i].matrixWorld.elements, i * 16);
      b.mesh.instanceMatrix.needsUpdate = true;
    }
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
// Shared geometry, built once for all rigs (see geometry.js for the shapes).

// Baked occlusion for the cloth: armpits and the sides under the arms, the
// jersey tucked into the belt, the seat and crotch of the pants, skin under
// the sleeves and socks under the knee cuffs.
const side = t => Math.abs(Math.cos(t)) ** 6;
const AO = {
  chest: (v, t) => 1 - 0.3 * side(t) * smoothstep(0.2, 0.55, v) * (1 - smoothstep(0.62, 0.86, v)) - 0.1 * (1 - smoothstep(0, 0.35, v)),
  abdomen: (v, t) => 0.76 + 0.24 * smoothstep(0, 0.55, v) - 0.08 * side(t),
  pelvis: v => (0.7 + 0.3 * smoothstep(0, 0.5, v)) * (1 - 0.12 * smoothstep(0.82, 1, v)),
  thigh: v => 1 - 0.2 * smoothstep(0.82, 1, v),
  upperArm: v => 1 - 0.32 * smoothstep(0.62, 0.95, v),
  sleeve: (v, t) => 0.86 + 0.14 * smoothstep(0, 0.6, v),
  neck: v => 0.55 + 0.25 * v,
  sock: v => 1 - 0.3 * smoothstep(0.86, 1, v),
  forearm: v => 0.92 + 0.08 * smoothstep(0, 0.8, v),
  knee: v => 0.84 + 0.16 * smoothstep(0, 0.3, v),
};

export function createGeometries() {
  return {
    pelvis: loft([
      { y: -0.094, w: 0.04, d: 0.045, z: -0.01 }, { y: -0.074, w: 0.12, d: 0.09, z: -0.012 }, { y: -0.03, w: 0.166, d: 0.118, z: -0.014 },
      { y: 0.03, w: 0.18, d: 0.125, z: -0.008 }, { y: 0.1, w: 0.177, d: 0.123 }, { y: 0.17, w: 0.17, d: 0.12 },
    ], { radial: 16, subdiv: 2, ao: AO.pelvis }),
    belt: loft([{ y: 0.126, w: 0.176, d: 0.126 }, { y: 0.152, w: 0.172, d: 0.123 }], { radial: 16, subdiv: 1, capTop: false, capBottom: false }),
    abdomen: loft([
      { y: -0.05, w: 0.162, d: 0.114 }, { y: 0.04, w: 0.17, d: 0.124 }, { y: 0.14, w: 0.186, d: 0.134 }, { y: 0.27, w: 0.206, d: 0.142 },
    ], { radial: 16, subdiv: 2, capTop: false, capBottom: false, ao: AO.abdomen }),
    chest: loft([
      { y: -0.06, w: 0.212, d: 0.146, n: 2.2 }, { y: 0.04, w: 0.224, d: 0.153, n: 2.3 }, { y: 0.14, w: 0.244, d: 0.16, n: 2.45 },
      { y: 0.205, w: 0.26, d: 0.165, n: 2.6 }, { y: 0.255, w: 0.268, d: 0.166, n: 2.7 }, { y: 0.3, w: 0.254, d: 0.158, n: 2.6 },
      { y: 0.335, w: 0.22, d: 0.14, n: 2.4 }, { y: 0.36, w: 0.165, d: 0.115, n: 2.2 }, { y: 0.377, w: 0.105, d: 0.088 },
      { y: 0.383, w: 0.072, d: 0.068 },
    ], { radial: 22, subdiv: 2, capBottom: false, flipU: true, ao: AO.chest }),
    neck: loft([{ y: 0.3, w: 0.063, d: 0.064 }, { y: 0.47, w: 0.056, d: 0.058 }], { radial: 12, subdiv: 1, capBottom: false, ao: AO.neck }),
    thigh: loft([
      { y: 0.065, w: 0.07, d: 0.074 }, { y: 0.0, w: 0.094, d: 0.099 }, { y: -0.09, w: 0.095, d: 0.1 }, { y: -0.2, w: 0.088, d: 0.094 },
      { y: -0.3, w: 0.077, d: 0.083 }, { y: -0.44, w: 0.063, d: 0.068 }, { y: -0.495, w: 0.059, d: 0.063 },
    ], { radial: 14, subdiv: 2, ao: AO.thigh }),
    knee: loft([
      { y: 0.055, w: 0.058, d: 0.062 }, { y: 0.0, w: 0.062, d: 0.067, z: 0.004 }, { y: -0.07, w: 0.061, d: 0.066, z: 0.002 }, { y: -0.128, w: 0.06, d: 0.064 },
    ], { radial: 14, subdiv: 1, ao: AO.knee }),
    sock: loft([
      { y: -0.06, w: 0.045, d: 0.047 }, { y: -0.16, w: 0.056, d: 0.061, z: -0.006 }, { y: -0.28, w: 0.05, d: 0.054, z: -0.004 },
      { y: -0.42, w: 0.036, d: 0.04 }, { y: -0.5, w: 0.034, d: 0.041 },
    ], { radial: 12, subdiv: 2, ao: AO.sock }),
    upperArm: loft([
      { y: 0.05, w: 0.055, d: 0.058 }, { y: -0.02, w: 0.066, d: 0.068 }, { y: -0.14, w: 0.064, d: 0.066 },
      { y: -0.28, w: 0.053, d: 0.054 }, { y: -0.385, w: 0.044, d: 0.045 },
    ], { radial: 12, subdiv: 2, ao: AO.upperArm }),
    sleeve: loft([
      { y: 0.065, w: 0.068, d: 0.07 }, { y: -0.04, w: 0.077, d: 0.079 }, { y: -0.15, w: 0.075, d: 0.077 }, { y: -0.178, w: 0.074, d: 0.076 },
    ], { radial: 12, subdiv: 2, capBottom: false, ao: AO.sleeve }),
    forearm: loft([
      { y: 0.035, w: 0.043, d: 0.046 }, { y: -0.06, w: 0.05, d: 0.048 }, { y: -0.2, w: 0.04, d: 0.037 },
      { y: -0.33, w: 0.031, d: 0.026 }, { y: -0.36, w: 0.029, d: 0.024 },
    ], { radial: 10, subdiv: 2, ao: AO.forearm }),
    tape: loft([{ y: -0.255, w: 0.039, d: 0.034 }, { y: -0.335, w: 0.034, d: 0.029 }], { radial: 12, subdiv: 1, capTop: false, capBottom: false }),
    gloveL: glove(),
    gloveR: mirrorX(glove()),
    cleat: cleat(),
    helmet: helmetShell(),
    hardware: helmetHardware(),
    strap: chinStrap(),
    visor: helmetVisor(),
    face: (() => { const g = new THREE.SphereGeometry(1, 12, 9); g.scale(0.078, 0.1, 0.09); return tint(g, '#ffffff'); })(),
    towel: (() => { const g = new THREE.BoxGeometry(0.11, 0.24, 0.008, 1, 4, 1); g.translate(0, -0.12, 0); return g; })(),
  };
}

// ---------------------------------------------------------------------------
// One athlete: joint hierarchy, parts, and the pose solver.


const HELMET_CENTRE = 0.115;

const _q = new THREE.Quaternion(), _qi = new THREE.Quaternion(), _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion();
const _v = new THREE.Vector3(), _t = new THREE.Vector3(), _pole = new THREE.Vector3(), _origin = new THREE.Vector3();
const _e = new THREE.Euler(), X_AXIS = new THREE.Vector3(1, 0, 0);

export class Rig {
  constructor(batch, spec, index, materials, geometry, atlasOffset) {
    this.id = spec.id;
    this.spec = spec;
    const d = this.dims = dimensionsFor(spec);
    const look = accessoriesFor(spec, index);
    const { jersey } = jerseyFor(spec);
    this.look = look;

    const joint = (parent, x = 0, y = 0, z = 0) => { const o = new THREE.Object3D(); o.position.set(x, y, z); if (parent) parent.add(o); return o; };
    const part = (parent, geo, mat, opts) => batch.part(parent, geo, mat, opts);

    this.root = joint(null);
    this.tilt = joint(this.root);
    this.pelvis = joint(this.tilt, 0, d.hipY, 0);
    this.abdomen = joint(this.pelvis, 0, d.waist, 0);
    this.chest = joint(this.abdomen, 0, d.mid, 0);
    this.head = joint(this.chest, 0, d.neck, 0.012);

    const torso = d.torso, depth = (1 + torso) / 2;
    part(this.pelvis, geometry.pelvis, materials.pants, { scale: [torso * 0.96, d.k, depth * d.belly ** 0.3] });
    part(this.pelvis, geometry.belt, materials.belt, { scale: [torso * 0.96, d.k, depth * d.belly ** 0.3], detail: true });
    part(this.abdomen, geometry.abdomen, materials.cloth, { scale: [torso, d.k, depth * d.belly ** 0.5], color: jersey });
    part(this.chest, geometry.chest, materials.chest, { scale: [torso, d.k, depth], atlas: atlasOffset });
    part(this.chest, geometry.neck, materials.skin, { scale: [torso ** 0.5, 1, torso ** 0.5], color: look.skin });
    if (look.towel) part(this.pelvis, geometry.towel, materials.towel, { pos: [-0.1 * torso, 0.13 * d.k, 0.128 * depth], rot: [-0.12, 0.25, 0.04], detail: true });

    // Helmet and face. The shell is the same size on every player.
    const shell = [0, HELMET_CENTRE, 0], helmetScale = [1.05, 1.05, 1.05];
    part(this.head, geometry.helmet, materials.helmet, { pos: shell, scale: helmetScale });
    part(this.head, geometry.hardware, materials.hardware, { pos: shell, scale: helmetScale });
    part(this.head, geometry.face, materials.skin, { pos: [0, HELMET_CENTRE - 0.052, 0.022], scale: helmetScale, color: look.skin });
    part(this.head, geometry.strap, materials.strap, { pos: shell, scale: helmetScale, detail: true });
    if (look.visor) part(this.head, geometry.visor, materials.visor, { pos: shell, scale: helmetScale });

    this.thighs = []; this.shins = []; this.feet = [];
    this.uppers = []; this.forearms = []; this.hands = [];
    const limb = d.limb;
    SIDES.forEach((s, i) => {
      const thigh = joint(this.pelvis, s * d.hipX, 0, 0);
      const shin = joint(thigh, 0, -d.thigh, 0);
      const foot = joint(shin, 0, -d.shin, 0);
      part(thigh, geometry.thigh, materials.pants, { scale: [limb, d.k, limb] });
      part(shin, geometry.knee, materials.pants, { scale: [limb, d.k, limb] });
      part(shin, geometry.sock, materials.sock, { scale: [limb, d.k, limb] });
      part(foot, geometry.cleat, materials.cleat, { scale: [1, d.k, d.k], color: look.cleat });
      this.thighs.push(thigh); this.shins.push(shin); this.feet.push(foot);

      const upper = joint(this.chest, s * d.shoulder[0], d.shoulder[1], d.shoulder[2]);
      const fore = joint(upper, 0, -d.upperArm, 0);
      const hand = joint(fore, 0, -d.forearm, 0);
      part(upper, geometry.upperArm, materials.skin, { scale: [limb, d.k, limb], color: look.skin });
      part(upper, geometry.sleeve, materials.cloth, { scale: [limb ** 0.7, d.k, limb ** 0.7], color: jersey });
      part(fore, geometry.forearm, materials.skin, { scale: [limb, d.k, limb], color: look.skin });
      if (look.tape) part(fore, geometry.tape, materials.tape, { scale: [limb, d.k, limb], detail: true });
      part(hand, i === 0 ? geometry.gloveL : geometry.gloveR, materials.glove, { scale: [limb ** 0.5, d.k, limb ** 0.5], color: look.glove });
      this.uppers.push(upper); this.forearms.push(fore); this.hands.push(hand);
    });

    // Resolved joint positions in world space, refreshed after every apply().
    this.world = {
      pelvis: new THREE.Vector3(), chest: new THREE.Vector3(), head: new THREE.Vector3(),
      hands: [new THREE.Vector3(), new THREE.Vector3()], elbows: [new THREE.Vector3(), new THREE.Vector3()],
      feet: [new THREE.Vector3(), new THREE.Vector3()],
    };
    this.chestQuat = new THREE.Quaternion();
  }

  // Poses the joint tree for a body at simulation (x, z) facing `yaw` (scene
  // radians), then refreshes world matrices for the whole tree.
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

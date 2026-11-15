import * as THREE from '../../vendor/three.module.js';
import { Squad, Rig, createGeometries } from './rig.js';
import { Pose, armAngles } from './pose.js';
import { HAND, setHand } from './hands.js';
import { skinVertex } from './skin.js';

// People who are not players: the coaches and staff on the sideline. They are
// the athletes' own body (the same skeleton, limbs, hands and face, at the
// reduced level of detail), dressed in a polo shirt, trousers and a cap
// instead of pads and a helmet, put in a pose and frozen: each pose is baked
// once into plain geometry, one piece per material, for the static scenery.

// Each kind of surface is baked in a marker colour and sorted out afterwards.
const KIND = { shirt: '#ff0000', trousers: '#00ff00', skin: '#0000ff', shoes: '#ffff00' };
const STAFF_LOOK = { staff: true, skin: KIND.skin, glove: KIND.skin, cleat: KIND.shoes, dress: KIND };

const _c = new THREE.Vector3(), _hand = new THREE.Vector3(), _pole = new THREE.Vector3();

// Poses, standing. Hand targets are in the chest frame (x to his left, z ahead).
const POSES = {
  // Weight on one leg, arms hanging.
  atEase(pose, d) {
    pose.pelvis.x = 0.025; pose.hips.z = 0.05; pose.spine.z = -0.04;
    armAngles(pose, 0, d, 0.1, 0.3, 0.1); armAngles(pose, 1, d, 0.04, 0.22, 0.12);
    pose.head.y = 0.25;
  },
  // Hands on the hips, elbows out.
  handsOnHips(pose, d) {
    for (let i = 0; i < 2; i++) {
      const s = i ? -1 : 1;
      pose.hands[i].set(s * 0.2 * d.torso, -0.33 * d.k, 0.03);
      pose.elbows[i].set(s, -0.1, -0.5);
      pose.wrists[i].set(0.5, 0, -0.5);
      setHand(pose, i, HAND.CARRY, 0.6);
    }
    pose.spine.x = -0.03; pose.head.y = -0.2;
  },
  // Arms folded across the chest.
  armsCrossed(pose, d) {
    pose.hands[0].set(-0.1, -0.08 * d.k, 0.165); pose.hands[1].set(0.11, -0.11 * d.k, 0.15);
    pose.elbows[0].set(1, -0.9, 0.1); pose.elbows[1].set(-1, -0.9, 0.1);
    pose.wrists[0].set(0.2, 0, 0.4); pose.wrists[1].set(0.2, 0, -0.4);
    setHand(pose, 0, HAND.CARRY, 0.5); setHand(pose, 1, HAND.CARRY, 0.5);
    pose.spine.x = -0.05; pose.pelvis.x = -0.02; pose.hips.z = -0.04;
  },
  // Reading a play sheet held in the left hand.
  clipboard(pose, d) {
    pose.hands[0].set(0.1, -0.1 * d.k, 0.25); pose.elbows[0].set(0.9, -1, -0.2); pose.wrists[0].set(-0.2, 0, -0.9);
    setHand(pose, 0, HAND.CARRY, 0.7);
    armAngles(pose, 1, d, 0.05, 0.25, 0.1);
    pose.head.x = 0.35; pose.spine.x = 0.06;
  },
};
export const FIGURE_POSES = Object.keys(POSES);

function capGeometry() {
  // A crown over the top of the head and a bill out in front, in the head's frame.
  const crown = new THREE.SphereGeometry(1, 14, 7, 0, Math.PI * 2, 0, Math.PI * 0.56);
  crown.scale(0.092, 0.075, 0.103); crown.translate(0, 0.142, -0.004);
  const bill = new THREE.BoxGeometry(0.15, 0.012, 0.1, 4, 1, 3), p = bill.attributes.position;
  for (let i = 0; i < p.count; i++) { const x = p.getX(i), z = p.getZ(i); p.setZ(i, z - 2.6 * x * x * (z > 0 ? 1 : 0)); p.setY(i, p.getY(i) - 0.5 * x * x - 0.12 * Math.max(0, z)); }
  bill.translate(0, 0.143, 0.125);
  return [crown, bill];
}

const baked = new Map();

// One person in `pose` (a FIGURE_POSES name), standing at the origin and
// facing +Z, feet on the ground: { shirt, trousers, skin, shoes, cap, dark,
// white, sheet }, each a geometry (position, normal) or null. `dark` and
// `white` are his brows, eyes and mouth; `sheet` the play sheet he reads.
// Baked once per pose and shared.
export function bakeFigure(pose = 'atEase') {
  if (baked.has(pose)) return baked.get(pose);
  const materials = { body: new THREE.MeshBasicMaterial(), helmet: new THREE.MeshBasicMaterial() };
  const squad = new Squad(new THREE.Scene(), 1, materials, { lod: false });
  // The reduced body with the full face: a bare head is looked at.
  const low = createGeometries({ low: true }), full = createGeometries();
  const rig = new Rig(squad, { id: 'staff-' + pose, role: 'staff', team: 'offense', number: 0, look: STAFF_LOOK }, 0, { ...low, face: full.face, faceDetails: full.faceDetails }, { offset: [0, 0], scale: [1, 1], white: [0.5, 0.5] });
  squad.finish();

  const p = new Pose(), d = rig.dims;
  p.pelvis.set(0, d.hipY - 0.006, 0);
  p.feet[0].set(0.13, d.ankle, 0.01); p.feet[1].set(-0.13, d.ankle, -0.02);
  p.footRot[0].y = 0.2; p.footRot[1].y = -0.2;
  (POSES[pose] || POSES.atEase)(p, d);
  rig.apply(p, 0, 0, 0);

  // Skin every vertex where the pose puts it and sort the triangles by kind.
  const g = squad.meshes.body.geometry, colour = g.attributes.color, kinds = { shirt: [], trousers: [], skin: [], shoes: [], dark: [], white: [] };
  const kindOf = v => {
    const r = colour.getX(v), gr = colour.getY(v), b = colour.getZ(v), top = Math.max(r, gr, b);
    if (top <= 0) return 'dark';
    if (b / top > 0.9 && r / top < 0.1 && gr / top < 0.1) return 'skin';
    if (r / top > 0.9 && gr / top > 0.9 && b / top < 0.1) return 'shoes';
    if (r / top > 0.9 && gr / top < 0.1) return 'shirt';
    if (gr / top > 0.9 && r / top < 0.1) return 'trousers';
    return top > 0.3 ? 'white' : 'dark';
  };
  for (let i = 0; i < g.index.count; i += 3) {
    const tri = [g.index.getX(i), g.index.getX(i + 1), g.index.getX(i + 2)], list = kinds[kindOf(tri[0])];
    for (const v of tri) { skinVertex(g, squad.bones.data, v, _c); list.push(_c.x, _c.y, _c.z); }
  }
  const out = {};
  for (const [kind, positions] of Object.entries(kinds)) {
    if (!positions.length) { out[kind] = null; continue; }
    const piece = new THREE.BufferGeometry();
    piece.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    // Shared corners are welded so each surface shades smoothly.
    out[kind] = weld(piece);
  }
  const head = rig.head.matrixWorld;
  out.cap = merge(capGeometry().map(part => part.applyMatrix4(head)));
  if (pose === 'clipboard') {
    const sheet = new THREE.BoxGeometry(0.2, 0.012, 0.27);
    _hand.copy(rig.world.palms[0]).addScaledVector(rig.world.palmNormals[0], 0.02);
    sheet.applyMatrix4(new THREE.Matrix4().compose(_hand.add(_pole.set(0.02, 0.03, 0.02)), new THREE.Quaternion().setFromEuler(new THREE.Euler(0.75, 0.25, 0)), new THREE.Vector3(1, 1, 1)));
    out.sheet = sheet;
  } else out.sheet = null;

  for (const x of [...Object.values(low), ...Object.values(full)]) x.dispose();
  for (const m of Object.values(squad.meshes)) m.geometry.dispose();
  squad.bones.texture.dispose(); materials.body.dispose(); materials.helmet.dispose();
  baked.set(pose, out);
  return out;
}

// Indexed copy of a triangle soup with coincident vertices merged, and smooth normals.
function weld(geometry) {
  const p = geometry.attributes.position, index = [], positions = [], seen = new Map();
  for (let i = 0; i < p.count; i++) {
    const key = Math.round(p.getX(i) * 2e4) + ',' + Math.round(p.getY(i) * 2e4) + ',' + Math.round(p.getZ(i) * 2e4);
    let at = seen.get(key);
    if (at === undefined) { at = positions.length / 3; seen.set(key, at); positions.push(p.getX(i), p.getY(i), p.getZ(i)); }
    index.push(at);
  }
  geometry.dispose();
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  out.setIndex(index);
  out.computeVertexNormals();
  return out;
}

function merge(parts) {
  const positions = [], index = [];
  for (const part of parts) {
    const base = positions.length / 3, p = part.attributes.position;
    for (let i = 0; i < p.count; i++) positions.push(p.getX(i), p.getY(i), p.getZ(i));
    for (let i = 0; i < part.index.count; i++) index.push(base + part.index.getX(i));
    part.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  out.setIndex(index);
  out.computeVertexNormals();
  return out;
}

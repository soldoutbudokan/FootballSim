// Loading a character file and describing its rig: skinned meshes, bones
// mapped to canonical names, and the "character space" every other module
// works in: feet on y = 0, facing +z, left at +x, 2.06 yards tall (yards).
import * as THREE from '../../vendor/three.module.js';
import { GLTFLoader } from '../../vendor/GLTFLoader.js';
import { FBXLoader } from '../../vendor/FBXLoader.js';
import { mapSkeleton, CANONICAL_BONES } from './bones.js';

export const STANDARD_HEIGHT = 2.06; // yards: a 6 ft 2 in athlete

const extension = url => String(url).split(/[?#]/)[0].split('.').pop().toLowerCase();

// Loads a .glb/.gltf or .fbx file -> {scene, animations, url}.
export async function loadCharacterFile(url, manager) {
  if (extension(url) === 'fbx') {
    const group = await new FBXLoader(manager).loadAsync(url);
    mergeDuplicateBones(group);
    return { scene: group, animations: group.animations || [], url };
  }
  const gltf = await new GLTFLoader(manager).loadAsync(url);
  return { scene: gltf.scene || gltf.scenes[0], animations: gltf.animations || [], url };
}

// FBXLoader gives a bone shared by several skinned meshes one copy per mesh,
// each copy nested (with an identity transform) under the next. Mixamo
// characters have two meshes (surface and joints), so every joint would be
// two nodes and only the outer one is animated. Bind every mesh to the
// outermost copy and drop the rest, so each joint is a single node. The bind
// matrices stay valid: the copies always share their world transform.
export function mergeDuplicateBones(root) {
  const isCopy = b => b.isBone && b.parent?.isBone && b.parent.name === b.name;
  const outerOf = b => { let o = b; while (isCopy(o)) o = o.parent; return o; };
  const copies = [];
  root.traverse(o => { if (isCopy(o)) copies.push(o); });
  if (!copies.length) return 0;
  root.traverse(o => { if (o.isSkinnedMesh) o.skeleton.bones = o.skeleton.bones.map(outerOf); });
  for (const copy of copies) {
    const outer = outerOf(copy);
    for (const child of [...copy.children]) if (!isCopy(child)) outer.add(child);
  }
  for (const copy of copies) copy.removeFromParent();
  root.updateMatrixWorld(true);
  return copies.length;
}

// Bones of a loaded scene and their canonical mapping.
export function describeRig(scene) {
  scene.updateMatrixWorld(true);
  const meshes = [];
  const boneSet = new Set();
  scene.traverse(o => {
    if (o.isSkinnedMesh) { meshes.push(o); o.skeleton.bones.forEach(b => boneSet.add(b)); }
    if (o.isBone) boneSet.add(o);
  });
  // Animation-only FBX files may have no Bone objects: use every node.
  let bones = [...boneSet];
  if (!bones.length) scene.traverse(o => { if (o !== scene) bones.push(o); });
  bones = orderByDepth(bones);
  const index = new Map(bones.map((b, i) => [b, i]));
  const list = bones.map(b => ({ name: b.name, parent: nearestIndexedAncestor(b, index) }));
  const mapping = mapSkeleton(list);
  const byName = new Map(bones.map(b => [b.name, b]));
  const canon = {};
  for (const [c, name] of Object.entries(mapping.map)) canon[c] = byName.get(name);
  return { scene, meshes, bones, mapping, canon, byName };
}

function orderByDepth(nodes) {
  const depth = n => { let d = 0; for (let p = n.parent; p; p = p.parent) d++; return d; };
  return nodes.map(n => [depth(n), n]).sort((a, b) => a[0] - b[0]).map(e => e[1]);
}

function nearestIndexedAncestor(node, index) {
  for (let p = node.parent; p; p = p.parent) if (index.has(p)) return index.get(p);
  return -1;
}

// Rotation (world -> character space) from the rig's rest pose: up from the
// hips to the head, left from the right hip to the left hip, both snapped to
// the nearest world axis because rigs are authored axis-aligned.
export function restOrientation(rig) {
  const P = name => rig.canon[name].getWorldPosition(new THREE.Vector3());
  const up = snapAxis(P('Head').sub(P('Hips')).normalize());
  const left = P('LeftUpLeg').sub(P('RightUpLeg'));
  left.addScaledVector(up, -left.dot(up)).normalize();
  const leftAxis = snapAxis(left);
  const forward = new THREE.Vector3().crossVectors(leftAxis, up).normalize();
  const basis = new THREE.Matrix4().makeBasis(leftAxis, up, forward); // character -> world
  return new THREE.Quaternion().setFromRotationMatrix(basis).invert();
}

function snapAxis(v) {
  const a = [Math.abs(v.x), Math.abs(v.y), Math.abs(v.z)];
  const i = a.indexOf(Math.max(...a));
  if (a[i] < 0.8) return v.clone().normalize();
  const out = new THREE.Vector3();
  out.setComponent(i, Math.sign(v.getComponent(i)));
  return out;
}

// Rest-pose vertex positions of every skinned mesh in world space (posed by
// the bones, so a model whose nodes are not at the bind pose still measures
// what is drawn).
export function restVertices(rig) {
  const out = new Map();
  const v = new THREE.Vector3();
  for (const mesh of rig.meshes) {
    const count = mesh.geometry.attributes.position.count;
    const data = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      mesh.getVertexPosition(i, v).applyMatrix4(mesh.matrixWorld);
      data[i * 3] = v.x; data[i * 3 + 1] = v.y; data[i * 3 + 2] = v.z;
    }
    out.set(mesh, data);
  }
  return out;
}

// Wraps the scene in a "fit" group that maps it into character space.
// A model (with skinned vertices) is scaled to `heightTarget` from the soles
// to the top of the head. A clip source without a mesh is scaled so its legs
// match the target's: `legs` = {height: hips above the lowest ankle, ankle:
// that ankle's height above the ground}, both in the target's character space.
// Returns {fit, scale}.
export function normalise(rig, { heightTarget = STANDARD_HEIGHT, vertices = null, legs = null } = {}) {
  const q = restOrientation(rig);
  const fit = new THREE.Group();
  fit.name = 'character-fit';
  if (rig.scene.parent) rig.scene.parent.remove(rig.scene);
  fit.add(rig.scene);
  fit.quaternion.copy(q);
  fit.updateMatrixWorld(true);

  const hips = rig.canon.Hips.getWorldPosition(new THREE.Vector3());
  let scale, ground;
  if (vertices && vertices.size && !legs) {
    let minY = Infinity, maxY = -Infinity;
    const v = new THREE.Vector3();
    for (const data of vertices.values()) {
      for (let i = 0; i < data.length; i += 3) {
        v.set(data[i], data[i + 1], data[i + 2]).applyQuaternion(q);
        if (v.y < minY) minY = v.y;
        if (v.y > maxY) maxY = v.y;
      }
    }
    scale = heightTarget / Math.max(1e-6, maxY - minY);
    ground = minY;
  } else {
    const ankle = lowestAnkle(rig);
    scale = (legs?.height || 1) / Math.max(1e-6, hips.y - ankle);
    ground = ankle - (legs?.ankle || 0) / scale;
  }
  fit.scale.setScalar(scale);
  fit.position.set(-hips.x * scale, -ground * scale, -hips.z * scale);
  fit.updateMatrixWorld(true);
  return { fit, scale };
}

// World height of the lowest foot joint.
export function lowestAnkle(rig) {
  const ys = ['LeftFoot', 'RightFoot'].filter(n => rig.canon[n]).map(n => rig.canon[n].getWorldPosition(new THREE.Vector3()).y);
  return ys.length ? Math.min(...ys) : 0;
}

// Leg metrics of a normalised rig (character space): see normalise().
export function legMetrics(rig) {
  const hips = rig.canon.Hips.getWorldPosition(new THREE.Vector3()).y;
  const ankle = lowestAnkle(rig);
  return { height: hips - ankle, ankle };
}

// Canonical joint positions in the current world space.
export function jointPositions(rig) {
  const out = {};
  for (const c of CANONICAL_BONES) if (rig.canon[c]) out[c] = rig.canon[c].getWorldPosition(new THREE.Vector3());
  return out;
}

// Snapshot / restore of every bone's local transform (the rest pose).
export function captureRest(bones) {
  return bones.map(b => ({ bone: b, p: b.position.clone(), q: b.quaternion.clone(), s: b.scale.clone() }));
}
export function applyRest(rest) {
  for (const r of rest) { r.bone.position.copy(r.p); r.bone.quaternion.copy(r.q); r.bone.scale.copy(r.s); }
}

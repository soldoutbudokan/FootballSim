// Turns animation clips from any source onto the player model's skeleton.
//
// Same naming and compatible rest pose (any Mixamo character, or clips that
// came with the model): tracks are renamed, and only the hips tracks are
// converted between the two rigs' hip parent frames.
// Anything else: SkeletonUtils.retargetClip with the canonical bone-name map
// and per-bone rest offsets, so the source's motion RELATIVE TO ITS REST POSE
// is applied to the target's rest pose (works across bone-axis conventions
// and T/A-pose differences).
// Either way only bone rotations and the hips position survive: per-bone
// translations (which would change the model's proportions), scales and
// morph tracks are dropped, and root motion is removed because the
// simulation owns position.
import * as THREE from '../../vendor/three.module.js';
import * as SkeletonUtils from '../../vendor/SkeletonUtils.js';
import { CANONICAL_BONES, CANONICAL_PARENT, retargetNames, renameMap } from './bones.js';
import { captureRest, applyRest } from './rig.js';

const CHILD = {};
for (const [child, parent] of Object.entries(CANONICAL_PARENT)) (CHILD[parent] ||= []).push(child);

// Splits "mixamorigHips.quaternion" / ".bones[Hips].quaternion" -> {node, property}.
export function parseTrackName(name) {
  const bones = /^\.bones\[([^\]]+)\]\.(\w+)/.exec(name);
  if (bones) return { node: bones[1], property: bones[2] };
  const dot = name.lastIndexOf('.');
  return { node: name.slice(0, dot), property: name.slice(dot + 1) };
}

// Character-space (world, with the fit at the origin) matrix of a node's parent.
function parentMatrix(node) {
  node.parent.updateWorldMatrix(true, false);
  return node.parent.matrixWorld.clone();
}

// Keeps rotation tracks of known bones and the hips position.
function cleanTracks(clip, rig) {
  const hips = rig.canon.Hips.name;
  const tracks = [];
  for (const track of clip.tracks) {
    const { node, property } = parseTrackName(track.name);
    if (!rig.byName.has(node)) continue;
    if (property === 'quaternion' || (property === 'position' && node === hips)) tracks.push(track.clone());
  }
  return new THREE.AnimationClip(clip.name, clip.duration, tracks);
}

// Angle (radians) between two quaternions.
const angle = (a, b) => 2 * Math.acos(Math.min(1, Math.abs(a.dot(b))));

// Direction from a canonical bone to its first mapped child, character space.
function boneDirection(rig, canonical) {
  const bone = rig.canon[canonical];
  const child = (CHILD[canonical] || []).map(c => rig.canon[c]).find(Boolean);
  if (!bone || !child) return null;
  const a = bone.getWorldPosition(new THREE.Vector3()), b = child.getWorldPosition(new THREE.Vector3());
  return b.sub(a).normalize();
}

// Rename is safe when every shared bone has the same rest rotation and
// points the same way (both rigs in T-pose, same axis conventions).
export function compatibleRigs(target, source) {
  for (const c of CANONICAL_BONES) {
    if (c === 'Hips') continue;
    const t = target.canon[c], s = source.canon[c];
    if (!t || !s) continue;
    if (angle(t.quaternion, s.quaternion) > THREE.MathUtils.degToRad(12)) return false;
    const dt = boneDirection(target, c), ds = boneDirection(source, c);
    if (dt && ds && dt.angleTo(ds) > THREE.MathUtils.degToRad(20)) return false;
  }
  return true;
}

// Rename path: track names follow the target; hips tracks are re-expressed
// in the target's hip parent frame.
function renameClip(clip, target, source) {
  const names = renameMap(target.bones.map(b => b.name), source.bones.map(b => b.name), target.mapping.map, source.mapping.map);
  const K = parentMatrix(target.canon.Hips).invert().multiply(parentMatrix(source.canon.Hips));
  const A = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().extractRotation(K));
  const sourceHips = source.canon.Hips.name, targetHips = target.canon.Hips.name;
  const tracks = [];
  for (const track of clip.tracks) {
    const { node, property } = parseTrackName(track.name);
    const to = names[node];
    if (!to) continue;
    const out = track.clone();
    out.name = to + '.' + property;
    if (node === sourceHips && to === targetHips) convertHips(out, property, K, A);
    tracks.push(out);
  }
  return new THREE.AnimationClip(clip.name, clip.duration, tracks);
}

function convertHips(track, property, K, A) {
  const v = track.values;
  if (property === 'position') {
    const p = new THREE.Vector3();
    for (let i = 0; i < v.length; i += 3) { p.fromArray(v, i).applyMatrix4(K).toArray(v, i); }
  } else if (property === 'quaternion') {
    const q = new THREE.Quaternion();
    for (let i = 0; i < v.length; i += 4) { q.fromArray(v, i).premultiply(A).toArray(v, i); }
  }
}

// Retarget path via SkeletonUtils.retargetClip. Both rigs must be normalised
// fits at the world origin (world == character space) and at rest.
function retargetClipTo(clip, target, source, fps = 30) {
  const targetRest = captureRest(target.bones);
  const sourceRest = captureRest(source.bones);
  // A plain Object3D holding a fresh Skeleton makes retargetClip's pose()
  // restore exactly the current rest pose (its inverses are computed now).
  target.fitRoot.updateMatrixWorld(true);
  source.fitRoot.updateMatrixWorld(true);
  const targetHolder = new THREE.Object3D();
  targetHolder.skeleton = new THREE.Skeleton(target.bones);
  const sourceHolder = new THREE.Object3D();
  sourceHolder.skeleton = new THREE.Skeleton(source.bones);
  sourceHolder.add(source.fitRoot); // the mixer resolves tracks under the holder
  sourceHolder.updateMatrixWorld(true);

  const names = retargetNames(target.mapping.map, source.mapping.map);
  const localOffsets = {};
  const q = new THREE.Quaternion(), qs = new THREE.Quaternion(), qt = new THREE.Quaternion(), c = new THREE.Quaternion();
  for (const canonical of CANONICAL_BONES) {
    const t = target.canon[canonical], s = source.canon[canonical];
    if (!t || !s) continue;
    t.getWorldQuaternion(qt); s.getWorldQuaternion(qs);
    // Align the rest bone directions (T vs A pose) before taking the delta.
    const dt = boneDirection(target, canonical), ds = boneDirection(source, canonical);
    c.identity();
    if (dt && ds && !['Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'Head'].includes(canonical)) c.setFromUnitVectors(dt, ds);
    q.copy(qs).invert().multiply(c).multiply(qt);
    localOffsets[t.name] = new THREE.Matrix4().makeRotationFromQuaternion(q);
  }
  let result;
  try {
    result = SkeletonUtils.retargetClip(targetHolder, sourceHolder, clip, {
      names, hip: source.canon.Hips.name, localOffsets, fps, useFirstFramePosition: false,
    });
  } finally {
    sourceHolder.remove(source.fitRoot);
    applyRest(targetRest); applyRest(sourceRest);
    target.fitRoot.updateMatrixWorld(true); source.fitRoot.updateMatrixWorld(true);
  }
  // ".bones[Name].quaternion" -> "Name.quaternion" so a mixer rooted at the
  // player group binds by name.
  for (const track of result.tracks) {
    const { node, property } = parseTrackName(track.name);
    track.name = node + '.' + property;
  }
  return result;
}

// Removes horizontal hips drift (root motion) while keeping sway and bob.
export function stripRootMotion(clip, rig, restHipsPosition) {
  const hips = rig.canon.Hips;
  const track = clip.tracks.find(t => { const p = parseTrackName(t.name); return p.node === hips.name && p.property === 'position'; });
  if (!track) return clip;
  // Character up expressed in the hips' parent frame.
  const inv = parentMatrix(hips).invert();
  const up = new THREE.Vector3(0, 1, 0).transformDirection(inv);
  const v = track.values, n = v.length / 3, times = track.times;
  const T = times[n - 1] - times[0] || 1;
  const horiz = i => { const p = new THREE.Vector3().fromArray(v, i * 3); return p.addScaledVector(up, -p.dot(up)); };
  const first = horiz(0), last = horiz(n - 1);
  const rest = restHipsPosition.clone().addScaledVector(up, -restHipsPosition.dot(up));
  const p = new THREE.Vector3(), drift = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    p.fromArray(v, i * 3);
    const vertical = p.dot(up);
    const h = p.addScaledVector(up, -vertical);
    drift.lerpVectors(first, last, (times[i] - times[0]) / T);
    h.sub(drift).add(rest).addScaledVector(up, vertical);
    h.toArray(v, i * 3);
  }
  return clip;
}

// Keeps only tracks of bones in `names` (an upper-body mask).
export function maskClip(clip, names) {
  const keep = new Set(names);
  return new THREE.AnimationClip(clip.name + ':upper', clip.duration, clip.tracks.filter(t => keep.has(parseTrackName(t.name).node)));
}

// Converts one clip from `source` (a described, normalised rig with
// .fitRoot) onto `target`. `embedded` clips came with the target model.
export function convertClip(clip, target, source, { embedded = false } = {}) {
  if (embedded) return { clip: cleanTracks(clip, target), method: 'embedded' };
  const cleaned = cleanTracks(clip, source);
  if (compatibleRigs(target, source)) return { clip: renameClip(cleaned, target, source), method: 'rename' };
  return { clip: cleanTracks(retargetClipTo(cleaned, target, source), target), method: 'retarget' };
}

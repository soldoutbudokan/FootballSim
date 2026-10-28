import test from 'node:test';
import assert from 'node:assert/strict';

// Geometry tests use the same vendored renderer as the release, without WebGL.
const THREE = await import('../dist/vendor/three.module.js').catch(() => null);
const modelTest = (name, fn) => test(name, { skip: THREE ? false : 'run npm run check to vendor three.js' }, fn);
const model = THREE ? await import('../dist/js/athletes/rig.js') : {};
const poses = THREE ? await import('../dist/js/athletes/pose.js') : {};

modelTest('full and reduced athlete geometry has finite outward surfaces within the triangle budget', () => {
  const full = model.createGeometries(), low = model.createGeometries({ low: true });
  try {
    for (const geometries of [full, low]) {
      for (const [name, g] of Object.entries(geometries)) {
        for (const attribute of ['position', 'normal']) {
          assert.ok([...g.attributes[attribute].array].every(Number.isFinite), `${name} ${attribute}`);
        }
        assert.ok([...g.index.array].every(i => i < g.attributes.position.count), `${name} indices`);
      }
      for (const [name, sign] of [['stripeL', 1], ['stripeR', -1]]) {
        const g = geometries[name];
        for (let i = 0; i < g.attributes.normal.count; i++) assert.ok(sign * g.attributes.normal.getX(i) > 0.6, `${name} faces away from the leg`);
      }
    }
    const total = gs => Object.values(gs).reduce((n, g) => n + g.index.count / 3, 0);
    assert.ok(total(full) < 13000, `shared full-detail parts: ${total(full)} triangles`);
    assert.ok(total(low) < total(full) * 0.4, 'reduced geometry remains substantially cheaper');
  } finally { for (const g of [...Object.values(full), ...Object.values(low)]) g.dispose(); }
});

modelTest('all body types keep both skinning levels stable through a deep crouch and raised arms', () => {
  const specs = Object.keys(model.BODY_TYPES).map((role, i) => ({ id: `${role}${i}`, role, number: i + 10, team: i % 2 ? 'defense' : 'offense' }));
  const scene = new THREE.Scene(), materials = { body: new THREE.MeshStandardMaterial(), helmet: new THREE.MeshStandardMaterial() };
  const squad = new model.Squad(scene, specs.length, materials), full = model.createGeometries(), low = model.createGeometries({ low: true });
  const atlas = { offset: [0, 0], scale: [1, 1], white: [0.5, 0.5] };
  const rigs = specs.map((spec, i) => new model.Rig(squad, spec, i, full, atlas, low));
  squad.finish();
  const vertex = new THREE.Vector3(), other = new THREE.Vector3(), a = new THREE.Matrix4(), b = new THREE.Matrix4();
  try {
    for (const crouch of [false, true]) {
      rigs.forEach(rig => {
        const pose = new poses.Pose(), d = rig.dims;
        pose.pelvis.set(0, d.hipY * (crouch ? 0.68 : 0.96), 0);
        pose.feet[0].set(0.24, d.ankle, 0.08); pose.feet[1].set(-0.24, d.ankle, -0.08);
        pose.hips.x = crouch ? 0.8 : 0.05; pose.spine.x = crouch ? 0.45 : 0;
        poses.armAngles(pose, 0, d, crouch ? 1.1 : 2.5, 0.4, 0.3);
        poses.armAngles(pose, 1, d, crouch ? 1.0 : 2.5, 0.4, 0.3);
        rig.apply(pose, 0, 0, 0);
      });
      squad.commit();
      for (const mesh of Object.values(squad.meshes)) {
        const g = mesh.geometry, p = g.attributes.position, bones = g.attributes.athBones, mix = g.attributes.athMix;
        for (let i = 0; i < p.count; i++) {
          a.fromArray(squad.bones.data, bones.getX(i) * 16); b.fromArray(squad.bones.data, bones.getY(i) * 16);
          vertex.fromBufferAttribute(p, i).applyMatrix4(a).multiplyScalar(mix.getX(i));
          other.fromBufferAttribute(p, i).applyMatrix4(b).multiplyScalar(1 - mix.getX(i)); vertex.add(other);
          assert.ok(Number.isFinite(vertex.length()) && vertex.length() < 3.2, `${mesh.name} has no exploded vertices`);
          assert.ok(vertex.y > -0.15, `${mesh.name} stays above the floor in an upright/crouched pose`);
        }
      }
    }
  } finally {
    for (const g of [...Object.values(full), ...Object.values(low)]) g.dispose();
    for (const m of Object.values(squad.meshes)) m.geometry.dispose();
    squad.bones.texture.dispose(); materials.body.dispose(); materials.helmet.dispose();
  }
});

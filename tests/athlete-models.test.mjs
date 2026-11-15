import test from 'node:test';
import assert from 'node:assert/strict';

// Geometry tests use the same vendored renderer as the release, without WebGL.
const THREE = await import('../dist/vendor/three.module.js').catch(() => null);
const modelTest = (name, fn) => test(name, { skip: THREE ? false : 'run npm run check to vendor three.js' }, fn);
const model = THREE ? await import('../dist/js/athletes/rig.js') : {};
const poses = THREE ? await import('../dist/js/athletes/pose.js') : {};
const uniform = THREE ? await import('../dist/js/athletes/uniform.js') : {};
const shapes = THREE ? await import('../dist/js/athletes/geometry.js') : {};
const skin = THREE ? await import('../dist/js/athletes/skin.js') : {};
const folds = THREE ? await import('../dist/js/athletes/folds.js') : {};

// Share of a geometry's triangles whose winding agrees with their vertex
// normals: an inside-out part (a mirrored limb with the wrong winding, a
// flipped cap) drags it down.
function outwardShare(g, first = 0, count = g.index.count) {
  const p = g.attributes.position, n = g.attributes.normal, a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), m = new THREE.Vector3();
  let good = 0, all = 0;
  for (let i = first; i < first + count; i += 3) {
    const [ia, ib, ic] = [g.index.getX(i), g.index.getX(i + 1), g.index.getX(i + 2)];
    a.fromBufferAttribute(p, ia); b.fromBufferAttribute(p, ib).sub(a); c.fromBufferAttribute(p, ic).sub(a);
    const face = b.cross(c);
    if (face.lengthSq() < 1e-14) continue;
    m.fromBufferAttribute(n, ia).add(a.fromBufferAttribute(n, ib)).add(a.fromBufferAttribute(n, ic));
    all++; if (face.dot(m) > 0) good++;
  }
  return good / all;
}

modelTest('full and reduced athlete geometry has finite outward surfaces within the triangle budget', () => {
  const full = model.createGeometries(), low = model.createGeometries({ low: true });
  try {
    for (const geometries of [full, low]) {
      for (const [name, g] of Object.entries(geometries)) {
        for (const attribute of ['position', 'normal']) {
          assert.ok([...g.attributes[attribute].array].every(Number.isFinite), `${name} ${attribute}`);
        }
        assert.ok([...g.index.array].every(i => i < g.attributes.position.count), `${name} indices`);
        // The visor is a single open sheet; everything else is a closed or capped form.
        if (name !== 'visor') assert.ok(outwardShare(g) > 0.97, `${name} faces outwards (${outwardShare(g).toFixed(3)})`);
      }
    }
    const total = gs => Object.values(gs).reduce((n, g) => n + g.index.count / 3, 0);
    assert.ok(total(full) < 13500, `shared full-detail parts: ${total(full)} triangles`);
    assert.ok(total(low) < total(full) * 0.4, 'reduced geometry remains substantially cheaper');
    // One athlete: the limbs count twice, one of the two facemasks is worn,
    // and the reduced level has none of the small detail parts.
    // (The reduced hand is a mitten: it has no separate digits.)
    const tris = (gs, names) => names.reduce((n, k) => n + (gs[k] ? gs[k].index.count / 3 : 0), 0);
    const limbs = ['pants', 'sock', 'cleat', 'upperArm', 'sleeve', 'forearm', 'glove', 'digit0', 'digit1', 'digit2', 'digit3', 'digit4'], small = ['belt', 'collar', 'tape', 'band', 'backPlate', 'studs', 'strap', 'faceDetails', 'towel'];
    const worn = total(full) + tris(full, limbs) + tris(full, ['studs', 'tape', 'band']) - tris(full, ['hardware']);
    const wornLow = total(low) + tris(low, limbs) - tris(low, ['hardware']) - tris(low, small);
    // Jointed fingers, one-piece pants, a face and rounder limbs and torso took
    // the full level from 13,600 to about 17,000; the reduced level is as it was.
    assert.ok(worn < 17500 && wornLow < 3200, `triangles per athlete: ${worn} full, ${wornLow} reduced`);
  } finally { for (const g of [...Object.values(full), ...Object.values(low)]) g.dispose(); }
});

modelTest('the helmet shell covers the ears and jaw and leaves the face open', () => {
  const g = shapes.helmetShell(), p = g.attributes.position;
  let side = 0, front = 0, back = 0;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    if (Math.abs(z) < 0.03 && Math.abs(x) > 0.08) side = Math.min(side, y);
    if (Math.abs(x) < 0.03 && z > 0.1) front = Math.min(front, y);
    if (Math.abs(x) < 0.03 && z < -0.1) back = Math.min(back, y);
  }
  assert.ok(side < -0.1, `cheek flaps reach the jaw (${side.toFixed(3)})`);
  assert.ok(front > -0.01, `the face opening starts at the brow (${front.toFixed(3)})`);
  assert.ok(back < -0.05 && back > side, `the back edge sits over the neck (${back.toFixed(3)})`);
  g.dispose();
});

modelTest('all body types keep both skinning levels stable through a deep crouch and raised arms', () => {
  const specs = Object.keys(model.BODY_TYPES).map((role, i) => ({ id: `${role}${i}`, role, number: i + 10, team: i % 2 ? 'defense' : 'offense' }));
  const scene = new THREE.Scene(), materials = { body: new THREE.MeshStandardMaterial(), helmet: new THREE.MeshStandardMaterial() };
  const squad = new model.Squad(scene, specs.length, materials), full = model.createGeometries(), low = model.createGeometries({ low: true });
  const atlas = { offset: [0, 0], scale: [1, 1], white: [0.5, 0.5] };
  const rigs = specs.map((spec, i) => new model.Rig(squad, spec, i, full, atlas, low));
  squad.finish();
  const vertex = new THREE.Vector3();
  try {
    // Mirrored right-hand limbs are baked with their faces outwards, and
    // every vertex has a detail layer and a surface.
    for (const mesh of Object.values(squad.meshes)) {
      const g = mesh.geometry;
      assert.ok(outwardShare(g) > 0.97, `${mesh.name} faces outwards (${outwardShare(g).toFixed(3)})`);
      assert.equal(g.attributes.athDetail.count, g.attributes.position.count);
      assert.equal(g.attributes.athSurface.itemSize, 3);
      assert.ok([...g.attributes.athDetail.array].every(Number.isFinite), `${mesh.name} detail`);
    }
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
        const g = mesh.geometry, p = g.attributes.position;
        for (let i = 0; i < p.count; i++) {
          skin.skinVertex(g, squad.bones.data, i, vertex);
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

modelTest('the standing athlete keeps its build: wide padded shoulders, a waist, feet on the ground', () => {
  const specs = [{ id: 'wr', role: 'wr', number: 81, team: 'offense' }, { id: 'ol', role: 'ol', number: 65, team: 'offense' }];
  const materials = { body: new THREE.MeshStandardMaterial(), helmet: new THREE.MeshStandardMaterial() };
  const squad = new model.Squad(new THREE.Scene(), specs.length, materials, { lod: false }), full = model.createGeometries();
  const rigs = specs.map((spec, i) => new model.Rig(squad, spec, i, full, { offset: [0, 0], scale: [1, 1], white: [0.5, 0.5] }));
  squad.finish();
  try {
    // Bind pose: standing straight with the arms hanging. Half widths by height.
    const g = squad.meshes.body.geometry, p = g.attributes.position;
    const widths = rigs.map((rig, owner) => {
      const { base: [start, count] } = g.userData.ranges[owner], d = rig.dims, band = { shoulders: 0, waist: 0, hips: 0, floor: Infinity };
      for (let i = start; i < start + count; i++) {
        const v = g.index.getX(i), x = Math.abs(p.getX(v)), y = p.getY(v);
        band.floor = Math.min(band.floor, y);
        if (Math.abs(y - (d.hipY + d.waist + d.mid + d.shoulder[1])) < 0.04) band.shoulders = Math.max(band.shoulders, x);
        if (Math.abs(y - (d.hipY + d.waist + 0.1)) < 0.03) band.waist = Math.max(band.waist, x);
        if (Math.abs(y - d.hipY) < 0.03) band.hips = Math.max(band.hips, x);
      }
      return band;
    });
    for (const [i, w] of widths.entries()) {
      assert.ok(w.shoulders > w.hips * 1.25, `${specs[i].id}: shoulder pads wider than the hips (${w.shoulders.toFixed(3)} vs ${w.hips.toFixed(3)})`);
      assert.ok(w.floor > -0.012 && w.floor < 0.02, `${specs[i].id}: the cleats stand on the turf (${w.floor.toFixed(3)})`);
    }
    assert.ok(widths[1].shoulders > widths[0].shoulders * 1.15 && widths[1].hips > widths[0].hips * 1.12, 'the lineman is the broader man');
  } finally {
    for (const g of Object.values(full)) g.dispose();
    for (const m of Object.values(squad.meshes)) m.geometry.dispose();
    squad.bones.texture.dispose(); materials.body.dispose(); materials.helmet.dispose();
  }
});

modelTest('jersey numerals are closed block shapes inside their cell, and atlas regions do not overlap', () => {
  // A recording context: every path the numerals trace, in glyph units.
  for (let n = 0; n < 100; n += n < 10 ? 1 : 11) {
    const points = [];
    let closed = 0, moves = 0;
    const ctx = new Proxy({}, {
      get: (t, k) => (k === 'moveTo' ? (x, y) => { moves++; points.push([x, y]); } : k === 'lineTo' ? (x, y) => points.push([x, y]) : k === 'closePath' ? () => closed++ : () => {}),
      set: () => true,
    });
    uniform.drawNumber(ctx, n, 0, 0, 14, '#fff');
    const digits = String(n).length;
    assert.ok(moves >= digits && closed === moves, `${n}: every outline is closed`);
    const width = digits * 10 + (digits - 1) * 2.3;
    for (const [x, y] of points) assert.ok(x >= -1e-9 && x <= width + 1e-9 && y >= -1e-9 && y <= 14 + 1e-9, `${n}: (${x}, ${y}) inside the cell`);
  }
  const own = ['torso', 'sleeveL', 'sleeveR'], shared = ['white', 'leg', 'hips', 'sock'];
  for (const group of [own, shared]) {
    for (const a of group) {
      const [ax, ay, aw, ah] = uniform.REGIONS[a];
      assert.ok(ax >= 0 && ay >= 0 && ax + aw <= 1 && ay + ah <= 1, `${a} inside the cell`);
      for (const b of group) {
        if (a >= b) continue;
        const [bx, by, bw, bh] = uniform.REGIONS[b];
        assert.ok(ax + aw <= bx || bx + bw <= ax || ay + ah <= by || by + bh <= ay, `${a} and ${b} are separate`);
      }
    }
  }
});

modelTest('fabric detail layers are tiling, neutral on average and one per kind of surface', () => {
  const t = uniform.detailTexture(), { data, width, height, depth } = t.image;
  assert.equal(depth, Object.keys(uniform.GRAIN).length);
  assert.equal(uniform.GRAIN_TILE.length, depth);
  for (let layer = 0; layer < depth; layer++) {
    const sum = [0, 0, 0, 0], o = layer * width * height * 4;
    for (let i = 0; i < width * height * 4; i++) sum[i % 4] += data[o + i];
    // Normals average to straight up, so a distant (mip-mapped) cloth is flat.
    for (const c of [0, 1]) assert.ok(Math.abs(sum[c] / (width * height) - 127.5) < 3, `layer ${layer} channel ${c} is neutral`);
    if (layer === 0) assert.ok(data.subarray(o, o + width * height * 4).every(v => v === 128 || v === 127), 'layer 0 is flat');
  }
  for (const [name, s] of Object.entries(uniform.SURFACE)) assert.ok(s.length === 3 && s.every(v => v >= 0 && v <= 1), `${name} surface`);
  t.dispose();
});

modelTest('the fold map is flat where there is no cloth to fold, and every part has its place in it or none', () => {
  const data = folds.buildFoldData(), { width, height } = folds.FOLD_MAP;
  assert.equal(data.length, width * height * 4);
  // Mean slope and the share of pixels that carry a fold, over a panel of the uniform atlas.
  const panel = (name, cell) => {
    const [rx, ry, rw, rh] = uniform.REGIONS[name];
    let bent = 0, n = 0; const sum = [0, 0];
    for (let y = Math.round(ry * height); y < Math.round((ry + rh) * height); y++) {
      for (let x = Math.round((cell + rx) * width / 2); x < Math.round((cell + rx + rw) * width / 2); x++) {
        const o = (y * width + x) * 4;
        sum[0] += data[o] - 127.5; sum[1] += data[o + 1] - 127.5; n++;
        if (Math.abs(data[o] - 127.5) > 6 || Math.abs(data[o + 1] - 127.5) > 6) bent++;
      }
    }
    return { bent: bent / n, mean: Math.hypot(sum[0], sum[1]) / n };
  };
  for (const [name, cell] of [['torso', 0], ['sleeveL', 0], ['sleeveR', 0], ['leg', 1], ['hips', 1]]) {
    const { bent, mean } = panel(name, cell);
    assert.ok(bent > 0.03 && bent < 0.6, `${name}: ${(bent * 100).toFixed(0)} % of the panel is folded`);
    assert.ok(mean < 6, `${name}: folds do not tilt the panel as a whole (${mean.toFixed(1)})`);
  }
  assert.equal(panel('sock', 1).bent, 0, 'socks are ribbed, not folded');
  assert.equal(panel('white', 1).bent, 0);
  // Each vertex of a body carries either no place in the map or one inside it.
  const specs = [{ id: 'qb', role: 'qb', number: 12, team: 'offense' }];
  const materials = { body: new THREE.MeshStandardMaterial(), helmet: new THREE.MeshStandardMaterial() };
  const squad = new model.Squad(new THREE.Scene(), 1, materials, { lod: false }), full = model.createGeometries();
  new model.Rig(squad, specs[0], 0, full, { offset: [0, 0], scale: [1, 1], white: [0.5, 0.5] });
  squad.finish();
  try {
    const f = squad.meshes.body.geometry.attributes.athFold;
    let placed = 0;
    for (let i = 0; i < f.count; i++) {
      const u = f.getX(i), v = f.getY(i);
      assert.ok((u === -1 && v === -1) || (u >= 0 && u <= 1 && v >= 0 && v <= 1), `vertex ${i}: (${u}, ${v})`);
      if (u >= 0) placed++;
    }
    assert.ok(placed / f.count > 0.4, 'jersey, sleeves and pants are in the map');
    const h = squad.meshes.helmet.geometry.attributes.athFold;
    for (let i = 0; i < h.count; i++) assert.equal(h.getX(i), -1);
  } finally {
    for (const g of Object.values(full)) g.dispose();
    for (const m of Object.values(squad.meshes)) m.geometry.dispose();
    squad.bones.texture.dispose(); materials.body.dispose(); materials.helmet.dispose();
  }
});

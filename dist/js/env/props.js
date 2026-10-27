import * as THREE from '../../vendor/three.module.js';
import { StaticBatch, canvasTexture, makeRandom, sceneZ, standard } from './common.js';
import { materials } from './facility.js';

// Sideline equipment on the west (left) sideline of the main field. Each prop
// is built in a local frame whose +x faces the field (east); positions are
// simulation yard lines converted with sceneZ().

const SPHERE = new THREE.SphereGeometry(1, 14, 10);
const BOX = new THREE.BoxGeometry(1, 1, 1);

export const PROP_SPOTS = {
  playClock: { x: -33.5, z: 14, yaw: -0.35 },
  cones: { x: -31.2, z: 21 },
  ballCart: { x: -31.3, z: 33 },
  scissorLift: { x: -40.5, z: 44.5 },
  water: { x: -32.2, z: 53.5 },
  bleacher: { x: -38.5, z: 60 },
  tent: { x: -34.5, z: 72.5 },
  bench: { x: -31.4, z: 80 },
  sled: { x: -33.4, z: 88 },
  dummies: { x: -31.5, z: 95 },
};

// Builds everything; `level` is the profile's props level (0 hides small props).
export function buildSidelineProps(parent, shadows) {
  const groups = { essential: new THREE.Group(), detail: new THREE.Group() };
  groups.essential.name = 'sideline-essential';
  groups.detail.name = 'sideline-detail';
  parent.add(groups.essential, groups.detail);
  bleacher(groups.essential, shadows);
  scissorLift(groups.essential, shadows);
  tent(groups.essential, shadows);
  playClock(groups.essential, shadows);
  sled(groups.essential, shadows);
  waterStation(groups.detail, shadows);
  ballCart(groups.detail, shadows);
  cones(groups.detail, shadows);
  bench(groups.detail, shadows);
  dummies(groups.detail, shadows);
  return groups;
}

function frame(batch, spot) {
  return batch.setFrame(spot.x, 0, sceneZ(spot.z), spot.yaw || 0);
}

// Converts a local prop offset to world scene coordinates for contact shadows.
function at(spot, lx, lz) {
  const yaw = spot.yaw || 0;
  return [spot.x + lx * Math.cos(yaw) + lz * Math.sin(yaw), sceneZ(spot.z) - lx * Math.sin(yaw) + lz * Math.cos(yaw)];
}

// Four-row aluminium bleacher at the 50, facing the field.
function bleacher(parent, shadows) {
  const spot = PROP_SPOTS.bleacher, batch = new StaticBatch('bleacher');
  const alu = materials.aluminium(), frameMat = materials.galvanized();
  frame(batch, spot);
  const length = 13, rows = 4, rise = 0.29, run = 0.78;
  for (let r = 0; r < rows; r++) {
    const seatY = 0.45 + r * rise, x = 1.0 - r * run;
    batch.box(alu, x, seatY, 0, 0.34, 0.06, length);
    batch.box(alu, x + 0.38, seatY - 0.27, 0, 0.3, 0.05, length);
  }
  // Frames every 2.6 yd: front post, rear post and stringer.
  for (let zf = -length / 2 + 0.4; zf <= length / 2 - 0.39; zf += (length - 0.8) / 5) {
    batch.tube(frameMat, [1.2, 0, zf], [1.2, 0.45, zf], 0.03, { segments: 5 });
    batch.tube(frameMat, [1.0 - 3 * run, 0, zf], [1.0 - 3 * run, 0.45 + 3 * rise + 1.0, zf], 0.03, { segments: 5 });
    batch.tube(frameMat, [1.3, 0.12, zf], [1.0 - 3 * run - 0.1, 0.45 + 3 * rise, zf], 0.028, { segments: 5 });
    batch.tube(frameMat, [1.2, 0.05, zf], [1.0 - 3 * run, 0.05, zf], 0.022, { segments: 5 });
  }
  // Back and side guard rails.
  for (const y of [0.45 + 3 * rise + 0.5, 0.45 + 3 * rise + 1.0]) {
    batch.tube(alu, [1.0 - 3 * run, y, -length / 2], [1.0 - 3 * run, y, length / 2], 0.025, { segments: 6 });
  }
  for (const side of [-1, 1]) {
    batch.tube(alu, [1.0, 0.45 + 0.9, side * length / 2], [1.0 - 3 * run, 0.45 + 3 * rise + 1.0, side * length / 2], 0.025, { segments: 6 });
    batch.tube(alu, [1.0, 0.45, side * length / 2], [1.0, 0.45 + 0.9, side * length / 2], 0.025, { segments: 6 });
  }
  batch.clearFrame();
  batch.build(parent, { castShadow: true });
  const [sx, sz] = at(spot, -0.3, 0);
  shadows.add(sx, sz, 3.6, length + 0.6, { strength: 0.5 });
}

// Scissor lift with a camera platform (~7.5 yd).
function scissorLift(parent, shadows) {
  const spot = PROP_SPOTS.scissorLift, batch = new StaticBatch('scissor-lift');
  const body = standard('#24384f', 0.55, 0.35), arm = standard('#8f979d', 0.45, 0.6), rubber = materials.rubber();
  const rail = materials.galvanized(), black = standard('#16191c', 0.45, 0.35);
  frame(batch, spot);
  batch.box(body, 0, 0.62, 0, 1.3, 0.55, 2.7);
  batch.box(standard('#c9ccd1', 0.4, 0.6), 0, 0.92, 0, 1.2, 0.06, 2.5);
  for (const [x, z] of [[-0.55, -1.0], [0.55, -1.0], [-0.55, 1.0], [0.55, 1.0]]) {
    batch.place(rubber, new THREE.CylinderGeometry(0.27, 0.27, 0.22, 14).rotateX(Math.PI / 2).rotateY(Math.PI / 2), x * 1.12, 0.27, z);
  }
  const stages = 5, top = 7.3, base = 1.0, stageH = (top - base) / stages, half = 1.12;
  for (const side of [-0.5, 0.5]) {
    for (let k = 0; k < stages; k++) {
      const y0 = base + k * stageH, y1 = y0 + stageH;
      batch.tube(arm, [side, y0, -half], [side, y1, half], 0.06, { segments: 6 });
      batch.tube(arm, [side, y0, half], [side, y1, -half], 0.06, { segments: 6 });
    }
  }
  batch.box(body, 0, top + 0.08, 0, 1.4, 0.16, 2.8);
  for (const y of [0.55, 1.1]) {
    batch.tube(rail, [-0.68, top + y, -1.38], [-0.68, top + y, 1.38], 0.025, { segments: 5 });
    batch.tube(rail, [0.68, top + y, -1.38], [0.68, top + y, 1.38], 0.025, { segments: 5 });
    batch.tube(rail, [-0.68, top + y, -1.38], [0.68, top + y, -1.38], 0.025, { segments: 5 });
    batch.tube(rail, [-0.68, top + y, 1.38], [0.68, top + y, 1.38], 0.025, { segments: 5 });
  }
  for (const [x, z] of [[-0.68, -1.38], [0.68, -1.38], [-0.68, 1.38], [0.68, 1.38], [0.68, 0], [-0.68, 0]]) {
    batch.tube(rail, [x, top + 0.1, z], [x, top + 1.12, z], 0.025, { segments: 5 });
  }
  // Camera on a tripod and its operator.
  batch.box(black, 0.25, top + 1.35, 0.3, 0.55, 0.32, 0.26);
  batch.box(black, 0.6, top + 1.38, 0.3, 0.18, 0.2, 0.2);
  for (const a of [0, 2.1, 4.2]) batch.tube(black, [0.25, top + 1.18, 0.3], [0.25 + Math.cos(a) * 0.32, top + 0.16, 0.3 + Math.sin(a) * 0.32], 0.015, { segments: 4 });
  figure(batch, -0.2, top + 0.16, -0.25, standard('#13263b', 0.85, 0), standard('#2b2f33', 0.85, 0));
  batch.clearFrame();
  batch.build(parent, { castShadow: true });
  const [sx, sz] = at(spot, 0, 0);
  shadows.add(sx, sz, 2.0, 3.4, { strength: 0.6 });
}

// A simple standing staff figure (polo, trousers, cap); feet at (x, y, z).
function figure(batch, x, y, z, shirt, trousers, skin = standard('#b5835e', 0.7, 0)) {
  batch.tube(trousers, [x, y, z - 0.09], [x, y + 0.95, z - 0.09], 0.075, { segments: 7 });
  batch.tube(trousers, [x, y, z + 0.09], [x, y + 0.95, z + 0.09], 0.075, { segments: 7 });
  batch.tube(shirt, [x, y + 0.9, z], [x, y + 1.55, z], 0.17, { top: 0.2, segments: 9 });
  batch.tube(shirt, [x, y + 1.5, z - 0.25], [x + 0.05, y + 1.0, z - 0.27], 0.055, { segments: 6 });
  batch.tube(shirt, [x, y + 1.5, z + 0.25], [x + 0.05, y + 1.0, z + 0.27], 0.055, { segments: 6 });
  batch.place(skin, SPHERE, x, y + 1.72, z, { scale: [0.1, 0.12, 0.1] });
  batch.place(shirt, new THREE.SphereGeometry(1, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), x, y + 1.77, z, { scale: [0.11, 0.07, 0.11] });
  batch.box(shirt, x + 0.1, y + 1.77, z, 0.12, 0.015, 0.16);
}

// Trainer's pop-up tent with a taping table.
function tent(parent, shadows) {
  const spot = PROP_SPOTS.tent, batch = new StaticBatch('trainer-tent');
  const fabric = standard('#15283d', 0.9, 0, { side: THREE.DoubleSide }), leg = materials.silver();
  frame(batch, spot);
  const s = 1.55, h = 2.25;
  for (const [x, z] of [[-s, -s], [s, -s], [s, s], [-s, s]]) batch.box(leg, x, h / 2, z, 0.06, h, 0.06);
  const roof = new THREE.ConeGeometry(s * Math.SQRT2, 0.6, 4, 1, true).rotateY(Math.PI / 4);
  batch.place(fabric, roof, 0, h + 0.3, 0);
  for (const [x, z, w, d] of [[s, 0, 0.02, 2 * s], [-s, 0, 0.02, 2 * s], [0, s, 2 * s, 0.02], [0, -s, 2 * s, 0.02]]) {
    batch.box(fabric, x, h - 0.12, z, w, 0.28, d);
  }
  // Padded taping table, a cooler and a stack of towels.
  batch.box(materials.navy(), 0.2, 0.78, 0, 0.7, 0.12, 1.9);
  for (const [x, z] of [[-0.1, -0.85], [0.5, -0.85], [-0.1, 0.85], [0.5, 0.85]]) batch.box(leg, x, 0.36, z, 0.05, 0.72, 0.05);
  batch.box(materials.white(), -0.9, 0.3, 0.9, 0.55, 0.6, 0.4);
  batch.box(materials.navy(), -0.9, 0.63, 0.9, 0.57, 0.06, 0.42);
  batch.box(materials.white(), -0.9, 0.12, -0.6, 0.45, 0.25, 0.35);
  figure(batch, 0.9, 0, 0.4, standard('#c9ccd1', 0.8, 0), standard('#1d2a38', 0.85, 0));
  batch.clearFrame();
  batch.build(parent, { castShadow: true });
  const [sx, sz] = at(spot, 0, 0);
  shadows.add(sx, sz, 3.6, 3.6, { strength: 0.35 });
}

// Portable play clock on a small trailer.
function playClockTexture() {
  return canvasTexture(256, 160, (c, w, h) => {
    c.fillStyle = '#060708';
    c.fillRect(0, 0, w, h);
    c.fillStyle = '#ffd38a';
    c.font = '700 118px "Barlow Condensed", "Arial Narrow", Arial, sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText('40', w / 2, h / 2 + 6);
  });
}
function playClock(parent, shadows) {
  const spot = PROP_SPOTS.playClock, batch = new StaticBatch('play-clock');
  const frameMat = materials.steelDark(), rubber = materials.rubber(), box = standard('#1a1d20', 0.6, 0.3);
  frame(batch, spot);
  batch.box(frameMat, 0, 0.42, 0, 1.1, 0.12, 1.6);
  batch.tube(frameMat, [0, 0.42, 0.8], [0, 0.32, 1.7], 0.035, { segments: 5 });
  for (const z of [-0.62, 0.62]) {
    batch.place(rubber, new THREE.CylinderGeometry(0.24, 0.24, 0.16, 12).rotateX(Math.PI / 2), 0, 0.24, z, { yaw: Math.PI / 2 });
  }
  batch.box(frameMat, 0, 1.0, 0, 0.12, 1.1, 0.12);
  batch.box(box, 0, 2.05, 0, 0.3, 1.0, 1.5);
  batch.clearFrame();
  batch.build(parent, { castShadow: true });
  const face = new THREE.Mesh(new THREE.PlaneGeometry(1.36, 0.86), new THREE.MeshStandardMaterial({
    color: '#000000', emissive: '#ffffff', emissiveMap: playClockTexture(), emissiveIntensity: 1.6, roughness: 0.3,
  }));
  const [fx, fz] = at(spot, 0.16, 0);
  face.position.set(fx, 2.05, fz);
  face.rotation.y = Math.PI / 2 + (spot.yaw || 0);
  parent.add(face);
  const [sx, sz] = at(spot, 0, 0.3);
  shadows.add(sx, sz, 1.6, 2.4, { strength: 0.5 });
}

// Two-man blocking sled.
function sled(parent, shadows) {
  const spot = PROP_SPOTS.sled, batch = new StaticBatch('sled');
  const steel = standard('#2e3237', 0.5, 0.6), pad = materials.navy();
  frame(batch, spot);
  for (const z of [-1.05, 1.05]) batch.tube(steel, [-1.4, 0.06, z], [0.8, 0.06, z], 0.05, { segments: 6 });
  batch.tube(steel, [0.8, 0.06, -1.05], [0.8, 0.06, 1.05], 0.05, { segments: 6 });
  batch.tube(steel, [-1.4, 0.06, -1.05], [-1.4, 0.06, 1.05], 0.05, { segments: 6 });
  batch.box(steel, -0.9, 0.12, 0, 1.0, 0.06, 1.9);
  for (const z of [-0.55, 0.55]) {
    batch.tube(steel, [0.55, 0.06, z], [0.55, 1.25, z], 0.04, { segments: 6 });
    batch.tube(steel, [0.55, 1.2, z], [-0.5, 0.06, z], 0.035, { segments: 6 });
    batch.place(pad, BOX, 0.78, 1.05, z, { pitch: 0, roll: 0.12, scale: [0.34, 0.95, 0.66] });
  }
  batch.tube(steel, [0.55, 1.25, -0.6], [0.55, 1.25, 0.6], 0.035, { segments: 6 });
  batch.clearFrame();
  batch.build(parent, { castShadow: true });
  const [sx, sz] = at(spot, -0.2, 0);
  shadows.add(sx, sz, 2.8, 2.6, { strength: 0.45 });
}

// Hydration station: tank on a stand with drinking spouts, bottle carrier and a cooler.
function waterStation(parent, shadows) {
  const spot = PROP_SPOTS.water, batch = new StaticBatch('water');
  const tank = standard('#c9ccd1', 0.35, 0.7), navy = materials.navy(), white = materials.white();
  frame(batch, spot);
  batch.tube(tank, [0, 0, 0], [0, 0.55, 0], 0.2, { top: 0.32, segments: 12 });
  batch.tube(navy, [0, 0.55, 0], [0, 1.45, 0], 0.42, { segments: 18 });
  batch.place(navy, new THREE.SphereGeometry(0.42, 18, 8, 0, Math.PI * 2, 0, Math.PI / 2), 0, 1.45, 0, { scale: [1, 0.4, 1] });
  for (let i = 0; i < 6; i++) {
    const a = i / 6 * Math.PI * 2;
    batch.tube(tank, [Math.cos(a) * 0.4, 1.1, Math.sin(a) * 0.4], [Math.cos(a) * 0.62, 1.05, Math.sin(a) * 0.62], 0.02, { segments: 4 });
  }
  // Bottle carrier.
  batch.box(navy, 0.4, 0.2, 1.0, 0.45, 0.4, 0.62);
  for (let i = 0; i < 6; i++) {
    batch.tube(white, [0.3 + (i % 2) * 0.2, 0.4, 0.8 + Math.floor(i / 2) * 0.2], [0.3 + (i % 2) * 0.2, 0.65, 0.8 + Math.floor(i / 2) * 0.2], 0.05, { segments: 8 });
  }
  batch.box(white, -0.2, 0.3, -1.0, 0.6, 0.6, 0.45);
  batch.box(navy, -0.2, 0.63, -1.0, 0.62, 0.07, 0.47);
  batch.clearFrame();
  batch.build(parent, { castShadow: true });
  const [sx, sz] = at(spot, 0, 0);
  shadows.add(sx, sz, 1.5, 3.0, { strength: 0.5 });
}

// Ball cart: a wire basket on wheels, full of practice balls.
function ballCart(parent, shadows) {
  const spot = PROP_SPOTS.ballCart, batch = new StaticBatch('ball-cart');
  const wire = materials.galvanized(), rubber = materials.rubber(), leather = standard('#6e3b22', 0.72, 0);
  const stripe = materials.white();
  frame(batch, spot);
  const w = 0.42, l = 0.62, y0 = 0.45, y1 = 1.05;
  const corners = [[-w, -l], [w, -l], [w, l], [-w, l]];
  for (const y of [y0, (y0 + y1) / 2, y1]) {
    for (let i = 0; i < 4; i++) {
      const [ax, az] = corners[i], [bx, bz] = corners[(i + 1) % 4];
      batch.tube(wire, [ax, y, az], [bx, y, bz], 0.012, { segments: 4 });
    }
  }
  for (const [x, z] of corners) {
    batch.tube(wire, [x, 0.12, z], [x, y1, z], 0.016, { segments: 4 });
    batch.place(rubber, new THREE.CylinderGeometry(0.1, 0.1, 0.06, 10).rotateZ(Math.PI / 2), x, 0.1, z);
  }
  batch.tube(wire, [-w, y1, -l], [-w - 0.3, y1 + 0.35, -l], 0.015, { segments: 4 });
  batch.tube(wire, [-w, y1, l], [-w - 0.3, y1 + 0.35, l], 0.015, { segments: 4 });
  batch.tube(wire, [-w - 0.3, y1 + 0.35, -l], [-w - 0.3, y1 + 0.35, l], 0.02, { segments: 4 });
  const random = makeRandom(311);
  for (let i = 0; i < 22; i++) {
    const x = (random() - 0.5) * 0.65, z = (random() - 0.5) * 1.05, y = y0 + 0.12 + random() * 0.45;
    const yaw = random() * Math.PI, pitch = (random() - 0.5) * 0.8;
    batch.place(leather, SPHERE, x, y, z, { yaw, pitch, scale: [0.105, 0.105, 0.17] });
    batch.place(stripe, new THREE.CylinderGeometry(1, 1, 1, 10, 1, true).rotateX(Math.PI / 2), x, y, z, { yaw, pitch, scale: [0.106, 0.106, 0.025] });
  }
  batch.clearFrame();
  batch.build(parent, { castShadow: true });
  const [sx, sz] = at(spot, 0, 0);
  shadows.add(sx, sz, 1.3, 1.7, { strength: 0.45 });
}

// A row of agility cones.
function cones(parent, shadows) {
  const spot = PROP_SPOTS.cones, batch = new StaticBatch('cones');
  const orange = standard('#ff6f22', 0.6, 0);
  const cone = new THREE.ConeGeometry(0.11, 0.32, 14, 1, true);
  for (let i = 0; i < 8; i++) {
    const z = sceneZ(spot.z + i * 1.25);
    batch.place(orange, cone, spot.x, 0.18, z);
    batch.box(orange, spot.x, 0.012, z, 0.26, 0.024, 0.26);
    shadows.add(spot.x, z, 0.42, 0.42, { strength: 0.35 });
  }
  batch.build(parent, { castShadow: true });
}

// Aluminium team bench.
function bench(parent, shadows) {
  const spot = PROP_SPOTS.bench, batch = new StaticBatch('bench');
  const alu = materials.aluminium();
  frame(batch, spot);
  const length = 5;
  batch.box(alu, 0, 0.46, 0, 0.36, 0.05, length);
  for (let z = -length / 2 + 0.3; z <= length / 2 - 0.29; z += (length - 0.6) / 3) {
    batch.tube(materials.galvanized(), [-0.12, 0, z], [-0.12, 0.45, z], 0.02, { segments: 5 });
    batch.tube(materials.galvanized(), [0.12, 0, z], [0.12, 0.45, z], 0.02, { segments: 5 });
  }
  figure(batch, 0.85, 0, -1.4, standard('#13263b', 0.85, 0), standard('#c2b59b', 0.85, 0));
  figure(batch, 1.3, 0, 1.0, standard('#c9ccd1', 0.85, 0), standard('#13263b', 0.85, 0), standard('#7b5238', 0.7, 0));
  batch.clearFrame();
  batch.build(parent, { castShadow: true });
  const [sx, sz] = at(spot, 0, 0);
  shadows.add(sx, sz, 0.9, length + 0.4, { strength: 0.4 });
}

// Standing tackling dummies.
function dummies(parent, shadows) {
  const spot = PROP_SPOTS.dummies, batch = new StaticBatch('dummies');
  const navy = materials.navy(), silver = materials.silver();
  const random = makeRandom(97);
  for (let i = 0; i < 4; i++) {
    const x = spot.x - random() * 1.2, z = sceneZ(spot.z + i * 1.3);
    const tilt = (random() - 0.5) * 0.3;
    batch.place(navy, new THREE.CapsuleGeometry(0.24, 0.85, 4, 12), x, 0.68, z, { roll: tilt, yaw: random() * 3 });
    batch.place(silver, new THREE.CylinderGeometry(0.245, 0.245, 0.1, 12), x - Math.sin(tilt) * 0.3, 0.98, z, { roll: tilt });
    shadows.add(x, z, 0.75, 0.75, { strength: 0.45 });
  }
  batch.build(parent, { castShadow: true });
}

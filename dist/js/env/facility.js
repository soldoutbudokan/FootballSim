import * as THREE from '../../vendor/three.module.js';
import { StaticBatch, canvasTexture, makeRandom, sceneZ, standard } from './common.js';

// Large practice-facility structures: the team building south of the fields,
// the windscreen fence, the four light poles and the film tower.

export const LAYOUT = {
  fence: { west: -58, east: 104, south: -12, north: 142 },
  building: { west: -46, east: 34, front: -18, back: -42, height: 9.4, overhang: 4.5 },
  poles: [
    { x: -37, z: 24 }, { x: -37, z: 96 },
    { x: 31.67, z: 24 }, { x: 31.67, z: 96 },
  ],
  poleHeight: 25,
  tower: { x: -33, z: 127.5, height: 12 },
};

export const materials = {
  galvanized: () => standard('#a6acb0', 0.42, 0.75),
  aluminium: () => standard('#c8ccd0', 0.3, 0.85),
  darkMetal: () => standard('#2a3037', 0.52, 0.55),
  steelDark: () => standard('#3a4047', 0.5, 0.6),
  concrete: () => standard('#a7a59d', 0.93, 0),
  navy: () => standard('#13263b', 0.88, 0),
  silver: () => standard('#c9ccd1', 0.45, 0.6),
  rubber: () => standard('#141617', 0.9, 0),
  white: () => standard('#eceeea', 0.7, 0),
};

// ---------------------------------------------------------------------------
// Team building

function interiorTexture() {
  const random = makeRandom(9071);
  return canvasTexture(1024, 256, (c, w, h) => {
    // Two floors seen through the glass: a dim interior, ceiling light strips,
    // partitions and a few brighter rooms. Upper floor is y 0..0.47, lower 0.53..1.
    c.fillStyle = '#000000';
    c.fillRect(0, 0, w, h);
    for (const [y0, y1] of [[0.02, 0.45], [0.55, 0.98]]) {
      const top = y0 * h, height = (y1 - y0) * h;
      const back = c.createLinearGradient(0, top, 0, top + height);
      back.addColorStop(0, '#3a3a36');
      back.addColorStop(0.5, '#1d1e1d');
      back.addColorStop(1, '#0c0d0d');
      c.fillStyle = back;
      c.fillRect(0, top, w, height);
      for (let x = 0; x < w; x += 40 + random() * 50) {
        const roomW = 30 + random() * 60, bright = random();
        if (bright > 0.55) {
          c.fillStyle = `rgba(255, 238, 210, ${0.12 + 0.18 * bright})`;
          c.fillRect(x, top, roomW, height);
        }
        c.fillStyle = '#060606';
        c.fillRect(x, top + height * 0.15, 2, height * 0.85);
      }
      c.fillStyle = 'rgba(255, 250, 238, 0.85)';
      for (let x = 4; x < w; x += 22) c.fillRect(x, top + 3, 14, 2);
      // Silhouettes of furniture / equipment near the floor.
      c.fillStyle = '#050505';
      for (let x = 0; x < w; x += 12 + random() * 30) c.fillRect(x, top + height * (0.72 + random() * 0.1), 6 + random() * 14, height);
    }
  });
}

function panelTexture() {
  return canvasTexture(256, 256, (c, w, h) => {
    c.fillStyle = '#7d848a';
    c.fillRect(0, 0, w, h);
    c.fillStyle = '#5d646a';
    for (let x = 0; x < w; x += 64) c.fillRect(x, 0, 3, h);
    for (let y = 0; y < h; y += 128) c.fillRect(0, y, w, 2);
  });
}

function signTexture() {
  return canvasTexture(1024, 128, (c, w, h) => {
    c.clearRect(0, 0, w, h);
    c.fillStyle = '#d3d6da';
    c.font = '600 74px "Barlow Condensed", "Arial Narrow", Arial, sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText('P E R F O R M A N C E   C E N T E R', w / 2, h / 2 + 4);
  });
}

export function buildTeamBuilding(parent, shadows) {
  const B = LAYOUT.building;
  const batch = new StaticBatch('team-building');
  const dark = materials.darkMetal(), concrete = materials.concrete(), silver = materials.silver();
  const panel = new THREE.MeshStandardMaterial({ color: '#4a5159', roughness: 0.5, metalness: 0.55, map: panelTexture() });
  panel.map.wrapS = panel.map.wrapT = THREE.RepeatWrapping;
  const roof = standard('#5a5f63', 0.85, 0.1);
  const glass = new THREE.MeshStandardMaterial({
    color: '#aebdc7', roughness: 0.05, metalness: 0.9,
    emissive: '#ffffff', emissiveMap: interiorTexture(), emissiveIntensity: 0.05,
  });
  // Scene z: the facade faces north (-z) toward the fields.
  const front = sceneZ(B.front), back = sceneZ(B.back), depth = back - front;
  const width = B.east - B.west, cx = (B.west + B.east) / 2, cz = (front + back) / 2;

  // Core volume behind the glass (dark), with the stair / lobby tower at the west end.
  batch.block(dark, cx, 0, cz + 0.6, width, B.height, depth - 1.2);
  const towerW = 11;
  batch.block(panel, B.west + towerW / 2, 0, cz, towerW, B.height + 2.2, depth + 0.4);
  // Glass curtain wall on the field side, split by a dark floor band.
  const glassX0 = B.west + towerW, glassW = B.east - glassX0 - 3;
  const glassGeometry = new THREE.PlaneGeometry(glassW, B.height - 0.5);
  glassGeometry.attributes.uv.array.forEach((v, i, a) => { if (i % 2 === 0) a[i] = v * 2; });
  glass.emissiveMap.wrapS = THREE.RepeatWrapping;
  const glassMesh = new THREE.Mesh(glassGeometry, glass);
  glassMesh.rotation.y = Math.PI;
  glassMesh.position.set(glassX0 + glassW / 2, (B.height - 0.5) / 2 + 0.15, front - 0.02);
  glassMesh.receiveShadow = true;
  parent.add(glassMesh);
  batch.block(dark, glassX0 + glassW / 2, 4.35, front - 0.12, glassW, 0.55, 0.3);
  // Vertical mullions every ~1.6 yd.
  const bays = Math.round(glassW / 1.6);
  for (let i = 0; i <= bays; i++) {
    batch.block(silver, glassX0 + i * glassW / bays, 0.1, front - 0.1, 0.07, B.height - 0.4, 0.18);
  }
  for (const y of [0.9, 3.4, 5.4, 8.1]) batch.block(silver, glassX0 + glassW / 2, y, front - 0.09, glassW, 0.06, 0.12);
  // East end: solid panel block.
  batch.block(panel, B.east - 1.5, 0, cz, 3, B.height + 0.4, depth + 0.2);
  // Wide roof overhang with a silver fascia and slim columns.
  const roofFront = front - B.overhang;
  batch.block(roof, cx + 1, B.height, (roofFront + back) / 2, width + 4, 0.45, back - roofFront + 0.5);
  // Light metal soffit under the overhang so it does not read as a black slab.
  batch.block(standard('#b9bdc0', 0.6, 0.3), cx + 1, B.height - 0.04, roofFront + B.overhang / 2 + 0.1, width + 3.8, 0.05, B.overhang + 0.3);
  batch.block(silver, cx + 1, B.height - 0.05, roofFront - 0.25, width + 4, 0.6, 0.12);
  for (let x = glassX0 + 2; x < B.east - 3; x += 8) {
    batch.tube(silver, [x, 0, roofFront + 0.6], [x, B.height, roofFront + 0.6], 0.13, { segments: 10 });
  }
  // Rooftop mechanical units.
  for (const [x, w] of [[-20, 6], [-4, 4], [12, 7]]) batch.block(standard('#8a8f93', 0.7, 0.3), x, B.height + 0.45, cz + 3, w, 1.6, 4);
  // Entrance: doors and a concrete apron / walkway toward the fields.
  // Entrance: glass doors in a dark frame under a canopy.
  batch.block(standard('#1c242c', 0.35, 0.6), 2, 0, front - 0.1, 6.3, 3.15, 0.12);
  for (const x of [-0.6, 1.0, 3.0, 4.6]) batch.block(glass, x, 0.05, front - 0.18, 1.5, 2.9, 0.04);
  batch.block(silver, 2, 3.1, front - 1.3, 7, 0.18, 2.6);
  batch.block(concrete, cx, -0.04, front - 3.2, width + 6, 0.1, 6.4);
  batch.block(concrete, 2, -0.035, front - 8.5, 4, 0.1, 6);
  batch.build(parent, { castShadow: true, receiveShadow: true });

  const sign = new THREE.Mesh(new THREE.PlaneGeometry(9.5, 1.2), new THREE.MeshStandardMaterial({
    map: signTexture(), transparent: true, roughness: 0.4, metalness: 0.7, color: '#ffffff',
  }));
  sign.rotation.y = Math.PI;
  sign.position.set(B.west + towerW / 2, B.height - 0.2, front - 0.23);
  parent.add(sign);
  shadows.add(cx, front - 1.0, width + 2, 3.0, { strength: 0.55 });
  return { glass };
}

// ---------------------------------------------------------------------------
// Windscreen fence on chain-link posts

function windscreenTexture() {
  return canvasTexture(256, 128, (c, w, h) => {
    c.fillStyle = '#1d3a2b';
    c.fillRect(0, 0, w, h);
    // Weave and vertical folds.
    for (let x = 0; x < w; x += 2) {
      c.fillStyle = `rgba(0,0,0,${0.06 + 0.06 * Math.sin(x * 0.11)})`;
      c.fillRect(x, 0, 1, h);
    }
    // Hems with grommets.
    c.fillStyle = '#16301f';
    c.fillRect(0, 0, w, 7);
    c.fillRect(0, h - 7, w, 7);
    c.fillStyle = '#9aa29c';
    for (let x = 16; x < w; x += 64) {
      c.beginPath(); c.arc(x, 3.5, 2.2, 0, Math.PI * 2); c.fill();
      c.beginPath(); c.arc(x, h - 3.5, 2.2, 0, Math.PI * 2); c.fill();
    }
  });
}

function chainLinkTexture() {
  return canvasTexture(64, 64, (c, w, h) => {
    c.clearRect(0, 0, w, h);
    c.strokeStyle = '#b6bcbf';
    c.lineWidth = 3;
    c.beginPath();
    c.moveTo(0, 0); c.lineTo(w, h); c.moveTo(w, 0); c.lineTo(0, h);
    c.stroke();
  });
}

export function buildFence(parent) {
  const F = LAYOUT.fence, B = LAYOUT.building;
  const batch = new StaticBatch('fence');
  const post = materials.galvanized();
  const fabric = new THREE.MeshStandardMaterial({ color: '#ffffff', map: windscreenTexture(), roughness: 0.95, side: THREE.DoubleSide });
  fabric.map.wrapS = THREE.RepeatWrapping;
  const link = new THREE.MeshStandardMaterial({
    color: '#c2c7c9', map: chainLinkTexture(), roughness: 0.5, metalness: 0.6, transparent: false,
    alphaTest: 0.35, alphaToCoverage: true, side: THREE.DoubleSide,
  });
  link.map.wrapS = link.map.wrapT = THREE.RepeatWrapping;
  const height = 2.75, screen = 2.05;
  // Polyline runs (scene coordinates), south side split around the building.
  const runs = [
    [[B.west, F.south], [F.west, F.south], [F.west, F.north], [F.east, F.north], [F.east, F.south], [B.east + 1, F.south]],
  ];
  for (const run of runs) {
    for (let i = 0; i < run.length - 1; i++) {
      const [x0, z0] = run[i], [x1, z1] = run[i + 1];
      const a = new THREE.Vector3(x0, 0, sceneZ(z0)), b = new THREE.Vector3(x1, 0, sceneZ(z1));
      const length = a.distanceTo(b), dir = b.clone().sub(a).normalize();
      const yaw = Math.atan2(-dir.z, dir.x);
      const mid = a.clone().add(b).multiplyScalar(0.5);
      const count = Math.max(1, Math.round(length / 3.2));
      for (let k = 0; k <= count; k++) {
        const p = a.clone().lerp(b, k / count);
        batch.tube(post, [p.x, 0, p.z], [p.x, height, p.z], 0.042, { segments: 6 });
      }
      batch.tube(post, [a.x, height, a.z], [b.x, height, b.z], 0.03, { segments: 6 });
      batch.tube(post, [a.x, 0.08, a.z], [b.x, 0.08, b.z], 0.02, { segments: 5 });
      // Windscreen panel and the chain link above it.
      const screenGeometry = new THREE.PlaneGeometry(length, screen);
      screenGeometry.attributes.uv.array.forEach((v, i, arr) => { if (i % 2 === 0) arr[i] = v * length / 4; });
      batch.place(fabric, screenGeometry, mid.x, screen / 2 + 0.04, mid.z, { yaw });
      const linkGeometry = new THREE.PlaneGeometry(length, height - screen);
      linkGeometry.attributes.uv.array.forEach((v, i, arr) => { arr[i] = i % 2 === 0 ? v * length / 0.09 : v * (height - screen) / 0.09; });
      batch.place(link, linkGeometry, mid.x, screen + (height - screen) / 2, mid.z, { yaw });
    }
  }
  batch.build(parent, { castShadow: true, receiveShadow: true });
}

// ---------------------------------------------------------------------------
// Light poles (~25 yd, three-fixture heads aimed at the main field)

export function buildLightPoles(parent, shadows) {
  const batch = new StaticBatch('light-poles');
  const steel = materials.galvanized(), housing = standard('#2b3035', 0.55, 0.5), concrete = materials.concrete();
  const lens = new THREE.MeshStandardMaterial({ color: '#d9dde0', roughness: 0.2, metalness: 0.1, emissive: '#f4f7ff', emissiveIntensity: 0 });
  const heads = [];
  const H = LAYOUT.poleHeight;
  for (const pole of LAYOUT.poles) {
    const x = pole.x, z = sceneZ(pole.z);
    // Aim at a point on the main field between the hashes and the near numbers.
    const aim = new THREE.Vector3(pole.x < 0 ? -7 : 7, 0, sceneZ(pole.z < 60 ? 36 : 84));
    const toAim = aim.clone().sub(new THREE.Vector3(x, H, z));
    const yaw = Math.atan2(-toAim.z, toAim.x);
    batch.block(concrete, x, 0, z, 1.1, 0.35, 1.1);
    batch.tube(steel, [x, 0, z], [x, H, z], 0.3, { top: 0.17, segments: 12 });
    batch.block(standard('#8c9296', 0.5, 0.5), x + 0.35, 1.1, z, 0.25, 0.7, 0.45, yaw);
    batch.setFrame(x, H, z, yaw);
    batch.box(steel, 0.25, 0.1, 0, 0.22, 0.22, 4.6);
    batch.box(steel, 0.25, -0.5, 0, 0.12, 1.2, 0.12);
    const pitch = Math.atan2(-toAim.y, Math.hypot(toAim.x, toAim.z));
    for (const lateral of [-1.5, 0, 1.5]) {
      batch.place(housing, UNIT_BOX, 0.75, 0.2, lateral, { yaw: 0, roll: -pitch, scale: [0.55, 0.95, 1.15] });
      batch.place(lens, UNIT_PLANE_X, 0.75 + 0.29 * Math.cos(pitch), 0.2 - 0.29 * Math.sin(pitch), lateral, { roll: -pitch, scale: [1, 0.8, 1.0] });
      batch.place(housing, UNIT_BOX, 0.95, 0.66, lateral, { roll: -pitch - 0.25, scale: [0.6, 0.05, 1.2] });
    }
    batch.clearFrame();
    const headPosition = new THREE.Vector3(x, H, z).add(new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw)).multiplyScalar(0.9));
    heads.push({ position: headPosition, aim, yaw });
    shadows.add(x, z, 1.8, 1.8, { strength: 0.5 });
  }
  batch.build(parent, { castShadow: true });
  return { heads, lens };
}
const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);
// A unit plane facing local +x (lens fronts).
const UNIT_PLANE_X = new THREE.PlaneGeometry(1, 1).rotateY(Math.PI / 2);

// Glow sprites and faint beams that make the poles read at night.
export function buildLampGlow(parent, heads) {
  const glowTexture = canvasTexture(128, 128, (c, w, h) => {
    const g = c.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.18, 'rgba(235,242,255,0.55)');
    g.addColorStop(0.5, 'rgba(200,215,255,0.12)');
    g.addColorStop(1, 'rgba(200,215,255,0)');
    c.fillStyle = g;
    c.fillRect(0, 0, w, h);
  });
  const glowMaterial = new THREE.SpriteMaterial({ map: glowTexture, color: '#ffffff', transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
  // Soft light shafts: brightest near the lamp, fading along the beam and
  // toward the silhouette edges of the cone.
  const beamMaterial = new THREE.ShaderMaterial({
    uniforms: { beamColor: { value: new THREE.Color('#cfdcff') }, beamStrength: { value: 0.05 } },
    vertexShader: /* glsl */`
      varying float vAlong;
      varying float vFacing;
      void main() {
        vAlong = clamp(-position.y / 40.0, 0.0, 1.0);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vec3 n = normalize(normalMatrix * normal);
        vFacing = abs(dot(n, normalize(-mv.xyz)));
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 beamColor;
      uniform float beamStrength;
      varying float vAlong;
      varying float vFacing;
      void main() {
        float a = beamStrength * pow(1.0 - vAlong, 2.0) * vFacing * vFacing;
        gl_FragColor = vec4(beamColor * a, 1.0);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
  const group = new THREE.Group();
  group.name = 'lamp-glow';
  for (const head of heads) {
    const sprite = new THREE.Sprite(glowMaterial);
    sprite.position.copy(head.position).add(new THREE.Vector3(0, 0.25, 0));
    sprite.scale.setScalar(9);
    group.add(sprite);
    const length = head.position.distanceTo(head.aim) * 0.85;
    const beam = new THREE.Mesh(new THREE.ConeGeometry(9, length, 24, 1, true), beamMaterial);
    beam.geometry.translate(0, -length / 2, 0);
    beam.position.copy(head.position);
    beam.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), head.aim.clone().sub(head.position).normalize());
    group.add(beam);
  }
  group.visible = false;
  parent.add(group);
  return group;
}

// ---------------------------------------------------------------------------
// Scaffold film tower at the north-west corner (~12 yd platform)

export function buildFilmTower(parent, shadows) {
  const T = LAYOUT.tower;
  const batch = new StaticBatch('film-tower');
  const steel = materials.galvanized(), deck = standard('#4b4f52', 0.8, 0.2), black = standard('#15181b', 0.5, 0.3);
  const x0 = T.x, z0 = sceneZ(T.z), s = 1.1, H = T.height, level = 2;
  batch.setFrame(x0, 0, z0, Math.PI / 4);
  const corners = [[-s, -s], [s, -s], [s, s], [-s, s]];
  for (const [x, z] of corners) {
    batch.tube(steel, [x, 0, z], [x, H + 1.1, z], 0.045, { segments: 6 });
    batch.box(steel, x, 0.02, z, 0.3, 0.04, 0.3);
  }
  for (let y = level; y <= H; y += level) {
    for (let i = 0; i < 4; i++) {
      const [ax, az] = corners[i], [bx, bz] = corners[(i + 1) % 4];
      batch.tube(steel, [ax, y, az], [bx, y, bz], 0.035, { segments: 5 });
      // Diagonal braces alternate direction every level.
      const flip = (y / level + i) % 2 === 0;
      batch.tube(steel, [ax, y - (flip ? level : 0), az], [bx, y - (flip ? 0 : level), bz], 0.025, { segments: 5 });
    }
  }
  // Ladder on the field side.
  for (const side of [-0.25, 0.25]) batch.tube(steel, [s + 0.06, 0, side], [s + 0.06, H, side], 0.02, { segments: 4 });
  for (let y = 0.3; y < H; y += 0.33) batch.tube(steel, [s + 0.06, y, -0.25], [s + 0.06, y, 0.25], 0.012, { segments: 4 });
  // Platform, guard rails, toe boards, camera on a tripod and an operator.
  batch.box(deck, 0, H, 0, 2 * s + 0.5, 0.12, 2 * s + 0.5);
  for (const rail of [0.55, 1.05]) {
    for (let i = 0; i < 4; i++) {
      const [ax, az] = corners[i], [bx, bz] = corners[(i + 1) % 4];
      batch.tube(steel, [ax * 1.1, H + rail, az * 1.1], [bx * 1.1, H + rail, bz * 1.1], 0.025, { segments: 5 });
    }
  }
  batch.box(black, 0.3, H + 1.25, 0.3, 0.45, 0.32, 0.25, -Math.PI / 4);
  for (const a of [0, 2.1, 4.2]) batch.tube(black, [0.3, H + 1.08, 0.3], [0.3 + Math.cos(a) * 0.35, H + 0.06, 0.3 + Math.sin(a) * 0.35], 0.015, { segments: 4 });
  batch.tube(materials.navy(), [-0.4, H + 0.06, -0.3], [-0.4, H + 1.05, -0.3], 0.17, { segments: 8 });
  batch.place(standard('#c79a76', 0.7, 0), new THREE.SphereGeometry(0.11, 10, 8), -0.4, H + 1.2, -0.3);
  batch.place(materials.navy(), new THREE.SphereGeometry(0.12, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), -0.4, H + 1.24, -0.3);
  batch.clearFrame();
  batch.build(parent, { castShadow: true });
  shadows.add(x0, z0, 3.4, 3.4, { yaw: Math.PI / 4, strength: 0.45 });
}


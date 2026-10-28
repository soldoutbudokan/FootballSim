// Things the athletes layer draws besides the bodies: jersey numbers, the
// practice ball, the control indicator and soft contact shadows.
import * as THREE from '../../vendor/three.module.js';
import { mergeGeometries } from '../../vendor/BufferGeometryUtils.js';

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

// ---- jersey numbers -------------------------------------------------------

// One texture holding every player's number (cells of 128 x 128) in their
// team's number colour, so all plates share one material.
export class NumberAtlas {
  constructor(entries) {
    // entries: [{key, number, color}]
    this.columns = 8;
    this.rows = Math.max(1, Math.ceil(entries.length / this.columns));
    const cell = 128;
    const c = canvas(this.columns * cell, this.rows * cell);
    const g = c.getContext('2d');
    g.textAlign = 'center'; g.textBaseline = 'middle';
    this.cells = new Map();
    entries.forEach((e, i) => {
      const col = i % this.columns, row = Math.floor(i / this.columns);
      const x = col * cell + cell / 2, y = row * cell + cell / 2 + 4;
      g.font = `800 ${String(e.number).length > 1 ? 96 : 104}px "Barlow Condensed", "Arial Narrow", Arial, sans-serif`;
      // Thin outline in the opposite tone, like tackle-twill numbers.
      g.lineWidth = 5; g.strokeStyle = 'rgba(0,0,0,0.18)'; g.strokeText(String(e.number), x, y);
      g.fillStyle = e.color; g.fillText(String(e.number), x, y);
      this.cells.set(e.key, { u0: col / this.columns, v0: 1 - (row + 1) / this.rows, u1: (col + 1) / this.columns, v1: 1 - row / this.rows });
    });
    this.texture = new THREE.CanvasTexture(c);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;
    this.material = new THREE.MeshStandardMaterial({
      map: this.texture, transparent: false, alphaTest: 0.45, side: THREE.DoubleSide, roughness: 0.8,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
  }

  // Front and back plates for one player, in character space.
  //   placement: {front: {y, z, width, height}, back: {...}}
  plates(key, placement) {
    const cell = this.cells.get(key);
    const quads = [];
    for (const side of ['front', 'back']) {
      const p = placement[side];
      const q = new THREE.PlaneGeometry(p.width, p.height);
      const uv = q.attributes.uv;
      for (let i = 0; i < uv.count; i++) {
        uv.setXY(i, uv.getX(i) ? cell.u1 : cell.u0, uv.getY(i) ? cell.v1 : cell.v0);
      }
      // Front faces +z (a reader in front sees it unmirrored); back faces -z.
      if (side === 'back') q.rotateY(Math.PI);
      q.translate(0, p.y, p.z);
      quads.push(q);
    }
    return mergeGeometries(quads);
  }
}

// Where the numbers sit on the torso, measured from the rest-pose vertices
// (character space): the chest's front and back surfaces at number height.
export function numberPlacement(vertices, joints) {
  const chest = joints.Spine2 || joints.Spine1 || joints.Spine;
  const neck = joints.Neck || [0, chest[1] + 0.2, 0];
  const hips = joints.Hips;
  const top = neck[1] - 0.06, bottom = hips[1] + (neck[1] - hips[1]) * 0.42;
  const frontY = bottom + (top - bottom) * 0.48, backY = bottom + (top - bottom) * 0.58;
  const surface = (y, sign) => {
    let best = sign > 0 ? -Infinity : Infinity;
    for (const data of vertices.values()) {
      for (let i = 0; i < data.length; i += 3) {
        if (Math.abs(data[i]) > 0.07 || Math.abs(data[i + 1] - y) > 0.05) continue;
        const z = data[i + 2];
        if (sign > 0 ? z > best : z < best) best = z;
      }
    }
    return Number.isFinite(best) ? best : chest[2] + sign * 0.14;
  };
  const span = top - bottom;
  return {
    front: { y: frontY, z: surface(frontY, 1) + 0.012, width: span * 0.62, height: span * 0.5 },
    back: { y: backY, z: surface(backY, -1) - 0.012, width: span * 0.78, height: span * 0.62 },
  };
}

// ---- the ball ---------------------------------------------------------------

// A practice ball: prolate spheroid (11 in long, 6.7 in across, drawn ~15 %
// larger so it reads at game-camera distance) with laces and the two white
// stripes; one merged mesh with vertex colours. Its long axis is local +z.
export function makeBall() {
  const length = 0.305 * 1.15, radius = 0.093 * 1.15;
  const points = [];
  const n = 24;
  for (let i = 0; i <= n; i++) {
    const t = -1 + (2 * i) / n;                    // -1..1 along the axis
    const r = radius * Math.pow(Math.max(0, 1 - t * t), 0.62);
    points.push(new THREE.Vector2(Math.max(r, 0.004), (t * length) / 2));
  }
  const body = new THREE.LatheGeometry(points, 28);
  const colors = [];
  const leather = new THREE.Color('#6b3b22'), stripe = new THREE.Color('#f2efe6');
  const pos = body.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const t = Math.abs(pos.getY(i)) / (length / 2);
    const c = t > 0.58 && t < 0.72 ? stripe : leather;
    colors.push(c.r, c.g, c.b);
  }
  body.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  const laceColor = new THREE.Color('#f4f1e8');
  const paint = (g, color) => {
    const a = [];
    for (let i = 0; i < g.attributes.position.count; i++) a.push(color.r, color.g, color.b);
    g.setAttribute('color', new THREE.Float32BufferAttribute(a, 3));
    g.deleteAttribute('uv');
    return g;
  };
  body.deleteAttribute('uv');
  const parts = [body];
  const spine = new THREE.BoxGeometry(0.012, 0.11, 0.012);
  spine.translate(0, 0, radius * 0.995);
  parts.push(paint(spine, laceColor));
  for (let i = 0; i < 8; i++) {
    const stitch = new THREE.BoxGeometry(0.034, 0.007, 0.01);
    stitch.translate(0, -0.05 + i * 0.0143, radius * 0.99);
    parts.push(paint(stitch, laceColor));
  }
  const geometry = mergeGeometries(parts);
  geometry.rotateX(-Math.PI / 2);                   // lathe axis y -> z; laces on top (+y)
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.62 }));
  mesh.castShadow = true;
  mesh.name = 'football';
  mesh.userData.radius = radius;
  mesh.userData.length = length;
  return mesh;
}

// ---- control indicator ------------------------------------------------------

// A thin silver ring with a short pointer arc in the facing direction.
export function makeRing() {
  const group = new THREE.Group();
  const material = new THREE.MeshBasicMaterial({ color: '#d4d8dd', transparent: true, opacity: 0.72, depthWrite: false, side: THREE.DoubleSide });
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.58, 0.63, 56), material);
  const arc = new THREE.Mesh(new THREE.RingGeometry(0.66, 0.74, 24, 1, Math.PI / 2 - 0.42, 0.84), material);
  for (const m of [ring, arc]) { m.rotation.x = -Math.PI / 2; m.renderOrder = 2; group.add(m); }
  group.name = 'control-ring';
  return group;
}

// ---- contact shadows ----------------------------------------------------------

export function makeContactShadows(count) {
  const c = canvas(64, 64);
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 2, 32, 32, 31);
  grad.addColorStop(0, 'rgba(0,0,0,.85)');
  grad.addColorStop(0.55, 'rgba(0,0,0,.35)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad; g.fillRect(0, 0, 64, 64);
  const texture = new THREE.CanvasTexture(c);
  const mesh = new THREE.InstancedMesh(
    new THREE.PlaneGeometry(1.25, 1.0),
    new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, opacity: 0.45 }),
    count,
  );
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.frustumCulled = false;
  mesh.renderOrder = 1;
  mesh.name = 'contact-shadows';
  return mesh;
}

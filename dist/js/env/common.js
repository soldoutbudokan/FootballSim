import * as THREE from '../../vendor/three.module.js';
import { seededRandom } from '../sim.js';

// Shared helpers for the static environment. Scene units are yards. Every
// builder in dist/js/env works in SCENE coordinates: x is the same as the
// simulation's x, y is up, and scene z is the NEGATED simulation z, so
// "downfield"/north is -z. Use sceneZ() when converting a simulation yard line.

export const sceneZ = simZ => -simZ;

// Field geometry (NFL): 53 1/3 yd wide, 120 yd long including both end zones.
export const FIELD = {
  width: 53.333333,
  halfWidth: 26.666667,
  length: 120,
  border: 2,                 // 6 ft solid white border outside sidelines and end lines
  hashX: 3.083333,           // 70 ft 9 in from each sideline
  secondFieldX: 63.333333,   // second practice field, 10 yd sideline-to-sideline gap
};

// Seeded random number generators keep the facility identical every visit.
export const makeRandom = seed => seededRandom(seed);

const materialCache = new Map();

// Cached MeshStandardMaterial so identical props share one material (and can
// share one merged draw call).
export function standard(color, roughness = 0.75, metalness = 0, extra = {}) {
  const key = JSON.stringify([color, roughness, metalness, extra]);
  if (!materialCache.has(key)) {
    materialCache.set(key, new THREE.MeshStandardMaterial({ color, roughness, metalness, ...extra }));
  }
  return materialCache.get(key);
}

export function canvasTexture(width, height, draw, { srgb = true } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  draw(canvas.getContext('2d'), width, height);
  const texture = new THREE.CanvasTexture(canvas);
  if (srgb) texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

// ---------------------------------------------------------------------------
// Noise

// Tileable 2D value noise with smooth interpolation. `period` is the lattice
// size in cells; coordinates are in cells.
function latticeNoise(random, period) {
  const values = new Float32Array(period * period);
  for (let i = 0; i < values.length; i++) values[i] = random();
  return (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const fx = x - xi, fy = y - yi;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const at = (i, j) => values[((j % period + period) % period) * period + ((i % period + period) % period)];
    const a = at(xi, yi), b = at(xi + 1, yi), c = at(xi, yi + 1), d = at(xi + 1, yi + 1);
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
  };
}

// Fractal noise in 0..1 that tiles every `period` units.
export function makeFbm(seed, period = 8, octaves = 4) {
  const random = makeRandom(seed);
  const layers = [];
  for (let o = 0; o < octaves; o++) layers.push(latticeNoise(random, period << o));
  return (x, y) => {
    let sum = 0, amp = 0.5, total = 0;
    for (let o = 0; o < octaves; o++) {
      const f = 1 << o;
      sum += layers[o](x * f, y * f) * amp;
      total += amp;
      amp *= 0.5;
    }
    return sum / total;
  };
}

// Single-channel tileable fractal-noise texture, normalised to the full 0..1 range.
export function noiseTexture(size, seed, period = 8, octaves = 5) {
  const fbm = makeFbm(seed, period, octaves);
  const values = new Float32Array(size * size);
  let lo = Infinity, hi = -Infinity;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const v = fbm(x / size * period, y / size * period);
      values[y * size + x] = v;
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
  }
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < values.length; i++) {
    const v = Math.round((values[i] - lo) / (hi - lo) * 255);
    data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = v;
    data[i * 4 + 3] = 255;
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

// ---------------------------------------------------------------------------
// Static geometry batching

const unitBox = new THREE.BoxGeometry(1, 1, 1);
const cylinderCache = new Map();
function unitCylinder(segments, topRatio) {
  const key = segments + ':' + topRatio;
  if (!cylinderCache.has(key)) {
    const g = new THREE.CylinderGeometry(topRatio, 1, 1, segments, 1);
    cylinderCache.set(key, g);
  }
  return cylinderCache.get(key);
}

const UP = new THREE.Vector3(0, 1, 0);
const tmp = { v: new THREE.Vector3(), n: new THREE.Vector3(), m: new THREE.Matrix4(), nm: new THREE.Matrix3(), q: new THREE.Quaternion(), s: new THREE.Vector3(), p: new THREE.Vector3() };

// Merges indexed or non-indexed geometries (position, normal, uv; optional
// per-part vertex colour) after applying each part's matrix.
export function mergeGeometries(parts, withColor = false) {
  let vertexCount = 0, indexCount = 0;
  for (const part of parts) {
    const count = part.geometry.attributes.position.count;
    vertexCount += count;
    indexCount += part.geometry.index ? part.geometry.index.count : count;
  }
  const position = new Float32Array(vertexCount * 3);
  const normal = new Float32Array(vertexCount * 3);
  const uv = new Float32Array(vertexCount * 2);
  const color = withColor ? new Float32Array(vertexCount * 3) : null;
  const index = vertexCount > 65535 ? new Uint32Array(indexCount) : new Uint16Array(indexCount);
  let vo = 0, io = 0;
  for (const part of parts) {
    const g = part.geometry, pos = g.attributes.position, nor = g.attributes.normal, tex = g.attributes.uv;
    tmp.nm.getNormalMatrix(part.matrix);
    for (let i = 0; i < pos.count; i++) {
      const o3 = (vo + i) * 3;
      tmp.v.fromBufferAttribute(pos, i).applyMatrix4(part.matrix);
      position[o3] = tmp.v.x; position[o3 + 1] = tmp.v.y; position[o3 + 2] = tmp.v.z;
      if (nor) {
        tmp.n.fromBufferAttribute(nor, i).applyMatrix3(tmp.nm).normalize();
        normal[o3] = tmp.n.x; normal[o3 + 1] = tmp.n.y; normal[o3 + 2] = tmp.n.z;
      }
      if (tex) { uv[(vo + i) * 2] = tex.getX(i); uv[(vo + i) * 2 + 1] = tex.getY(i); }
      if (color) {
        const c = part.color || WHITE;
        color[o3] = c.r; color[o3 + 1] = c.g; color[o3 + 2] = c.b;
      }
    }
    if (g.index) {
      for (let i = 0; i < g.index.count; i++) index[io + i] = g.index.getX(i) + vo;
      io += g.index.count;
    } else {
      for (let i = 0; i < pos.count; i++) index[io + i] = vo + i;
      io += pos.count;
    }
    vo += pos.count;
  }
  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(position, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  merged.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  if (color) merged.setAttribute('color', new THREE.BufferAttribute(color, 3));
  merged.setIndex(new THREE.BufferAttribute(index, 1));
  merged.computeBoundingSphere();
  merged.computeBoundingBox();
  return merged;
}
const WHITE = new THREE.Color(1, 1, 1);

// Collects static parts per material and merges them into one mesh per
// material. Use one batch per spatial cluster (a goal post, the bleacher, a
// fence side) so frustum and shadow-camera culling still work.
export class StaticBatch {
  constructor(name = 'props') {
    this.name = name;
    this.groups = new Map();
    this.frame = null;
  }

  // Subsequent parts are given in a local frame placed at (x, y, z) and
  // rotated by `yaw` about the vertical axis. Local +x maps to world
  // (cos yaw, 0, -sin yaw).
  setFrame(x, y, z, yaw = 0) {
    this.frame = new THREE.Matrix4().compose(
      new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromAxisAngle(UP, yaw), new THREE.Vector3(1, 1, 1));
    return this;
  }

  clearFrame() {
    this.frame = null;
    return this;
  }

  add(material, geometry, matrix, color = null) {
    if (!this.groups.has(material)) this.groups.set(material, []);
    const world = this.frame ? this.frame.clone().multiply(matrix) : matrix.clone();
    this.groups.get(material).push({ geometry, matrix: world, color });
    return this;
  }

  // Axis-aligned (optionally yawed) box centred at (x, y, z), scene coordinates.
  box(material, x, y, z, w, h, d, yaw = 0, color = null) {
    tmp.q.setFromAxisAngle(UP, yaw);
    tmp.m.compose(tmp.p.set(x, y, z), tmp.q, tmp.s.set(w, h, d));
    return this.add(material, unitBox, tmp.m, color);
  }

  // Box whose bottom sits at y.
  block(material, x, y, z, w, h, d, yaw = 0, color = null) {
    return this.box(material, x, y + h / 2, z, w, h, d, yaw, color);
  }

  // Cylinder (optionally tapered) from point a to point b.
  tube(material, a, b, radius, { top = radius, segments = 10, color = null } = {}) {
    const start = new THREE.Vector3(...a), end = new THREE.Vector3(...b);
    const delta = end.clone().sub(start), length = delta.length();
    if (length < 1e-5) return this;
    tmp.q.setFromUnitVectors(UP, delta.normalize());
    tmp.m.compose(start.clone().add(end).multiplyScalar(0.5), tmp.q, tmp.s.set(radius, length, radius));
    return this.add(material, unitCylinder(segments, Math.round(top / radius * 1000) / 1000), tmp.m, color);
  }

  // Any geometry placed with position / yaw / scale.
  place(material, geometry, x, y, z, { yaw = 0, pitch = 0, roll = 0, scale = 1, color = null } = {}) {
    tmp.q.setFromEuler(new THREE.Euler(pitch, yaw, roll, 'YXZ'));
    const s = typeof scale === 'number' ? tmp.s.set(scale, scale, scale) : tmp.s.set(...scale);
    tmp.m.compose(tmp.p.set(x, y, z), tmp.q, s);
    return this.add(material, geometry, tmp.m, color);
  }

  build(parent, { castShadow = true, receiveShadow = true, vertexColors = false } = {}) {
    const meshes = [];
    for (const [material, parts] of this.groups) {
      const mesh = new THREE.Mesh(mergeGeometries(parts, vertexColors), material);
      mesh.name = this.name;
      mesh.castShadow = castShadow;
      mesh.receiveShadow = receiveShadow;
      mesh.matrixAutoUpdate = false;
      parent.add(mesh);
      meshes.push(mesh);
    }
    this.groups.clear();
    return meshes;
  }
}

// Double-sided cards (leaves, grass tufts) carry hand-made normals; three.js
// would flip them on back faces, which turns half the cards black. This keeps
// the authored normal on both faces.
export const KEEP_NORMAL_FRAGMENT = '#include <normal_fragment_begin>\nnormal = normalize( vNormal );\nnonPerturbedNormal = normal;';

// Soft, dark ground decals ("contact AO") under props. One instanced mesh for
// the whole facility; each blob is an ellipse or rounded rectangle.
export class ContactShadows {
  constructor() {
    this.items = [];
  }

  add(x, z, width, depth, { yaw = 0, strength = 0.55 } = {}) {
    this.items.push({ x, z, width, depth, yaw, strength });
  }

  build(parent) {
    const texture = canvasTexture(128, 128, (c, w, h) => {
      const g = c.createRadialGradient(w / 2, h / 2, 4, w / 2, h / 2, w / 2);
      g.addColorStop(0, 'rgba(0,0,0,1)');
      g.addColorStop(0.55, 'rgba(0,0,0,0.6)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      c.fillStyle = g;
      c.fillRect(0, 0, w, h);
    }, { srgb: false });
    const material = new THREE.MeshBasicMaterial({
      color: '#000000', alphaMap: texture, transparent: true, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    const geometry = new THREE.PlaneGeometry(1, 1);
    geometry.rotateX(-Math.PI / 2);
    const mesh = new THREE.InstancedMesh(geometry, material, Math.max(1, this.items.length));
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), color = new THREE.Color();
    this.items.forEach((item, i) => {
      q.setFromAxisAngle(UP, item.yaw);
      m.compose(tmp.p.set(item.x, 0.012, item.z), q, tmp.s.set(item.width, 1, item.depth));
      mesh.setMatrixAt(i, m);
      // The instance colour carries the blob's strength; the shader below
      // turns it into opacity and keeps the blob black.
      mesh.setColorAt(i, color.setScalar(item.strength));
    });
    material.onBeforeCompile = shader => {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <alphamap_fragment>',
        '#include <alphamap_fragment>\n#ifdef USE_COLOR\n diffuseColor.a *= vColor.r;\n diffuseColor.rgb = vec3(0.0);\n#endif',
      );
    };
    mesh.count = this.items.length;
    mesh.frustumCulled = false;
    mesh.renderOrder = -1;
    parent.add(mesh);
    return mesh;
  }
}

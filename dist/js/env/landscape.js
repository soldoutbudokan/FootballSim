import * as THREE from '../../vendor/three.module.js';
import { KEEP_NORMAL_FRAGMENT, StaticBatch, canvasTexture, makeFbm, makeRandom, mergeGeometries, sceneZ, standard } from './common.js';
import { LAYOUT } from './facility.js';

// Everything beyond the fence: trees, gentle terrain, a distant tree line,
// a parking lot and a few low buildings on the horizon. No city skyline.

export const GROUND_CENTER = { x: 18, z: 60 };   // simulation coordinates
export const GROUND_RADIUS = 232;

// ---------------------------------------------------------------------------
// Trees. Broadleaf crowns are a few overlapping lobes, each a shell of crossed
// leaf-clump cards; conifers are three crossed cards carrying a painted spruce.
// Normals are rounded (they point away from the crown) so a tree lights as one
// volume, vertex colours carry the tint and the darkness inside the crown, and
// the shader adds the glow of sunlight coming through the leaves.

// One atlas: four leaf clumps on the left (2 x 2), two spruces on the right.
const ATLAS = { width: 1024, height: 512 };
const CLUMP_UV = [[0, 0], [0.25, 0], [0, 0.5], [0.25, 0.5]].map(([u, v]) => ({ u0: u, v0: v, u1: u + 0.25, v1: v + 0.5 }));
const SPRUCE_UV = [{ u0: 0.5, v0: 0, u1: 0.75, v1: 1 }, { u0: 0.75, v0: 0, u1: 1, v1: 1 }];
const LEAF_MEAN = [96, 128, 62];   // sRGB; also what transparent texels are filled with

function drawClump(c, random, x0, y0, size) {
  // Sub-clusters of leaves with gaps between them, sparser toward the rim.
  const clusters = 13 + Math.floor(random() * 5);
  for (let k = 0; k < clusters; k++) {
    const a = random() * Math.PI * 2, r = Math.sqrt(random()) * size * 0.33;
    const cx = x0 + size / 2 + Math.cos(a) * r, cy = y0 + size / 2 + Math.sin(a) * r * 0.92;
    const spread = size * (0.07 + random() * 0.05), leaves = 70 + Math.floor(random() * 50);
    const tone = 0.8 + random() * 0.3;
    for (let i = 0; i < leaves; i++) {
      const la = random() * Math.PI * 2, lr = Math.sqrt(-2 * Math.log(1 - random() * 0.98)) * spread * 0.62;
      const x = cx + Math.cos(la) * lr, y = cy + Math.sin(la) * lr;
      if (Math.hypot(x - x0 - size / 2, y - y0 - size / 2) > size * 0.47) continue;
      // Lit from above: leaves high in a sub-cluster are lighter.
      const lit = (0.74 + 0.18 * (cy - y) / spread + (random() - 0.5) * 0.3) * tone;
      const v = Math.max(0.42, Math.min(1.3, lit));
      c.fillStyle = `rgb(${Math.round(LEAF_MEAN[0] * v)},${Math.round(LEAF_MEAN[1] * v)},${Math.round(LEAF_MEAN[2] * v * (0.9 + random() * 0.2))})`;
      c.beginPath();
      c.ellipse(x, y, size * (0.012 + random() * 0.016), size * (0.007 + random() * 0.008), random() * Math.PI, 0, Math.PI * 2);
      c.fill();
    }
  }
}

function drawSpruce(c, random, x0, y0, w, h) {
  const cx = x0 + w / 2, top = y0 + h * 0.02, bottom = y0 + h * 0.97;
  const tiers = 15;
  for (let i = 0; i < tiers; i++) {
    const t = i / (tiers - 1);
    const y = top + (bottom - top) * (0.03 + 0.83 * t);
    const half = w * 0.46 * Math.pow(0.08 + 0.92 * t, 0.85) * (0.82 + random() * 0.26);
    const drop = h * (0.06 + 0.05 * t);
    // A tier: boughs fanning out and drooping, each a spray of needle strokes.
    const boughs = 5 + Math.floor(t * 7);
    for (let k = 0; k < boughs; k++) {
      const side = (k / (boughs - 1)) * 2 - 1;
      const bx = cx + side * half * (0.9 + random() * 0.15), by = y + drop * (0.25 + 0.75 * Math.abs(side)) + (random() - 0.5) * drop * 0.3;
      const v = 0.52 + 0.5 * (1 - Math.abs(side) * 0.3) * (0.75 + random() * 0.4) - 0.14 * t;
      for (let n = 0; n < 24; n++) {
        const u = random(), px = cx + (bx - cx) * u, py = y + (by - y) * u * u;
        const tone = Math.max(0.36, v * (0.7 + 0.5 * u));
        c.strokeStyle = `rgb(${Math.round(50 * tone)},${Math.round(80 * tone)},${Math.round(46 * tone)})`;
        c.lineWidth = w * (0.012 + random() * 0.012);
        c.beginPath();
        c.moveTo(px, py);
        c.lineTo(px + side * w * 0.035 + (random() - 0.5) * w * 0.05, py + h * (0.012 + random() * 0.03));
        c.stroke();
      }
    }
  }
}

function leafAtlas() {
  const random = makeRandom(5511);
  const canvas = document.createElement('canvas');
  canvas.width = ATLAS.width;
  canvas.height = ATLAS.height;
  const c = canvas.getContext('2d', { willReadFrequently: true });
  for (const [i, j] of [[0, 0], [1, 0], [0, 1], [1, 1]]) drawClump(c, random, i * 256, j * 256, 256);
  drawSpruce(c, random, 512, 0, 256, 512);
  drawSpruce(c, random, 768, 0, 256, 512);
  // Transparent texels are black in a canvas; filtered and mip-mapped, that
  // black bleeds into every leaf edge as a dark outline. Give them the mean
  // leaf colour instead (alpha stays 0).
  const image = c.getImageData(0, 0, ATLAS.width, ATLAS.height), data = image.data;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 8) { data[i] = LEAF_MEAN[0]; data[i + 1] = LEAF_MEAN[1]; data[i + 2] = LEAF_MEAN[2]; data[i + 3] = 0; }
  }
  const texture = new THREE.DataTexture(new Uint8Array(data.buffer), ATLAS.width, ATLAS.height, THREE.RGBAFormat);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.flipY = false;   // canvas rows run top to bottom: v = 0 is the top of the atlas
  texture.needsUpdate = true;
  return texture;
}

// A unit card (x and y in -0.5..0.5) showing one atlas cell; v runs down the image.
function atlasCard(cell) {
  const card = new THREE.PlaneGeometry(1, 1);
  const uv = card.attributes.uv;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, cell.u0 + uv.getX(i) * (cell.u1 - cell.u0), cell.v0 + (1 - uv.getY(i)) * (cell.v1 - cell.v0));
  }
  return card;
}

const Y_AXIS = new THREE.Vector3(0, 1, 0);

function treeGeometry(random, tint, cards) {
  const parts = [];
  const conifer = random() < 0.2;
  const height = conifer ? 10 + random() * 10 : 7 + random() * 10;
  const trunkTop = height * (conifer ? 0.3 : 0.42);
  const trunk = new THREE.CylinderGeometry(0.14, 0.27, trunkTop, 6, 1, true);
  trunk.translate(0, trunkTop / 2, 0);
  parts.push({ geometry: trunk, matrix: new THREE.Matrix4(), color: new THREE.Color('#3f372e') });
  const crown = [];   // per card: the centre its normals point away from
  if (conifer) {
    const card = cards.spruce[Math.floor(random() * cards.spruce.length)];
    const width = height * (0.36 + random() * 0.1), tall = height * 0.94, yaw = random() * Math.PI;
    const dark = tint.clone().multiply(new THREE.Color(0.8, 0.9, 0.95));
    for (let k = 0; k < 3; k++) {
      const m = new THREE.Matrix4().compose(
        new THREE.Vector3(0, height - tall / 2, 0),
        new THREE.Quaternion().setFromAxisAngle(Y_AXIS, yaw + k * Math.PI / 3),
        new THREE.Vector3(width, tall, 1));
      parts.push({ geometry: card, matrix: m, color: dark });
      crown.push({ centre: new THREE.Vector3(0, height * 0.45, 0), flatten: 0.25, lift: 0.5 });
    }
  } else {
    // Two to four lobes: a main crown and smaller ones pushed out to the sides.
    const radius = height * (0.3 + random() * 0.07);
    const main = new THREE.Vector3(0, height * 0.62, 0);
    const lobes = [{ centre: main, radius }];
    const extra = 1 + Math.floor(random() * 3);
    for (let i = 0; i < extra; i++) {
      const a = random() * Math.PI * 2, r = radius * (0.55 + random() * 0.35);
      lobes.push({
        centre: new THREE.Vector3(Math.cos(a) * r, height * (0.44 + random() * 0.24), Math.sin(a) * r),
        radius: radius * (0.55 + random() * 0.25),
      });
    }
    for (const lobe of lobes) {
      const clumps = Math.max(3, Math.round(7 * lobe.radius / radius));
      for (let i = 0; i < clumps; i++) {
        // On the lobe's shell, more of them on the upper half.
        const a = random() * Math.PI * 2, e = Math.asin(Math.min(1, random() * 1.4 - 0.4));
        const shell = lobe.radius * (0.45 + random() * 0.35);
        const position = lobe.centre.clone().add(new THREE.Vector3(Math.cos(a) * Math.cos(e) * shell, Math.sin(e) * shell * 0.8, Math.sin(a) * Math.cos(e) * shell));
        const size = lobe.radius * (1.0 + random() * 0.5);
        const yaw = random() * Math.PI;
        // Darker inside and underneath, lighter on top and outside.
        const outward = position.clone().sub(main).length() / (radius * 1.6);
        const up = (position.y - main.y + radius) / (2 * radius);
        const shade = (0.62 + 0.28 * Math.min(1, outward) + 0.3 * Math.max(0, Math.min(1, up))) * (0.92 + random() * 0.16);
        for (const turn of [0, Math.PI / 2]) {
          const card = cards.clump[Math.floor(random() * cards.clump.length)];
          const m = new THREE.Matrix4().compose(position, new THREE.Quaternion().setFromAxisAngle(Y_AXIS, yaw + turn), new THREE.Vector3(size, size, size));
          parts.push({ geometry: card, matrix: m, color: tint.clone().multiplyScalar(shade) });
          crown.push({ centre: main, flatten: 0.55, lift: 0.55 });
        }
      }
    }
  }
  const merged = mergeGeometries(parts, true);
  // Rounded normals: point away from the crown centre (tilted up) so each tree
  // shades as one volume instead of as flat cards.
  const pos = merged.attributes.position, nor = merged.attributes.normal;
  const v = new THREE.Vector3();
  let offset = trunk.attributes.position.count;
  for (const group of crown) {
    for (let i = offset; i < offset + 4; i++) {
      v.fromBufferAttribute(pos, i).sub(group.centre).normalize();
      v.y = v.y * group.flatten + group.lift;
      v.normalize();
      nor.setXYZ(i, v.x, v.y, v.z);
    }
    offset += 4;
  }
  return merged;
}

// Positions of trees (simulation coordinates) in belts around the facility.
function treeSites(random) {
  const sites = [];
  const F = LAYOUT.fence;
  // Trees grow in clumps: pick clump centres in the belt, then scatter around them.
  const belt = (x0, x1, z0, z1, count, scale = 1) => {
    let placed = 0;
    while (placed < count) {
      const cx = x0 + random() * (x1 - x0), cz = z0 + random() * (z1 - z0);
      const clump = 3 + Math.floor(random() * 9);
      for (let k = 0; k < clump && placed < count; k++, placed++) {
        sites.push({ x: cx + (random() - 0.5) * 18, z: cz + (random() - 0.5) * 13, scale });
      }
    }
  };
  belt(-150, 190, F.north + 8, F.north + 60, 330);     // behind the far end zone
  belt(F.west - 80, F.west - 10, -80, F.north + 30, 190); // west
  belt(F.east + 12, F.east + 70, -30, F.north + 30, 170); // east, beyond the second field
  belt(-70, 45, -78, -50, 70, 1.35);                   // tall trees right behind the team building
  belt(-130, 36, -110, -52, 80);                       // behind the team building
  belt(108, 190, -110, -50, 50);
  // Shuffle so that any prefix (lower graphics tiers) is spread evenly.
  for (let i = sites.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [sites[i], sites[j]] = [sites[j], sites[i]];
  }
  return sites;
}

export function buildTrees(parent) {
  const random = makeRandom(8123);
  const templates = [];
  const tints = ['#a9bd86', '#93ae7c', '#bcc78a', '#839c74', '#c8cc8c', '#9bb583', '#beb87c', '#8ea57f'].map(c => new THREE.Color(c));
  const cards = { clump: CLUMP_UV.map(atlasCard), spruce: SPRUCE_UV.map(atlasCard) };
  for (let i = 0; i < 20; i++) templates.push(treeGeometry(random, tints[i % tints.length], cards));
  const sites = treeSites(random);
  const parts = [], ranges = [];
  let indexCount = 0;
  for (const site of sites) {
    const template = templates[Math.floor(random() * templates.length)];
    const scale = (0.85 + random() * 0.35) * site.scale;
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(site.x, 0, sceneZ(site.z)),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), random() * Math.PI * 2),
      new THREE.Vector3(scale, scale * (0.9 + random() * 0.2), scale));
    parts.push({ geometry: template, matrix: m });
    indexCount += template.index.count;
    ranges.push(indexCount);
  }
  const geometry = mergeGeometriesWithColor(parts);
  const material = new THREE.MeshStandardMaterial({
    map: leafAtlas(), vertexColors: true, roughness: 0.82, metalness: 0,
    alphaTest: 0.42, alphaToCoverage: true, side: THREE.DoubleSide,
  });
  // Sunlight through the canopy: looking toward the sun, leaves glow yellow-green.
  const uniforms = { treeSun: { value: new THREE.Vector3(0, 1, 0) }, treeSunColor: { value: new THREE.Color(0, 0, 0) } };
  material.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, uniforms);
    shader.fragmentShader = 'uniform vec3 treeSun;\nuniform vec3 treeSunColor;\n' + shader.fragmentShader
      .replace('#include <normal_fragment_begin>', KEEP_NORMAL_FRAGMENT)
      // Distant cards would thin out as the mip-mapped alpha drops under the
      // cut-off: firm the alpha up with distance.
      .replace('#include <alphatest_fragment>', '#ifdef USE_FOG\n diffuseColor.a *= 1.0 + 0.012 * min(vFogDepth, 300.0);\n#endif\n#include <alphatest_fragment>')
      .replace('#include <lights_fragment_end>', /* glsl */`#include <lights_fragment_end>
        vec3 treeSunView = normalize((viewMatrix * vec4(treeSun, 0.0)).xyz);
        float treeThrough = pow(clamp(dot(-geometryViewDir, treeSunView), 0.0, 1.0), 2.0);
        // ... and a little of it is scattered around inside every crown, so
        // the side away from the sun is dim green, not black.
        reflectedLight.directDiffuse += diffuseColor.rgb * vec3(1.15, 1.05, 0.45) * treeSunColor * (treeThrough * 0.11 + 0.03);`);
  };
  material.customProgramCacheKey = () => 'trees-v3';
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'trees';
  mesh.matrixAutoUpdate = false;
  parent.add(mesh);
  return {
    mesh,
    setCount(fraction) { geometry.setDrawRange(0, ranges[Math.max(0, Math.round(ranges.length * fraction) - 1)]); },
    // World-space direction to the sun and its colour x intensity (linear).
    setSun(direction, color, intensity) {
      uniforms.treeSun.value.copy(direction);
      uniforms.treeSunColor.value.copy(color).multiplyScalar(intensity);
    },
  };
}

// mergeGeometries keeps per-part colours only through `part.color`; tree
// templates already carry a colour attribute, so copy it through here.
function mergeGeometriesWithColor(parts) {
  const merged = mergeGeometries(parts.map(p => ({ geometry: p.geometry, matrix: p.matrix })), true);
  const color = merged.attributes.color;
  let offset = 0;
  for (const part of parts) {
    const src = part.geometry.attributes.color;
    for (let i = 0; i < src.count; i++) color.setXYZ(offset + i, src.getX(i), src.getY(i), src.getZ(i));
    offset += src.count;
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Terrain and the distant tree line

export function buildTerrain(parent) {
  const fbm = makeFbm(6021, 8, 5);
  const geometry = new THREE.RingGeometry(GROUND_RADIUS - 6, 1100, 180, 28);
  geometry.rotateX(-Math.PI / 2);
  const pos = geometry.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const field = new THREE.Color(), a = new THREE.Color('#5d7440'), b = new THREE.Color('#7b8a4d'), c = new THREE.Color('#3f5a33');
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i), r = Math.hypot(x, z);
    const n = fbm((x + 2000) / 260, (z + 2000) / 260);
    const rise = THREE.MathUtils.smoothstep(r, GROUND_RADIUS + 8, 620);
    const y = r < GROUND_RADIUS ? -0.35 : rise * (6 + 30 * n) + (n - 0.5) * 2 * Math.min(1, (r - GROUND_RADIUS) / 30);
    pos.setY(i, y);
    const patch = fbm((x + 900) / 70, (z + 300) / 70);
    field.copy(a).lerp(patch > 0.55 ? b : c, Math.abs(patch - 0.5) * 2);
    colors.set([field.r, field.g, field.b], i * 3);
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(GROUND_CENTER.x, 0, sceneZ(GROUND_CENTER.z));
  mesh.name = 'terrain';
  parent.add(mesh);
  return mesh;
}

function treeLineTexture() {
  const random = makeRandom(4412);
  return canvasTexture(2048, 256, (c, w, h) => {
    c.clearRect(0, 0, w, h);
    // Rows of crowns from back (higher, paler) to front (lower, darker). Each
    // crown is a core plus a ring of lobes so the canopy edge reads as foliage.
    const rows = [[0.5, 22, 0.86], [0.6, 20, 0.74], [0.7, 18, 0.64], [0.8, 16, 0.56]];
    for (const [rowY, size, tone] of rows) {
      for (let x = -30; x < w + 30; x += size * (0.5 + random() * 0.6)) {
        const conifer = random() < 0.25;
        const r = size * (0.6 + random() * 0.8), top = h * rowY - random() * h * 0.2 - r;
        const t = tone * (0.85 + random() * 0.25);
        const light = `rgb(${Math.round(104 * t)},${Math.round(128 * t)},${Math.round(84 * t)})`;
        const dark = `rgb(${Math.round(50 * t)},${Math.round(68 * t)},${Math.round(46 * t)})`;
        const g = c.createLinearGradient(0, top, 0, top + 2.4 * r);
        g.addColorStop(0, light);
        g.addColorStop(1, dark);
        c.fillStyle = g;
        c.beginPath();
        if (conifer) {
          c.moveTo(x, top - r * 0.8);
          for (let k = 0; k <= 6; k++) {
            const yy = top - r * 0.8 + k * r * 0.5, ww = r * 0.18 * (k + 1);
            c.lineTo(x + ww, yy); c.lineTo(x + ww * 0.55, yy);
          }
          c.lineTo(x - r * 0.7, top + r * 2.4);
          for (let k = 6; k >= 0; k--) {
            const yy = top - r * 0.8 + k * r * 0.5, ww = r * 0.18 * (k + 1);
            c.lineTo(x - ww * 0.55, yy); c.lineTo(x - ww, yy);
          }
          c.closePath();
          c.fill();
        } else {
          c.ellipse(x, top + r, r, r * 0.95, 0, 0, Math.PI * 2);
          c.fill();
          for (let k = 0; k < 11; k++) {
            const a = Math.PI * (1.05 + random() * 0.9), lr = r * (0.28 + random() * 0.25);
            c.beginPath();
            c.arc(x + Math.cos(a) * r * 0.9, top + r + Math.sin(a) * r * 0.85, lr, 0, Math.PI * 2);
            c.fill();
          }
        }
        c.fillRect(x - r, top + r, 2 * r, h - top - r);
      }
    }
  });
}

export function buildTreeLine(parent) {
  const texture = treeLineTexture();
  texture.wrapS = THREE.RepeatWrapping;
  texture.repeat.set(9, 1);
  const material = new THREE.MeshStandardMaterial({
    map: texture, roughness: 1, alphaTest: 0.5, alphaToCoverage: true, side: THREE.DoubleSide,
  });
  const group = new THREE.Group();
  group.name = 'tree-line';
  for (const [radius, height, y] of [[318, 34, -2], [470, 46, 6]]) {
    const geometry = new THREE.CylinderGeometry(radius, radius, height, 96, 1, true);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(GROUND_CENTER.x, y + height / 2, sceneZ(GROUND_CENTER.z));
    mesh.rotation.y = radius * 0.01;
    group.add(mesh);
  }
  parent.add(group);
  return group;
}

// ---------------------------------------------------------------------------
// Parking lot south-east of the building, and low buildings on the horizon

function stallTexture() {
  return canvasTexture(512, 256, (c, w, h) => {
    c.fillStyle = '#4a4c4e';
    c.fillRect(0, 0, w, h);
    const random = makeRandom(21);
    for (let i = 0; i < 3000; i++) {
      c.fillStyle = `rgba(${random() < 0.5 ? '0,0,0' : '255,255,255'},${random() * 0.05})`;
      c.fillRect(random() * w, random() * h, 2, 2);
    }
    c.fillStyle = '#d9d9d2';
    for (let x = 0; x <= w; x += w / 16) {
      c.fillRect(x, 4, 3, h * 0.36);
      c.fillRect(x, h * 0.6, 3, h * 0.36);
    }
  });
}

export function buildParking(parent, shadows) {
  const lot = { x0: 42, x1: 104, z0: -48, z1: -18 };
  const width = lot.x1 - lot.x0, depth = lot.z1 - lot.z0;
  const asphalt = new THREE.MeshStandardMaterial({ map: stallTexture(), roughness: 0.92 });
  asphalt.map.wrapS = THREE.RepeatWrapping;
  asphalt.map.repeat.set(width / 46, 1);
  const surface = new THREE.Mesh(new THREE.PlaneGeometry(width, depth).rotateX(-Math.PI / 2), asphalt);
  surface.position.set((lot.x0 + lot.x1) / 2, 0.02, sceneZ((lot.z0 + lot.z1) / 2));
  surface.receiveShadow = true;
  parent.add(surface);

  const random = makeRandom(707);
  const batch = new StaticBatch('cars');
  const paint = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.35, metalness: 0.6 });
  const glass = standard('#1b2126', 0.15, 0.8), rubber = standard('#121314', 0.9, 0);
  const colors = ['#e9eaea', '#c0c4c8', '#8b9096', '#2a2d31', '#1d2b44', '#bfb5a0', '#5a6065', '#f2f2ef'].map(c => new THREE.Color(c));
  const stallWidth = width / (asphalt.map.repeat.x * 16);
  for (const row of [0.18, 0.82]) {
    for (let i = 0; i < Math.floor(width / stallWidth); i++) {
      if (random() < 0.35) continue;
      const x = lot.x0 + (i + 0.5) * stallWidth, z = sceneZ(lot.z0 + depth * row);
      const facing = row < 0.5 ? 1 : -1;
      const color = colors[Math.floor(random() * colors.length)];
      batch.setFrame(x, 0, z + (random() - 0.5) * 0.3, (random() - 0.5) * 0.05);
      batch.box(paint, 0, 0.58, 0, 1.9, 0.62, 4.7, 0, color);
      batch.box(glass, 0, 1.15, 0.15 * facing, 1.7, 0.55, 2.5);
      batch.box(paint, 0, 1.44, 0.15 * facing, 1.62, 0.05, 2.3, 0, color);
      for (const [wx, wz] of [[-0.88, -1.5], [0.88, -1.5], [-0.88, 1.5], [0.88, 1.5]]) {
        batch.box(rubber, wx, 0.3, wz, 0.24, 0.6, 0.6);
      }
      batch.clearFrame();
      shadows.add(x, z, 2.3, 5.0, { strength: 0.55 });
    }
  }
  batch.build(parent, { castShadow: true, vertexColors: true });
  // Lot lights.
  const posts = new StaticBatch('lot-lights');
  for (const x of [52, 73, 94]) {
    const z = sceneZ(lot.z0 + depth / 2);
    posts.tube(standard('#6c7277', 0.5, 0.6), [x, 0, z], [x, 9, z], 0.11, { top: 0.08, segments: 8 });
    posts.box(standard('#2b3035', 0.5, 0.5), x, 9, z, 1.2, 0.18, 0.5);
  }
  posts.build(parent, { castShadow: false });
}

function officeTexture() {
  const random = makeRandom(66);
  return canvasTexture(256, 128, (c, w, h) => {
    c.fillStyle = '#8f9395';
    c.fillRect(0, 0, w, h);
    for (let f = 0; f < 4; f++) {
      c.fillStyle = '#364047';
      c.fillRect(0, 10 + f * 29, w, 16);
      for (let x = 0; x < w; x += 8) {
        if (random() < 0.3) { c.fillStyle = 'rgba(80,95,105,1)'; c.fillRect(x, 10 + f * 29, 7, 16); }
      }
    }
  });
}

export function buildHorizonBuildings(parent) {
  const batch = new StaticBatch('horizon');
  const office = new THREE.MeshStandardMaterial({ map: officeTexture(), roughness: 0.8, metalness: 0.1 });
  const plain = standard('#9a9c98', 0.9, 0), roof = standard('#6d706f', 0.9, 0);
  // [x, z (simulation), width, height, depth, yaw]
  const blocks = [[205, 300, 46, 12, 18, -0.5], [250, 230, 34, 9, 22, -0.9], [-215, 285, 40, 10, 16, 0.6], [120, 360, 60, 14, 20, -0.2]];
  for (const [x, z, w, h, d, yaw] of blocks) {
    batch.block(office, x, 0, sceneZ(z), w, h, d, yaw);
    batch.block(roof, x, h, sceneZ(z), w * 0.3, 1.5, d * 0.4, yaw);
  }
  // A water tower to the north-west.
  const wx = -160, wz = sceneZ(330);
  for (let i = 0; i < 6; i++) {
    const a = i / 6 * Math.PI * 2;
    batch.tube(plain, [wx + Math.cos(a) * 5, 0, wz + Math.sin(a) * 5], [wx + Math.cos(a) * 3.4, 30, wz + Math.sin(a) * 3.4], 0.35, { segments: 6 });
  }
  batch.place(plain, new THREE.SphereGeometry(7, 24, 12), wx, 34, wz, { scale: [1, 0.62, 1] });
  batch.tube(plain, [wx, 29, wz], [wx, 33, wz], 6.4, { segments: 24 });
  batch.build(parent, { castShadow: false, receiveShadow: false });
}

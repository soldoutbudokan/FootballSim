import * as THREE from '../../vendor/three.module.js';
import { FIELD, StaticBatch, canvasTexture, makeFbm, sceneZ, standard } from './common.js';

// The playing surfaces: one large natural-grass ground whose shader paints the
// NFL markings of both practice fields analytically (crisp at any distance),
// plus goal posts and pylons. No logos and no end-zone lettering.

// ---------------------------------------------------------------------------
// Field numbers

// Block numerals drawn on a 4 ft x 6 ft grid (units are feet, y down).
const STROKE = 1.0;
const DIGITS = {
  0(c) { roundedRect(c, 0.5, 0.5, 3, 5, 1.35); c.stroke(); },
  1(c) {
    c.beginPath();
    c.moveTo(1.55, 0); c.lineTo(2.85, 0); c.lineTo(2.85, 6); c.lineTo(1.85, 6); c.lineTo(1.85, 1.55);
    c.lineTo(0.7, 2.05); c.lineTo(0.7, 1.0); c.closePath(); c.fill();
  },
  2(c) {
    c.beginPath();
    c.arc(2, 1.95, 1.45, Math.PI * 1.04, Math.PI * 2.16);
    c.lineTo(0.55, 5.5); c.lineTo(4, 5.5); c.stroke();
  },
  3(c) {
    c.beginPath();
    c.arc(1.95, 1.72, 1.22, Math.PI * 1.08, Math.PI * 2.5);
    c.stroke();
    c.beginPath();
    c.arc(1.95, 4.2, 1.3, Math.PI * 1.5, Math.PI * 2.92);
    c.stroke();
  },
  4(c) {
    c.beginPath(); c.moveTo(3.0, 0); c.lineTo(3.0, 6); c.stroke();
    c.beginPath(); c.moveTo(3.05, 0.3); c.lineTo(0.5, 4.15); c.lineTo(4, 4.15); c.stroke();
  },
  5(c) {
    c.beginPath();
    c.moveTo(3.85, 0.5); c.lineTo(0.95, 0.5); c.lineTo(0.8, 2.85);
    c.arc(1.95, 3.95, 1.55, Math.PI * 1.3, Math.PI * 2.82);
    c.stroke();
  },
};
function roundedRect(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y); c.lineTo(x + w - r, y); c.arcTo(x + w, y, x + w, y + r, r);
  c.lineTo(x + w, y + h - r); c.arcTo(x + w, y + h, x + w - r, y + h, r);
  c.lineTo(x + r, y + h); c.arcTo(x, y + h, x, y + h - r, r);
  c.lineTo(x, y + r); c.arcTo(x, y, x + r, y, r); c.closePath();
}

// Atlas of the five yard numbers (10..50). Each block is two 4 ft digits with
// a gap for the yard line through the middle: 9.5 ft x 6 ft.
export const NUMBER_BLOCK = { widthFt: 9.5, heightFt: 6, gapFt: 1.5 };
const ATLAS = { cellW: 300, cellH: 200, scale: 28, cells: 5 };
function numberAtlas() {
  const texture = canvasTexture(ATLAS.cellW * ATLAS.cells, ATLAS.cellH, (c, w, h) => {
    c.clearRect(0, 0, w, h);
    c.fillStyle = c.strokeStyle = '#ffffff';
    c.lineWidth = STROKE;
    c.lineJoin = 'miter';
    c.lineCap = 'butt';
    const padX = (ATLAS.cellW - NUMBER_BLOCK.widthFt * ATLAS.scale) / 2;
    const padY = (ATLAS.cellH - NUMBER_BLOCK.heightFt * ATLAS.scale) / 2;
    for (let i = 0; i < ATLAS.cells; i++) {
      const tens = String(i + 1), offsets = [0, 4 + NUMBER_BLOCK.gapFt];
      [tens, '0'].forEach((digit, k) => {
        c.save();
        c.translate(i * ATLAS.cellW + padX + offsets[k] * ATLAS.scale, padY);
        c.scale(ATLAS.scale, ATLAS.scale);
        DIGITS[digit](c);
        c.restore();
      });
    }
  }, { srgb: false });
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.anisotropy = 8;
  return texture;
}

// ---------------------------------------------------------------------------
// Wear map: browner, thinner grass between the hashes, at the practice spots
// near the 25-40, in the goal mouths and along the team sideline. Domain is
// field-local x in [-32, 32], simulation z in [-6, 126].
export const WEAR_DOMAIN = { x0: -32, x1: 32, z0: -6, z1: 126 };
function wearTexture() {
  const w = 256, h = 528, data = new Uint8Array(w * h * 4);
  const patch = makeFbm(771, 6, 5), grain = makeFbm(1203, 32, 3), edge = makeFbm(415, 10, 3);
  const gauss = (v, c, s) => Math.exp(-(((v - c) / s) ** 2));
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const u = i / w, v = j / h;
      const x = WEAR_DOMAIN.x0 + (i + 0.5) / w * (WEAR_DOMAIN.x1 - WEAR_DOMAIN.x0);
      const z = WEAR_DOMAIN.z0 + (j + 0.5) / h * (WEAR_DOMAIN.z1 - WEAR_DOMAIN.z0);
      // Irregular zone edges: displace the distance from the middle with noise.
      const wobble = (edge(u * 10, v * 10 * 2.06) - 0.5) * 7;
      const between = 1 - smooth(1.5, 8.5, Math.abs(x) + wobble);
      const practice = 0.35 + 0.65 * gauss(z + wobble * 0.8, 36, 10) + 0.3 * gauss(z, 61, 8);
      const goalMouth = (gauss(z, 9, 4.5) + gauss(z, 111, 4.5)) * (1 - smooth(2, 8, Math.abs(x) + wobble * 0.5));
      const sideline = gauss(x + wobble * 0.15, -25.3, 1.6) * smooth(22, 34, z) * (1 - smooth(84, 98, z));
      const n = patch(u * 6, v * 6 * 2.06);
      const fine = grain(u * 32, v * 32 * 2.06);
      const zone = between * practice * 0.7 + goalMouth * 0.5 + sideline * 0.35;
      // Patchy: worn clumps with healthy grass between them.
      const patchy = smooth(0.38, 0.78, n * 0.7 + fine * 0.45);
      const wear = Math.min(1, zone * (0.25 + 0.75 * patchy));
      const o = (j * w + i) * 4;
      data[o] = Math.round(wear * 255);
      data[o + 1] = Math.round(n * 255);
      data[o + 2] = Math.round(fine * 255);
      data[o + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;
  return texture;
}
function smooth(a, b, v) {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

// ---------------------------------------------------------------------------
// Turf shader (injected into MeshStandardMaterial so lighting, shadows, fog and
// IBL stay standard). Coordinates inside are simulation yards: p.x across,
// p.y = simulation z (downfield).

const TURF_PARS = /* glsl */`
uniform sampler2D turfGrass;
uniform sampler2D turfDirt;
uniform sampler2D turfWear;
uniform sampler2D turfNoise;
uniform sampler2D turfNumbers;
uniform sampler2D turfNormal;
uniform vec3 turfMean;
uniform vec3 turfColor;
uniform vec3 turfRough;
uniform vec3 turfDirtTint;
uniform vec3 turfPaint;
uniform float turfStripe;
uniform float turfNormalScale;
uniform float turfSecondX;
varying vec3 vTurfWorld;

// Box-filtered coverage of the band |d| < w for a pixel footprint fw.
float band(float d, float w, float fw) {
  fw = max(fw, 1e-4);
  return (clamp(d + 0.5 * fw, -w, w) - clamp(d - 0.5 * fw, -w, w)) / fw;
}
float span(float v, float lo, float hi, float fw) {
  return band(v - 0.5 * (lo + hi), 0.5 * (hi - lo), fw);
}
float rect(vec2 p, vec2 lo, vec2 hi, vec2 fw) {
  return span(p.x, lo.x, hi.x, fw.x) * span(p.y, lo.y, hi.y, fw.y);
}
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

// All paint of one field. p: field-local (x, simulation z); fw: footprint.
float fieldPaint(vec2 p, vec2 fw) {
  const float HW = 26.666667;
  float paint = rect(p, vec2(-HW - 2.0, -2.0), vec2(HW + 2.0, 122.0), fw)
              - rect(p, vec2(-HW, 0.0), vec2(HW, 120.0), fw);
  float across = span(p.x, -HW, HW, fw.x);

  // Yard lines every 5 yd (4 in), goal lines 8 in.
  float zl = p.y - 10.0;
  float k = clamp(floor(zl / 5.0 + 0.5), 0.0, 20.0);
  float lineHalf = (k < 0.5 || k > 19.5) ? 0.1111 : 0.0556;
  paint = max(paint, band(zl - 5.0 * k, lineHalf, fw.y) * across);

  // One-yard hash marks (inbound lines) and sideline ticks, 2 ft long.
  float kh = floor(zl + 0.5);
  float tick = step(0.5, kh) * step(kh, 99.5) * step(0.5, mod(kh, 5.0));
  float hz = band(zl - kh, 0.0556, fw.y) * tick;
  float ax = abs(p.x);
  float hashes = span(ax, 3.0833, 3.75, fw.x) + span(ax, HW - 0.7778, HW - 0.1111, fw.x);
  paint = max(paint, hz * hashes);

  // Two-yard try marks, 1 yd long.
  float tryLine = band(p.y - 12.0, 0.0556, fw.y) + band(p.y - 108.0, 0.0556, fw.y);
  paint = max(paint, tryLine * span(p.x, -0.5, 0.5, fw.x));

  // Numbers every 10 yd, bottoms 12 yd from the sideline, reading from that sideline.
  float kn = clamp(floor(zl / 10.0 + 0.5), 1.0, 9.0);
  float zc = 10.0 + 10.0 * kn;
  float side = p.x < 0.0 ? -1.0 : 1.0;
  float xc = side * (HW - 13.0);
  float u = side * (p.y - zc);            // along the reading direction
  float v = -side * (p.x - xc);           // up = toward the middle of the field
  const float BW = 1.583333;              // half block width (9.5 ft)
  vec2 cell = vec2((u + BW) / (2.0 * BW), (v + 1.0) * 0.5);
  float inside = step(0.0, cell.x) * step(cell.x, 1.0) * step(0.0, cell.y) * step(cell.y, 1.0);
  float value = 5.0 - abs(5.0 - kn);      // 1..5 -> 10..50
  vec2 atlas = vec2((value - 1.0 + (17.0 + cell.x * 266.0) / 300.0) / 5.0, (16.0 + cell.y * 168.0) / 200.0);
  paint = max(paint, texture2D(turfNumbers, atlas).a * inside);

  // Directional arrows beside every number except the 50, toward the nearer goal.
  float goalward = kn < 5.0 ? -1.0 : 1.0;
  float du = (p.y - zc) * goalward;        // > 0 on the goal side of the block
  float t = clamp((du - (BW + 0.2)) / 0.97, 0.0, 1.0);
  float arrowHalf = 0.25 * (1.0 - t);
  float arrow = span(du, BW + 0.2, BW + 1.17, fw.y) * band(v - 0.72, arrowHalf, fw.x)
              * step(0.5, abs(kn - 5.0));
  paint = max(paint, arrow);
  return clamp(paint, 0.0, 1.0);
}
`;

const TURF_FRAGMENT = /* glsl */`
vec2 wp = vec2(vTurfWorld.x, -vTurfWorld.z);
vec2 wfw = fwidth(wp);

// Which field (if any) this fragment belongs to, in field-local coordinates.
bool second = wp.x > 31.666667;
vec2 fp = second ? vec2(wp.x - turfSecondX, wp.y) : wp;
float onField = span(fp.x, -29.2, 29.2, 1.6) * span(fp.y, -2.6, 122.6, 1.6);

// Grass albedo: two scales of the lawn photograph, re-tinted toward real turf.
vec3 g1 = texture2D(turfGrass, wp / 3.1).rgb;
#ifdef TURF_HQ
vec3 g2 = texture2D(turfGrass, mat2(0.8, -0.6, 0.6, 0.8) * wp / 9.3 + 0.37).rgb;
vec3 grassTex = mix(g1, g2, 0.4);
#else
vec3 grassTex = g1;
#endif
// Mostly luminance detail with a little of the photo's hue, softened.
vec3 variation = clamp(grassTex / turfMean, vec3(0.25), vec3(2.5));
float detail = luma(grassTex) / luma(turfMean);
variation = mix(vec3(1.0), mix(vec3(detail), variation, 0.25), 0.62);
float broad = texture2D(turfNoise, wp / 37.0).r;
float mottled = texture2D(turfNoise, wp / 11.0 + 0.5).r;

// Mow stripes: 5 yd bands between the goal lines, cross-cut in the end zones.
float stripe = clamp(sin(3.14159265 * (fp.y - 10.0) / 5.0) * 7.0, -1.0, 1.0);
float endStripe = clamp(sin(3.14159265 * (fp.x + 26.666667) / 5.333333) * 7.0, -1.0, 1.0);
stripe = (fp.y > 10.0 && fp.y < 110.0) ? stripe : endStripe;
vec3 maintained = turfColor * (1.0 + turfStripe * stripe) * (0.94 + 0.12 * broad);
maintained *= mix(vec3(1.0), vec3(1.03, 1.0, 0.94), 0.5 + 0.5 * stripe);
vec3 rough = turfRough * (0.8 + 0.4 * broad) * mix(vec3(1.0), vec3(1.1, 1.02, 0.78), smoothstep(0.45, 0.8, mottled));
vec3 grass = mix(rough, maintained, onField) * variation;

// Wear: thinner, browner grass with soil showing through.
vec2 wuv = vec2((fp.x + 32.0) / 64.0, (fp.y + 6.0) / 132.0);
vec4 wearSample = texture2D(turfWear, second ? vec2(1.0 - wuv.x, wuv.y) : wuv);
float wear = wearSample.r * (second ? 0.55 : 1.0) * onField;
vec3 dirt = texture2D(turfDirt, wp / 2.4).rgb * turfDirtTint;
// Worn turf first goes thin and straw-coloured, then shows soil in the worst spots.
grass = mix(grass, grass * vec3(1.1, 1.0, 0.7) * 0.94, smoothstep(0.05, 0.6, wear) * 0.7);
grass = mix(grass, dirt, smoothstep(0.45, 0.95, wear) * 0.6 * (0.6 + 0.4 * wearSample.b));

// Paint, slightly worn so the grass shows through.
float paint = fieldPaint(fp, wfw) * step(0.001, onField);
float paintWear = 0.84 + 0.16 * mottled - 0.35 * wear * (0.6 + 0.4 * wearSample.b);
paint *= clamp(paintWear, 0.0, 1.0);
vec3 albedo = mix(grass, turfPaint * (0.82 + 0.18 * clamp(detail, 0.0, 1.4)), paint);
diffuseColor.rgb = albedo;
float turfRoughness = mix(0.94, 0.78, paint);
`;

export function createTurfMaterial(textures) {
  const uniforms = {
    turfGrass: { value: textures.grass },
    turfDirt: { value: textures.dirt },
    turfWear: { value: wearTexture() },
    turfNoise: { value: textures.noise },
    turfNumbers: { value: numberAtlas() },
    turfNormal: { value: textures.normal },
    // Mean linear colour of the lawn photograph (used to normalise it).
    turfMean: { value: new THREE.Vector3(0.130, 0.244, 0.018) },
    turfColor: { value: new THREE.Color('#30552b') },
    turfRough: { value: new THREE.Color('#4d6030') },
    turfDirtTint: { value: new THREE.Color('#d8c8b0') },
    turfPaint: { value: new THREE.Color('#f2f1ea') },
    turfStripe: { value: 0.03 },
    turfNormalScale: { value: 0.55 },
    turfSecondX: { value: FIELD.secondFieldX },
  };
  const material = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.94, metalness: 0 });
  material.defines.TURF_HQ = '';
  material.userData.uniforms = uniforms;
  material.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = 'varying vec3 vTurfWorld;\n' + shader.vertexShader.replace(
      '#include <project_vertex>',
      '#include <project_vertex>\n vTurfWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;',
    );
    let fragment = TURF_PARS + shader.fragmentShader;
    fragment = replaceOnce(fragment, '#include <map_fragment>', TURF_FRAGMENT);
    fragment = replaceOnce(fragment, '#include <roughnessmap_fragment>', 'float roughnessFactor = turfRoughness;');
    // Tangent-space normal map sampled in world space; the ground is flat so
    // the tangent frame is the world x / north / up axes in view space.
    fragment = replaceOnce(fragment, '#include <normal_fragment_maps>', /* glsl */`
      vec3 mapN = texture2D(turfNormal, wp / 2.19).xyz * 2.0 - 1.0;
      mapN.xy *= turfNormalScale;
      mat3 turfTbn = mat3(
        normalize((viewMatrix * vec4(1.0, 0.0, 0.0, 0.0)).xyz),
        normalize((viewMatrix * vec4(0.0, 0.0, -1.0, 0.0)).xyz),
        normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz));
      normal = normalize(turfTbn * mapN);
    `);
    shader.fragmentShader = fragment;
  };
  material.customProgramCacheKey = () => 'turf-v1-' + ('TURF_HQ' in material.defines ? 'hq' : 'lq');
  return material;
}

export function setTurfQuality(material, high) {
  const has = 'TURF_HQ' in material.defines;
  if (has === high) return;
  if (high) material.defines.TURF_HQ = '';
  else delete material.defines.TURF_HQ;
  material.needsUpdate = true;
}

function replaceOnce(source, search, replacement) {
  if (!source.includes(search)) throw new Error('Shader chunk not found: ' + search);
  return source.replace(search, replacement);
}

// Flat practice-facility ground: a disc that holds both fields and the grass
// around them. The terrain ring outside it starts slightly below its edge.
export function buildGround(parent, material, radius) {
  const geometry = new THREE.CircleGeometry(radius, 96);
  geometry.rotateX(-Math.PI / 2);
  const ground = new THREE.Mesh(geometry, material);
  ground.position.set(18, 0, sceneZ(60));
  ground.receiveShadow = true;
  ground.name = 'turf';
  parent.add(ground);
  return ground;
}

// ---------------------------------------------------------------------------
// Goal posts and pylons

const POST_YELLOW = () => standard('#e9c22a', 0.45, 0.2);
const PAD_NAVY = () => standard('#13263b', 0.85, 0);

// NFL gooseneck goal post on the end line at simulation z = `endZ`; `back`
// is +1 when the post base stands beyond z = 120 and -1 beyond z = 0.
export function buildGoalPost(parent, centerX, endZ, back) {
  const batch = new StaticBatch('goal-post');
  const yellow = POST_YELLOW(), pad = PAD_NAVY();
  const z = sceneZ(endZ), baseZ = sceneZ(endZ + back * 2.0);
  const crossbar = 3.3333, halfWidth = 3.0833, upright = 11.6667;
  batch.tube(yellow, [centerX, 0, baseZ], [centerX, 2.55, baseZ], 0.115, { segments: 14 });
  const neck = new THREE.QuadraticBezierCurve3(
    new THREE.Vector3(centerX, 2.5, baseZ),
    new THREE.Vector3(centerX, crossbar + 0.05, baseZ),
    new THREE.Vector3(centerX, crossbar, z),
  );
  batch.add(yellow, new THREE.TubeGeometry(neck, 16, 0.105, 12, false), new THREE.Matrix4());
  batch.tube(yellow, [centerX - halfWidth - 0.06, crossbar, z], [centerX + halfWidth + 0.06, crossbar, z], 0.075, { segments: 12 });
  for (const s of [-1, 1]) {
    batch.tube(yellow, [centerX + s * halfWidth, crossbar - 0.06, z], [centerX + s * halfWidth, crossbar + upright, z], 0.06, { top: 0.05, segments: 10 });
  }
  // Padding around the base post.
  batch.tube(pad, [centerX, 0, baseZ], [centerX, 2.1, baseZ], 0.32, { segments: 16 });
  batch.build(parent);
  // Wind ribbons on top of each upright (animated by the environment).
  const ribbons = [];
  const ribbonMaterial = standard('#e8742c', 0.8, 0, { side: THREE.DoubleSide });
  for (const s of [-1, 1]) {
    const geometry = new THREE.PlaneGeometry(1.15, 0.11, 6, 1);
    geometry.translate(0.575, 0, 0);
    const ribbon = new THREE.Mesh(geometry, ribbonMaterial);
    ribbon.position.set(centerX + s * halfWidth, crossbar + upright - 0.05, z);
    ribbon.castShadow = true;
    ribbon.userData.base = geometry.attributes.position.array.slice();
    parent.add(ribbon);
    ribbons.push(ribbon);
  }
  return { ribbons, base: [centerX, baseZ] };
}

// Pylons: inside edge on the line at the four corners of each end zone, plus two
// on each end line in line with the hashes.
export function buildPylons(parent, centerX) {
  const batch = new StaticBatch('pylons');
  const orange = standard('#ff6a1f', 0.62, 0);
  const s = 0.111, h = 0.5, hw = FIELD.halfWidth;
  for (const z of [0, 10, 110, 120]) {
    const out = z === 0 || z === 10 ? -1 : 1;
    for (const side of [-1, 1]) {
      batch.block(orange, centerX + side * (hw + s / 2), 0, sceneZ(z + out * s / 2), s, h, s);
    }
  }
  for (const z of [0, 120]) {
    const out = z === 0 ? -1 : 1;
    for (const side of [-1, 1]) batch.block(orange, centerX + side * FIELD.hashX, 0, sceneZ(z + out * s / 2), s, h, s);
  }
  batch.build(parent);
}

// Overlays drawn on top of the turf: line of scrimmage and first-down line.
export function lineOverlay(color, width, opacity) {
  const geometry = new THREE.PlaneGeometry(FIELD.width, width);
  geometry.rotateX(-Math.PI / 2);
  const material = new THREE.MeshBasicMaterial({
    color, transparent: true, opacity, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.y = 0.01;
  mesh.renderOrder = 2;
  return mesh;
}


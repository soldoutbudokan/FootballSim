import * as THREE from '../../vendor/three.module.js';
import { KEEP_NORMAL_FRAGMENT, canvasTexture, makeRandom } from './common.js';

// Grass tufts near the camera (balanced profile and above). Each tuft is two
// crossed alpha-tested cards carrying a painted cluster of blades. Tufts live
// in a square tile that wraps around a focus point in the vertex shader, so
// they stay fixed in the world while the tile follows the action; tufts fade
// out toward the tile edge and are suppressed on painted lines and numbers.

const TILE = 24;          // yards
const MAX_TUFTS = 60000;

function tuftTexture() {
  const random = makeRandom(902);
  return canvasTexture(128, 64, (c, w, h) => {
    c.clearRect(0, 0, w, h);
    for (let i = 0; i < 26; i++) {
      const x = 8 + random() * (w - 16), lean = (random() - 0.5) * 18, height = h * (0.45 + random() * 0.55);
      const g = 0.55 + random() * 0.45;
      c.strokeStyle = `rgb(${Math.round(150 * g)},${Math.round(205 * g)},${Math.round(110 * g)})`;
      c.lineWidth = 1.6 + random() * 1.4;
      c.beginPath();
      c.moveTo(x, h);
      c.quadraticCurveTo(x + lean * 0.3, h - height * 0.6, x + lean, h - height);
      c.stroke();
    }
  });
}

const VERTEX_PARS = /* glsl */`
uniform vec3 tuftFocus;
uniform float tuftTile;
uniform float tuftTime;
uniform float tuftWind;
uniform float tuftSecondX;
attribute vec4 tuftOffset;   // tile x, tile z (scene), height, yaw
attribute float tuftShade;
varying float vTuftShade;
varying float vTuftHeight;

float tuftOnPaint(vec2 p) {
  // p: field-local (x, simulation z). Lines, hashes, border and number blocks.
  float zl = p.y - 10.0;
  float line = abs(zl - 5.0 * clamp(floor(zl / 5.0 + 0.5), 0.0, 20.0));
  float paint = step(line, 0.16) * step(abs(p.x), 26.8);
  float tick = abs(zl - floor(zl + 0.5));
  float ax = abs(p.x);
  paint = max(paint, step(tick, 0.12) * (step(3.0, ax) * step(ax, 3.85) + step(25.8, ax) * step(ax, 26.6)));
  paint = max(paint, step(26.55, ax) * step(ax, 28.8));
  float kn = clamp(floor(zl / 10.0 + 0.5), 1.0, 9.0);
  float zc = 10.0 + 10.0 * kn;
  paint = max(paint, step(abs(ax - 13.67), 1.15) * step(abs(p.y - zc), 2.9));
  return paint * step(-2.2, p.y) * step(p.y, 122.2);
}
`;

const BEGIN_VERTEX = /* glsl */`
vec2 rel = tuftOffset.xy - tuftFocus.xz;
vec2 site = tuftFocus.xz + rel - tuftTile * floor(rel / tuftTile + 0.5);
// Fade with distance from the camera: tufts only read as blades up close.
float fade = 1.0 - smoothstep(9.0, 15.0, length(site - cameraPosition.xz));
fade *= 1.0 - smoothstep(0.8, 1.0, length(site - tuftFocus.xz) / (0.5 * tuftTile));
vec2 sim = vec2(site.x, -site.y);
vec2 local = sim.x > 31.666667 ? vec2(sim.x - tuftSecondX, sim.y) : sim;
fade *= 1.0 - tuftOnPaint(local);
float h = tuftOffset.z * fade;
float c = cos(tuftOffset.w), s = sin(tuftOffset.w);
vec2 across = vec2(c, s) * position.x;
float sway = sin(tuftTime * 2.1 + site.x * 0.41 + site.y * 0.29 + tuftShade * 9.0) * tuftWind * position.y * position.y;
vec3 transformed = vec3(site.x + across.x + sway * 0.06, position.y * h, site.y + across.y + sway * 0.03);
vTuftShade = tuftShade;
vTuftHeight = position.y;
`;

export class GrassTufts {
  constructor(scene, turfUniforms) {
    const random = makeRandom(1337);
    // Two crossed cards per tuft, each card 4 vertices.
    const base = [[-0.5, 0], [0.5, 0], [0.5, 1], [-0.5, 1]];
    const positions = new Float32Array(MAX_TUFTS * 8 * 3);
    const uvs = new Float32Array(MAX_TUFTS * 8 * 2);
    const offsets = new Float32Array(MAX_TUFTS * 8 * 4);
    const shades = new Float32Array(MAX_TUFTS * 8);
    const index = new Uint32Array(MAX_TUFTS * 12);
    for (let t = 0; t < MAX_TUFTS; t++) {
      const x = random() * TILE, z = random() * TILE;
      const height = 0.07 + random() * 0.07, width = 0.2 + random() * 0.12, yaw = random() * Math.PI;
      const shade = random();
      for (let card = 0; card < 2; card++) {
        for (let k = 0; k < 4; k++) {
          const v = t * 8 + card * 4 + k;
          // Card 1 is rotated 90 degrees through the yaw stored per vertex.
          positions.set([base[k][0] * width, base[k][1], 0], v * 3);
          uvs.set([k === 0 || k === 3 ? 0 : 1, base[k][1]], v * 2);
          offsets.set([x, z, height, yaw + card * Math.PI / 2], v * 4);
          shades[v] = shade;
        }
        const o = t * 12 + card * 6, v0 = t * 8 + card * 4;
        index.set([v0, v0 + 1, v0 + 2, v0, v0 + 2, v0 + 3], o);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geometry.setAttribute('tuftOffset', new THREE.BufferAttribute(offsets, 4));
    geometry.setAttribute('tuftShade', new THREE.BufferAttribute(shades, 1));
    geometry.setIndex(new THREE.BufferAttribute(index, 1));
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);

    this.uniforms = {
      tuftFocus: { value: new THREE.Vector3(0, 0, -30) },
      tuftTile: { value: TILE },
      tuftTime: { value: 0 },
      tuftWind: { value: 0.35 },
      tuftSecondX: { value: 63.333333 },
      tuftColor: turfUniforms.turfColor,
    };
    const material = new THREE.MeshStandardMaterial({
      map: tuftTexture(), roughness: 0.95, metalness: 0, alphaTest: 0.4, alphaToCoverage: true, side: THREE.DoubleSide,
    });
    material.onBeforeCompile = shader => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = VERTEX_PARS + shader.vertexShader
        .replace('#include <beginnormal_vertex>', 'vec3 objectNormal = vec3(0.0, 1.0, 0.0);')
        .replace('#include <begin_vertex>', BEGIN_VERTEX);
      shader.fragmentShader = 'uniform vec3 tuftColor;\nvarying float vTuftShade;\nvarying float vTuftHeight;\n' + shader.fragmentShader
        .replace('#include <normal_fragment_begin>', KEEP_NORMAL_FRAGMENT)
        .replace(
        '#include <map_fragment>',
        /* glsl */`
        vec4 tuft = texture2D(map, vMapUv);
        float paleTip = smoothstep(0.4, 1.0, vTuftHeight);
        vec3 tuftAlbedo = tuftColor * (0.82 + 0.36 * vTuftShade) * mix(0.72, 1.12, vTuftHeight);
        tuftAlbedo = mix(tuftAlbedo, tuftAlbedo * vec3(1.15, 1.08, 0.8), paleTip * vTuftShade * 0.6);
        diffuseColor = vec4(tuftAlbedo * (0.75 + 0.25 * tuft.g), tuft.a);
        `,
      );
    };
    material.customProgramCacheKey = () => 'grass-tufts-v1';
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.name = 'grass-tufts';
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = false;
    this.mesh.matrixAutoUpdate = false;
    scene.add(this.mesh);
    this.setCount(0);
  }

  setCount(count) {
    const n = Math.min(MAX_TUFTS, Math.max(0, Math.round(count)));
    this.mesh.geometry.setDrawRange(0, n * 12);
    this.mesh.visible = n > 0;
    this.enabled = n > 0;
  }

  update(dt, focus, wind) {
    this.uniforms.tuftTime.value += dt;
    this.uniforms.tuftWind.value = wind;
    this.uniforms.tuftFocus.value.copy(focus);
  }
}

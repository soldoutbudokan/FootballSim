import * as THREE from '../../vendor/three.module.js';
import { Sky } from '../../vendor/Sky.js';
import { noiseTexture } from './common.js';

// Physically based sky: the three.js r180 Preetham `Sky`, extended with a
// drifting procedural cloud layer, a night sky (stars and light-pollution
// glow) and a horizon haze that blends into the scene fog exactly.

const EXTRA_UNIFORMS = /* glsl */`
uniform float skyGain;
uniform float skySaturation;
uniform sampler2D cloudMap;
uniform vec2 cloudOffset;
uniform float cloudCoverage;
uniform float cloudSoftness;
uniform float cloudOpacity;
uniform vec3 cloudLit;
uniform vec3 cloudShade;
uniform float nightMix;
uniform vec3 nightZenith;
uniform vec3 nightHorizon;
uniform vec3 hazeColor;
uniform float hazeHeight;
float skyHash(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
`;

const COMPOSE = /* glsl */`
vec3 col = retColor * skyGain;
// The analytic model washes out toward white once tone mapped; restore the
// saturation of a clear sky (1 = unchanged).
col = max(mix(vec3(dot(col, vec3(0.2126, 0.7152, 0.0722))), col, skySaturation), 0.0);
float up = max(direction.y, 0.0);

// Night: replace the (black) Preetham sky with a deep gradient and stars.
if (nightMix > 0.0) {
  vec3 night = mix(nightHorizon, nightZenith, pow(up, 0.45));
  vec3 cell = floor(direction * 420.0);
  float star = step(0.9972, skyHash(cell)) * smoothstep(0.42, 0.0, length(fract(direction * 420.0) - 0.5));
  night += vec3(0.9, 0.95, 1.0) * star * 0.05 * smoothstep(0.08, 0.35, up);
  col = mix(col, night, nightMix);
}

// Clouds: a noise layer projected on a plane high above the facility.
vec2 cuv = direction.xz / (direction.y + 0.09) * 0.32 + cloudOffset;
float n = texture2D(cloudMap, cuv).r * 0.6 + texture2D(cloudMap, cuv * 2.37 + 0.31).r * 0.28
        + texture2D(cloudMap, cuv * 5.9 + 0.77).r * 0.12;
float density = smoothstep(cloudCoverage, cloudCoverage + cloudSoftness, n) * smoothstep(0.0, 0.16, direction.y);
float thick = smoothstep(cloudCoverage, cloudCoverage + 0.42, n);
float toward = max(dot(direction, vSunDirection), 0.0);
vec3 cloud = mix(cloudLit, cloudShade, thick * 0.75) + cloudLit * pow(toward, 12.0) * 0.6 * (1.0 - thick);
col = mix(col, cloud, density * cloudOpacity);

gl_FragColor = vec4(col, 1.0);
`;

// Applied after tone mapping, in the output colour space, so the horizon meets
// the fogged distance exactly.
const HAZE = /* glsl */`
#include <colorspace_fragment>
float haze = 1.0 - smoothstep(-0.02, hazeHeight, direction.y);
gl_FragColor.rgb = mix(gl_FragColor.rgb, linearToOutputTexel(vec4(hazeColor, 1.0)).rgb, haze);
`;

function patch(source, search, replacement) {
  if (!source.includes(search)) throw new Error('Sky shader chunk not found: ' + search);
  return source.replace(search, replacement);
}

export class SkyDome {
  constructor(scene) {
    this.mesh = new Sky();
    this.mesh.scale.setScalar(2400);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -10;
    this.mesh.name = 'sky';
    const material = this.mesh.material;
    this.uniforms = material.uniforms;
    Object.assign(this.uniforms, {
      skyGain: { value: 0.5 },
      skySaturation: { value: 1 },
      cloudMap: { value: noiseTexture(256, 4242, 6, 6) },
      cloudOffset: { value: new THREE.Vector2(0.13, 0.41) },
      cloudCoverage: { value: 0.55 },
      cloudSoftness: { value: 0.22 },
      cloudOpacity: { value: 0.9 },
      cloudLit: { value: new THREE.Color(1, 1, 1) },
      cloudShade: { value: new THREE.Color(0.6, 0.62, 0.66) },
      nightMix: { value: 0 },
      nightZenith: { value: new THREE.Color('#02050b') },
      nightHorizon: { value: new THREE.Color('#151b24') },
      hazeColor: { value: new THREE.Color('#c8d4dc') },
      hazeHeight: { value: 0.08 },
    });
    let fragment = EXTRA_UNIFORMS + material.fragmentShader;
    fragment = patch(fragment, 'gl_FragColor = vec4( retColor, 1.0 );', COMPOSE);
    fragment = patch(fragment, '#include <colorspace_fragment>', HAZE);
    material.fragmentShader = fragment;
    scene.add(this.mesh);
    this.sunDirection = new THREE.Vector3(0, 1, 0);
    this.wind = new THREE.Vector2(0.0022, 0.0009);
  }

  // Elevation and compass azimuth in degrees (0 = north = downfield = scene -z).
  setSun(elevation, azimuth) {
    const el = THREE.MathUtils.degToRad(elevation), az = THREE.MathUtils.degToRad(azimuth);
    this.sunDirection.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)).normalize();
    this.uniforms.sunPosition.value.copy(this.sunDirection);
  }

  apply(preset) {
    const u = this.uniforms, s = preset.sky;
    u.turbidity.value = s.turbidity;
    u.rayleigh.value = s.rayleigh;
    u.mieCoefficient.value = s.mieCoefficient;
    u.mieDirectionalG.value = s.mieDirectionalG;
    u.skyGain.value = s.gain;
    u.skySaturation.value = s.saturation ?? 1;
    u.cloudCoverage.value = s.cloudCoverage;
    u.cloudSoftness.value = s.cloudSoftness;
    u.cloudOpacity.value = s.cloudOpacity;
    u.cloudLit.value.set(s.cloudLit).multiplyScalar(s.cloudBrightness);
    u.cloudShade.value.set(s.cloudShade).multiplyScalar(s.cloudBrightness);
    u.nightMix.value = s.night ? 1 : 0;
    u.hazeColor.value.set(preset.fog);
    u.hazeHeight.value = s.hazeHeight;
    this.setSun(preset.sun.elevation, preset.sun.azimuth);
  }

  update(dt) {
    this.uniforms.cloudOffset.value.addScaledVector(this.wind, dt);
  }

  // A second mesh sharing the sky material, for rendering environment maps.
  clone() {
    const copy = new THREE.Mesh(this.mesh.geometry, this.mesh.material);
    copy.scale.setScalar(100);
    copy.frustumCulled = false;
    return copy;
  }
}

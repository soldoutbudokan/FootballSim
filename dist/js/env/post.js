import * as THREE from '../../vendor/three.module.js';

// The post-processing pipeline (Balanced profile and above; Performance draws
// straight to the canvas). The scene is rendered into a multisampled HDR
// target with a depth texture, then:
//   1. ambient occlusion from depth at half resolution (scalable-AO estimator,
//      depth-aware separable blur),
//   2. bloom of what is brighter than paper white (helmet glints, lamp lenses,
//      the sun) through a small downsample / upsample pyramid,
//   3. depth of field for the replay and title cameras (far field only),
//   4. one composite pass: occlusion, bloom, exposure, ACES filmic tone
//      mapping (the curve the renderer itself uses on the Performance tier), a
//      restrained per-lighting grade, vignette, sRGB encoding and a little
//      grain that also dithers away banding.
// Anti-aliasing is the scene target's multisampling; nothing after it blurs
// the image, so jersey numbers and field paint stay as sharp as they were.
// Everything is written here as compact passes; no third-party code.

const VERTEX = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const DEPTH_PARS = /* glsl */`
uniform sampler2D tDepth;
uniform vec2 nearFar;
uniform vec2 projScale;   // tan(fov / 2) * (aspect, 1)
float linearDepth(float d) { return nearFar.x * nearFar.y / (nearFar.y - d * (nearFar.y - nearFar.x)); }
float depthAt(vec2 uv) { return linearDepth(textureLod(tDepth, uv, 0.0).x); }
// View-space position of the depth texel under uv. The position is rebuilt
// at that texel's centre, not at uv itself: on ground seen at a grazing angle depth
// changes so fast per texel that the half-texel difference shows up as bands
// of false occlusion.
vec3 viewPosition(vec2 uv) {
  ivec2 size = textureSize(tDepth, 0);
  ivec2 texel = clamp(ivec2(floor(uv * vec2(size))), ivec2(0), size - 1);
  float z = linearDepth(texelFetch(tDepth, texel, 0).x);
  return vec3(((vec2(texel) + 0.5) / vec2(size) * 2.0 - 1.0) * projScale * z, -z);
}
// Linear depth packed in two 8-bit channels (square-root encoded so the
// precision sits near the camera).
vec2 packDepth(float z) {
  float v = clamp(sqrt(z / nearFar.y), 0.0, 0.99999) * 255.0;
  return vec2(floor(v) / 255.0, fract(v));
}
float unpackDepth(vec2 p) {
  float v = p.x + p.y / 255.0;
  return v * v * nearFar.y;
}
`;

// Scalable ambient obscurance (McGuire et al.) on a spiral whose rotation
// repeats every 4 x 4 pixels, which the 4-tap blur below removes exactly.
const AO_FRAGMENT = /* glsl */`
${DEPTH_PARS}
uniform vec2 texel;       // one texel of the depth texture
uniform float radius;     // yards
uniform float intensity;
varying vec2 vUv;
const int BAYER[16] = int[16](0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5);
void main() {
  // This half-resolution pixel sits on a corner of four depth texels: use one.
  vec2 here = vUv + 0.25 * texel;
  vec3 P = viewPosition(here);
  float z = -P.z;
  vec2 ruv = radius / (2.0 * z * projScale);
  // Sky, and geometry so far away that the radius is under a texel.
  if (z > 0.8 * nearFar.y || ruv.y < 1.5 * texel.y) { gl_FragColor = vec4(1.0, packDepth(z), 1.0); return; }
  // Close to the lens the radius would cover half the screen: cap it.
  ruv *= min(1.0, 0.05 / ruv.y);
  vec3 Pr = viewPosition(here + vec2(texel.x, 0.0)), Pl = viewPosition(here - vec2(texel.x, 0.0));
  vec3 Pu = viewPosition(here + vec2(0.0, texel.y)), Pd = viewPosition(here - vec2(0.0, texel.y));
  vec3 dx = abs(Pr.z - P.z) < abs(P.z - Pl.z) ? Pr - P : P - Pl;
  vec3 dy = abs(Pu.z - P.z) < abs(P.z - Pd.z) ? Pu - P : P - Pd;
  vec3 N = normalize(cross(dx, dy));
  ivec2 cell = ivec2(gl_FragCoord.xy) & 3;
  float phi = float(BAYER[cell.x + cell.y * 4]) * (6.2831853 / 16.0);
  float r2 = radius * radius, sum = 0.0;
  for (int i = 0; i < AO_SAMPLES; i++) {
    float t = (float(i) + 0.5) / float(AO_SAMPLES);
    float angle = phi + float(i) * 2.3999632;
    vec2 uv = here + vec2(cos(angle), sin(angle)) * sqrt(t) * ruv;
    vec3 v = viewPosition(uv) - P;
    float vv = dot(v, v), vn = dot(v, N);
    float f = max(r2 - vv, 0.0);
    sum += f * f * f * max((vn - 0.002 * z - 0.012) / (vv + 0.0004), 0.0);
  }
  float ao = max(0.0, 1.0 - intensity * sum * 5.0 / (r2 * r2 * r2 * float(AO_SAMPLES)));
  // Fade out with distance: far geometry is fogged, and its occlusion would shimmer.
  ao = mix(ao, 1.0, smoothstep(90.0, 220.0, z));
  gl_FragColor = vec4(ao, packDepth(z), 1.0);
}`;

const AO_BLUR_FRAGMENT = /* glsl */`
uniform sampler2D tAo;
uniform ivec2 axis;       // (1, 0) or (0, 1)
uniform vec2 nearFar;
varying vec2 vUv;
float unpackDepth(vec2 p) { float v = p.x + p.y / 255.0; return v * v * nearFar.y; }
// Four taps at -2..1 texels: a box as wide as the rotation pattern. The
// result sits half a texel toward the origin; the composite samples it there.
void main() {
  ivec2 at = ivec2(gl_FragCoord.xy), limit = textureSize(tAo, 0) - 1;
  vec4 centre = texelFetch(tAo, at, 0);
  float z = unpackDepth(centre.yz);
  float sum = centre.x, weight = 1.0;
  for (int i = -2; i <= 1; i++) {
    if (i == 0) continue;
    vec4 tap = texelFetch(tAo, clamp(at + axis * i, ivec2(0), limit), 0);
    float w = max(0.0, 1.0 - abs(unpackDepth(tap.yz) - z) / (0.04 * z + 0.05));
    sum += tap.x * w;
    weight += w;
  }
  gl_FragColor = vec4(sum / weight, centre.yz, 1.0);
}`;

// Bloom prefilter: 2x2 box of the scene, keeping only what exceeds the knee.
const BLOOM_PREFILTER_FRAGMENT = /* glsl */`
uniform sampler2D tColor;
uniform vec2 texel;
uniform float threshold;
uniform float exposure;
varying vec2 vUv;
vec3 bright(vec2 uv) {
  vec3 c = min(texture2D(tColor, uv).rgb * exposure, vec3(24.0));
  float l = max(c.r, max(c.g, c.b));
  // Soft knee; weighting by 1 / (1 + l) keeps single hot texels from flickering.
  float k = smoothstep(threshold * 0.6, threshold * 1.6, l);
  return c * k / (1.0 + l);
}
void main() {
  vec3 sum = bright(vUv + texel * vec2(-1.0, -1.0)) + bright(vUv + texel * vec2(1.0, -1.0))
           + bright(vUv + texel * vec2(-1.0, 1.0)) + bright(vUv + texel * vec2(1.0, 1.0));
  sum *= 0.25;
  float l = max(sum.r, max(sum.g, sum.b));
  gl_FragColor = vec4(sum / max(1.0 - l, 0.04), 1.0);
}`;

const DOWNSAMPLE_FRAGMENT = /* glsl */`
uniform sampler2D tColor;
uniform vec2 texel;       // one texel of the source
varying vec2 vUv;
void main() {
  vec3 sum = texture2D(tColor, vUv + texel * vec2(-1.0, -1.0)).rgb + texture2D(tColor, vUv + texel * vec2(1.0, -1.0)).rgb
           + texture2D(tColor, vUv + texel * vec2(-1.0, 1.0)).rgb + texture2D(tColor, vUv + texel * vec2(1.0, 1.0)).rgb;
  gl_FragColor = vec4(sum * 0.25, 1.0);
}`;

// Tent upsample of the smaller level added to the level above it.
const UPSAMPLE_FRAGMENT = /* glsl */`
uniform sampler2D tColor;  // smaller level
uniform sampler2D tBase;   // this level's downsample
uniform vec2 texel;        // one texel of the smaller level
uniform float spread;
varying vec2 vUv;
void main() {
  vec2 d = texel * 0.75;
  vec3 up = texture2D(tColor, vUv + vec2(-d.x, -d.y)).rgb + texture2D(tColor, vUv + vec2(d.x, -d.y)).rgb
          + texture2D(tColor, vUv + vec2(-d.x, d.y)).rgb + texture2D(tColor, vUv + vec2(d.x, d.y)).rgb;
  gl_FragColor = vec4(texture2D(tBase, vUv).rgb + up * 0.25 * spread, 1.0);
}`;

// Depth of field, far field only: a 12-tap disc at half resolution whose
// radius follows the circle of confusion. Taps nearer than the focal plane do
// not bleed onto the background.
const DOF_FRAGMENT = /* glsl */`
${DEPTH_PARS}
uniform sampler2D tColor;
uniform vec2 texel;       // one texel of this (half-resolution) target
uniform float focus;      // yards
uniform float range;      // yards beyond the focus over which blur reaches its maximum
uniform float maxBlur;    // texels
varying vec2 vUv;
float coc(float z) { return clamp((z - focus) / range, 0.0, 1.0); }
void main() {
  float c = coc(depthAt(vUv));
  vec3 sum = texture2D(tColor, vUv).rgb;
  float weight = 1.0;
  if (c > 0.02) {
    float phi = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))) * 6.2831853;
    for (int i = 0; i < 12; i++) {
      float angle = phi + float(i) * 2.3999632;
      vec2 uv = vUv + vec2(cos(angle), sin(angle)) * sqrt((float(i) + 0.5) / 12.0) * c * maxBlur * texel;
      float w = smoothstep(0.0, 0.25, coc(depthAt(uv))) + 0.001;
      sum += min(texture2D(tColor, uv).rgb, vec3(8.0)) * w;
      weight += w;
    }
  }
  gl_FragColor = vec4(sum / weight, c);
}`;

const COMPOSITE_FRAGMENT = /* glsl */`
uniform sampler2D tColor;
uniform sampler2D tAo;
uniform sampler2D tBloom;
uniform sampler2D tDof;
uniform float exposure;
uniform float aoStrength;
uniform vec2 aoOffset;
uniform float bloomStrength;
uniform float contrast;
uniform float saturation;
uniform vec3 shadowTint;
uniform vec3 highlightTint;
uniform float vignette;
uniform float grain;
uniform float time;
uniform float aspect;
varying vec2 vUv;

vec3 RRTAndODTFit(vec3 v) {
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return a / b;
}
// The renderer's own ACESFilmicToneMapping, so the tiers match.
vec3 acesFilmic(vec3 color) {
  const mat3 ACESInputMat = mat3(vec3(0.59719, 0.07600, 0.02840), vec3(0.35458, 0.90834, 0.13383), vec3(0.04823, 0.01566, 0.83777));
  const mat3 ACESOutputMat = mat3(vec3(1.60475, -0.10208, -0.00327), vec3(-0.53108, 1.10813, -0.07276), vec3(-0.07367, -0.00605, 1.07602));
  color = ACESInputMat * (color / 0.6);
  color = RRTAndODTFit(color);
  return clamp(ACESOutputMat * color, 0.0, 1.0);
}
vec3 toSrgb(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}
float hash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
void main() {
  vec3 color = texture2D(tColor, vUv).rgb;
#ifdef USE_DOF
  vec4 dof = texture2D(tDof, vUv);
  color = mix(color, dof.rgb, smoothstep(0.05, 0.6, dof.a));
#endif
#ifdef USE_AO
  float ao = texture2D(tAo, vUv + aoOffset).r;
  // Occlusion mostly removes ambient light: bright, directly lit surfaces keep more of theirs.
  float lit = clamp(dot(color, vec3(0.2126, 0.7152, 0.0722)) * exposure * 1.4, 0.0, 1.0);
  color *= mix(1.0, ao, aoStrength * (1.0 - 0.35 * lit));
#endif
  color *= exposure;
#ifdef USE_BLOOM
  color += texture2D(tBloom, vUv).rgb * bloomStrength;
#endif
  color = acesFilmic(color);

  // Grade, display-referred: split toning by luminance, contrast about mid
  // grey, then saturation.
  float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
  color *= mix(shadowTint, highlightTint, smoothstep(0.0, 0.75, luma));
  color = toSrgb(color);
  color = (color - 0.46) * contrast + 0.46;
  float l2 = dot(color, vec3(0.299, 0.587, 0.114));
  color = mix(vec3(l2), color, saturation);

  vec2 q = (vUv - 0.5) * vec2(min(aspect, 1.9) / 1.6, 1.0);
  color *= 1.0 - vignette * smoothstep(0.35, 1.05, length(q) * 1.25);

  float n = hash(gl_FragCoord.xy + fract(time) * 311.7) + hash(gl_FragCoord.yx * 1.31 + fract(time * 1.7) * 173.3) - 1.0;
  color += n * grain * mix(1.0, 0.45, l2);
  gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
}`;

const NEUTRAL_GRADE = { contrast: 1, saturation: 1, shadows: '#ffffff', highlights: '#ffffff', vignette: 0, grain: 0, bloom: 0, ao: 1 };

function material(fragmentShader, uniforms, defines = {}) {
  return new THREE.ShaderMaterial({
    vertexShader: VERTEX, fragmentShader, uniforms, defines,
    depthTest: false, depthWrite: false, toneMapped: false, fog: false,
  });
}

function colorTarget(type, filter = THREE.LinearFilter) {
  const target = new THREE.WebGLRenderTarget(1, 1, {
    type, format: THREE.RGBAFormat, colorSpace: THREE.LinearSRGBColorSpace,
    minFilter: filter, magFilter: filter, depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
  });
  target.texture.wrapS = target.texture.wrapT = THREE.ClampToEdgeWrapping;
  return target;
}

// What a quality profile asks of the pipeline (see graphics.js).
export function postSettings(profile) {
  const post = profile?.post;
  if (!post) return null;
  return {
    msaa: post.msaa ?? 4, ao: post.ao ?? 0, bloom: post.bloom ?? 0, dof: !!post.dof,
  };
}

export class PostPipeline {
  // True when the renderer can draw to the half-float targets the pipeline needs.
  static supported(renderer) {
    return renderer.capabilities.isWebGL2 !== false
      && (renderer.extensions.has('EXT_color_buffer_float') || renderer.extensions.has('EXT_color_buffer_half_float'));
  }

  constructor(renderer) {
    this.renderer = renderer;
    this.settings = null;
    this.width = this.height = 1;
    this.time = 0;
    this.grade = NEUTRAL_GRADE;
    this.sceneTarget = null;
    this.aoTargets = null;
    this.bloomDown = [];
    this.bloomUp = [];
    this.dofTarget = null;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    this.quad = new THREE.Mesh(geometry, null);
    this.quad.frustumCulled = false;
    this.quadScene = new THREE.Scene();
    this.quadScene.add(this.quad);
    this.quadScene.matrixWorldAutoUpdate = false;
    this.quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    const depth = () => ({ tDepth: { value: null }, nearFar: { value: new THREE.Vector2(0.25, 2600) }, projScale: { value: new THREE.Vector2(1, 1) } });
    this.aoMaterial = material(AO_FRAGMENT, { ...depth(), texel: { value: new THREE.Vector2() }, radius: { value: 0.7 }, intensity: { value: 1 } }, { AO_SAMPLES: 8 });
    this.aoBlurMaterial = material(AO_BLUR_FRAGMENT, { tAo: { value: null }, axis: { value: new THREE.Vector2(1, 0) }, nearFar: this.aoMaterial.uniforms.nearFar });
    this.prefilterMaterial = material(BLOOM_PREFILTER_FRAGMENT, { tColor: { value: null }, texel: { value: new THREE.Vector2() }, threshold: { value: 1 }, exposure: { value: 1 } });
    this.downMaterial = material(DOWNSAMPLE_FRAGMENT, { tColor: { value: null }, texel: { value: new THREE.Vector2() } });
    this.upMaterial = material(UPSAMPLE_FRAGMENT, { tColor: { value: null }, tBase: { value: null }, texel: { value: new THREE.Vector2() }, spread: { value: 1 } });
    this.dofMaterial = material(DOF_FRAGMENT, { ...depth(), tColor: { value: null }, texel: { value: new THREE.Vector2() }, focus: { value: 20 }, range: { value: 60 }, maxBlur: { value: 5 } });
    this.compositeMaterial = material(COMPOSITE_FRAGMENT, {
      tColor: { value: null }, tAo: { value: null }, tBloom: { value: null }, tDof: { value: null },
      exposure: { value: 1 }, aoStrength: { value: 1 }, aoOffset: { value: new THREE.Vector2() }, bloomStrength: { value: 0 },
      contrast: { value: 1 }, saturation: { value: 1 },
      shadowTint: { value: new THREE.Color(1, 1, 1) }, highlightTint: { value: new THREE.Color(1, 1, 1) },
      vignette: { value: 0 }, grain: { value: 0 }, time: { value: 0 }, aspect: { value: 1 },
    });
  }

  get enabled() { return !!this.settings; }

  // `settings` from postSettings(), or null to turn the pipeline off (its
  // targets are released).
  configure(settings) {
    const before = JSON.stringify(this.settings), after = JSON.stringify(settings);
    if (before === after) return;
    this.settings = settings;
    this.disposeTargets();
    if (!settings) return;
    this.sceneTarget = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat, colorSpace: THREE.LinearSRGBColorSpace,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false,
      samples: Math.min(settings.msaa, this.renderer.capabilities.maxSamples || 0),
      depthBuffer: true, stencilBuffer: false,
      depthTexture: new THREE.DepthTexture(1, 1, THREE.UnsignedIntType),
    });
    if (settings.ao) {
      this.aoTargets = [colorTarget(THREE.UnsignedByteType), colorTarget(THREE.UnsignedByteType)];
      if (this.aoMaterial.defines.AO_SAMPLES !== settings.ao) {
        this.aoMaterial.defines.AO_SAMPLES = settings.ao;
        this.aoMaterial.needsUpdate = true;
      }
    }
    for (let i = 0; i < settings.bloom; i++) {
      this.bloomDown.push(colorTarget(THREE.HalfFloatType));
      if (i < settings.bloom - 1) this.bloomUp.push(colorTarget(THREE.HalfFloatType));
    }
    if (settings.dof) this.dofTarget = colorTarget(THREE.HalfFloatType);
    this.compositeMaterial.defines = {};
    if (settings.ao) this.compositeMaterial.defines.USE_AO = '';
    if (settings.bloom) this.compositeMaterial.defines.USE_BLOOM = '';
    this.compositeMaterial.needsUpdate = true;
    this.dofActive = false;
    this.applySize();
  }

  // Size of the drawing buffer in physical pixels.
  setSize(width, height) {
    width = Math.max(1, Math.floor(width));
    height = Math.max(1, Math.floor(height));
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.applySize();
  }

  applySize() {
    if (!this.settings) return;
    const w = this.width, h = this.height, half = v => Math.max(1, Math.ceil(v / 2));
    this.sceneTarget.setSize(w, h);
    if (this.aoTargets) for (const target of this.aoTargets) target.setSize(half(w), half(h));
    let bw = w, bh = h;
    for (let i = 0; i < this.bloomDown.length; i++) {
      bw = half(bw); bh = half(bh);
      this.bloomDown[i].setSize(bw, bh);
      if (this.bloomUp[i]) this.bloomUp[i].setSize(bw, bh);
    }
    if (this.dofTarget) this.dofTarget.setSize(half(w), half(h));
  }

  // Per-lighting look: { contrast, saturation, shadows, highlights, vignette, grain, bloom, ao }.
  setGrade(grade) {
    this.grade = { ...NEUTRAL_GRADE, ...grade };
    const u = this.compositeMaterial.uniforms, g = this.grade;
    u.contrast.value = g.contrast;
    u.saturation.value = g.saturation;
    u.shadowTint.value.set(g.shadows);
    u.highlightTint.value.set(g.highlights);
    u.vignette.value = g.vignette;
    u.grain.value = g.grain;
    u.bloomStrength.value = g.bloom;
    u.aoStrength.value = g.ao;
  }

  pass(material, target) {
    this.quad.material = material;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.quadScene, this.quadCamera);
  }

  // Renders one frame. `dof`: { focus, range (yards), blur (pixels of a 900-pixel-high frame) }, or null.
  render(scene, camera, dt = 0, { dof = null } = {}) {
    const renderer = this.renderer, settings = this.settings;
    const exposure = renderer.toneMappingExposure;
    this.time += dt;

    renderer.setRenderTarget(this.sceneTarget);
    renderer.render(scene, camera);

    const color = this.sceneTarget.texture, depthTexture = this.sceneTarget.depthTexture;
    const tanHalf = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
    const composite = this.compositeMaterial.uniforms;
    const w = this.width, h = this.height;

    if (this.aoTargets) {
      const u = this.aoMaterial.uniforms;
      u.tDepth.value = depthTexture;
      u.nearFar.value.set(camera.near, camera.far);
      u.projScale.value.set(tanHalf * camera.aspect, tanHalf);
      u.texel.value.set(1 / w, 1 / h);
      this.pass(this.aoMaterial, this.aoTargets[0]);
      const blur = this.aoBlurMaterial.uniforms, aw = this.aoTargets[0].width, ah = this.aoTargets[0].height;
      blur.tAo.value = this.aoTargets[0].texture;
      blur.axis.value.set(1, 0);
      this.pass(this.aoBlurMaterial, this.aoTargets[1]);
      blur.tAo.value = this.aoTargets[1].texture;
      blur.axis.value.set(0, 1);
      this.pass(this.aoBlurMaterial, this.aoTargets[0]);
      composite.tAo.value = this.aoTargets[0].texture;
      composite.aoOffset.value.set(0.5 / aw, 0.5 / ah);
    }

    const useDof = !!(dof && this.dofTarget);
    if (useDof) {
      const u = this.dofMaterial.uniforms;
      u.tDepth.value = depthTexture;
      u.tColor.value = color;
      u.nearFar.value.set(camera.near, camera.far);
      u.projScale.value.set(tanHalf * camera.aspect, tanHalf);
      u.texel.value.set(1 / this.dofTarget.width, 1 / this.dofTarget.height);
      u.focus.value = dof.focus;
      u.range.value = dof.range;
      u.maxBlur.value = dof.blur * this.dofTarget.height / 900;
      this.pass(this.dofMaterial, this.dofTarget);
      composite.tDof.value = this.dofTarget.texture;
    }
    if (useDof !== this.dofActive) {
      this.dofActive = useDof;
      if (useDof) this.compositeMaterial.defines.USE_DOF = '';
      else delete this.compositeMaterial.defines.USE_DOF;
      this.compositeMaterial.needsUpdate = true;
    }

    if (this.bloomDown.length && this.grade.bloom > 0) {
      const down = this.bloomDown, up = this.bloomUp;
      const pre = this.prefilterMaterial.uniforms;
      pre.tColor.value = color;
      pre.texel.value.set(0.5 / w, 0.5 / h);
      pre.exposure.value = exposure;
      this.pass(this.prefilterMaterial, down[0]);
      for (let i = 1; i < down.length; i++) {
        const u = this.downMaterial.uniforms;
        u.tColor.value = down[i - 1].texture;
        u.texel.value.set(0.5 / down[i - 1].width, 0.5 / down[i - 1].height);
        this.pass(this.downMaterial, down[i]);
      }
      let smaller = down[down.length - 1];
      for (let i = down.length - 2; i >= 0; i--) {
        const u = this.upMaterial.uniforms;
        u.tColor.value = smaller.texture;
        u.tBase.value = down[i].texture;
        u.texel.value.set(1 / smaller.width, 1 / smaller.height);
        this.pass(this.upMaterial, up[i]);
        smaller = up[i];
      }
      composite.tBloom.value = smaller.texture;
    }

    composite.tColor.value = color;
    composite.exposure.value = exposure;
    composite.time.value = this.time % 64;
    composite.aspect.value = w / h;
    this.pass(this.compositeMaterial, null);
  }

  disposeTargets() {
    const all = [this.sceneTarget, ...(this.aoTargets || []), ...this.bloomDown, ...this.bloomUp, this.dofTarget];
    for (const target of all) {
      if (!target) continue;
      target.depthTexture?.dispose();
      target.dispose();
    }
    this.sceneTarget = this.dofTarget = this.aoTargets = null;
    this.bloomDown = [];
    this.bloomUp = [];
  }

  dispose() {
    this.disposeTargets();
    this.quad.geometry.dispose();
    for (const m of [this.aoMaterial, this.aoBlurMaterial, this.prefilterMaterial, this.downMaterial, this.upMaterial, this.dofMaterial, this.compositeMaterial]) m.dispose();
  }
}

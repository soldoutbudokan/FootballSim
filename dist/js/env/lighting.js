import * as THREE from '../../vendor/three.module.js';
import { HDRLoader } from '../../vendor/HDRLoader.js';

// Lighting presets. Sun azimuth is a compass bearing (0 = north = downfield,
// 90 = east = the second field). Colours are sRGB hex. Intensities are in
// three.js physical units (directional: lux-like irradiance; spot: candela).
// `fogDensity` is the haze extinction per yard at ground level (see
// atmosphere.js). `grade` is the look the post-processing pipeline applies
// after tone mapping (post.js): contrast and saturation (1 = unchanged), the
// tints multiplied into shadows and highlights, vignette and grain amounts,
// bloom strength and how much of the ambient occlusion is applied.
export const PRESETS = {
  day: {
    sun: { elevation: 38, azimuth: 276, color: '#fff0da', intensity: 3.6 },
    hemisphere: { sky: '#c6daf5', ground: '#55603a', intensity: 0.28 },
    environment: { source: 'hdr', intensity: 0.4 },
    exposure: 0.85,
    fog: '#a8bfd6', fogDensity: 0.0007,
    grade: { contrast: 1.09, saturation: 0.92, shadows: '#f3f6ff', highlights: '#fffaf1', vignette: 0.16, grain: 0.012, bloom: 0.12, ao: 1 },
    sky: {
      turbidity: 2.0, rayleigh: 3.0, mieCoefficient: 0.0022, mieDirectionalG: 0.8, gain: 0.26, saturation: 1.7,
      cloudCoverage: 0.64, cloudSoftness: 0.17, cloudOpacity: 0.9, cloudLit: '#ffffff', cloudShade: '#a4adb8',
      cloudBrightness: 1.35, hazeHeight: 0.05, night: false,
    },
    poles: 0, windows: 0.45, lamps: 0,
  },
  sunset: {
    // Golden hour: a low, deep orange sun with long shadows, a dimmer cool
    // fill from the darkening sky, warm haze, lights coming on indoors.
    sun: { elevation: 9, azimuth: 292, color: '#ff9a4e', intensity: 4.4 },
    hemisphere: { sky: '#959ac0', ground: '#5a4230', intensity: 0.88 },
    environment: { source: 'sky', intensity: 0.8 },
    exposure: 1.12,
    fog: '#c98d5e', fogDensity: 0.0011,
    grade: { contrast: 1.05, saturation: 0.94, shadows: '#eef2ff', highlights: '#fff5e8', vignette: 0.22, grain: 0.014, bloom: 0.16, ao: 0.9 },
    sky: {
      turbidity: 8, rayleigh: 3.2, mieCoefficient: 0.008, mieDirectionalG: 0.88, gain: 0.4, saturation: 1.35,
      cloudCoverage: 0.58, cloudSoftness: 0.24, cloudOpacity: 0.85, cloudLit: '#ff9e62', cloudShade: '#5b4b60',
      cloudBrightness: 1.0, hazeHeight: 0.07, night: false,
    },
    poles: 0, windows: 0.7, lamps: 0.3,
  },
  night: {
    // The directional light stands in for the dominant (north-west) pole bank:
    // it is the one shadow-casting light. The four spot lights add the pools.
    sun: { elevation: 52, azimuth: 300, color: '#e4ecff', intensity: 0.3, skyElevation: -9 },
    hemisphere: { sky: '#2b3c5c', ground: '#0b100a', intensity: 0.3 },
    environment: { source: 'sky', intensity: 1.0 },
    exposure: 1.15,
    fog: '#141d2a', fogDensity: 0.0016,
    grade: { contrast: 1.06, saturation: 0.87, shadows: '#e9f0ff', highlights: '#fffdf8', vignette: 0.28, grain: 0.02, bloom: 0.2, ao: 1 },
    sky: {
      turbidity: 2, rayleigh: 1, mieCoefficient: 0.005, mieDirectionalG: 0.8, gain: 0.3,
      cloudCoverage: 0.6, cloudSoftness: 0.3, cloudOpacity: 0.7, cloudLit: '#3a4252', cloudShade: '#171c25',
      cloudBrightness: 0.06, hazeHeight: 0.1, night: true,
    },
    poles: 5200, windows: 1.0, lamps: 1,
  },
};

const SHADOW_SIZE = 48;   // yards covered by the sun's shadow map during play
const POLE_CONE = 41;     // half-angle in degrees of each pole bank's beam
const UP = new THREE.Vector3(0, 1, 0);
const TMP_RIGHT = new THREE.Vector3(), TMP_UP = new THREE.Vector3();

// Spot-light shadow aimed at the action instead of down the cone axis, so the
// dominant pole bank's shadow map spends its texels on the play (the same
// ~48 yd area the sun's frustum covers by day). The light itself, its cone and
// its pool on the grass are unchanged. (three.js does not export
// SpotLightShadow, so the instance's updateMatrices is wrapped.)
function aimShadowAtAction(spot) {
  const shadow = spot.shadow, base = shadow.updateMatrices.bind(shadow);
  shadow.aim = new THREE.Object3D();
  shadow.coverRadius = SHADOW_SIZE / 2;   // yards around the aim point
  shadow.updateMatrices = light => {
    const distance = light.position.distanceTo(shadow.aim.position);
    shadow.focus = Math.min(1.5, Math.atan(shadow.coverRadius / Math.max(1, distance)) / light.angle);
    shadow.aim.updateMatrixWorld();
    const target = light.target;
    light.target = shadow.aim;
    base(light);
    light.target = target;
  };
}

export class Lighting {
  constructor(scene, renderer, sky, assetManager) {
    this.scene = scene;
    this.renderer = renderer;
    this.sky = sky;
    this.mode = 'day';
    this.preset = PRESETS.day;

    this.hemisphere = new THREE.HemisphereLight('#ffffff', '#445533', 0.7);
    scene.add(this.hemisphere);

    this.sun = new THREE.DirectionalLight('#ffffff', 3);
    this.sun.castShadow = true;
    const shadow = this.sun.shadow;
    shadow.mapSize.set(1024, 1024);
    shadow.camera.near = 1;
    shadow.camera.far = 260;
    shadow.bias = -0.0004;
    shadow.normalBias = 0.025;
    shadow.radius = 2;
    scene.add(this.sun, this.sun.target);
    this.sunDirection = new THREE.Vector3(0, 1, 0);
    this.focus = new THREE.Vector3(0, 0, -35);
    this.spots = [];
    this.casters = [];             // the pole lights that cast shadows at night
    this.poleShadows = 1;          // how many of them (the nearest to the play)
    this.shadowsEnabled = true;
    this.setShadowSize(SHADOW_SIZE);
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.generated = new Map();
    this.hdr = null;
    new HDRLoader(assetManager).load('./assets/noon_grass_1k.hdr', texture => {
      texture.mapping = THREE.EquirectangularReflectionMapping;
      this.hdr = texture;
      if (this.preset.environment.source === 'hdr') this.applyEnvironment();
    });
    scene.fog = new THREE.FogExp2('#c9d6df', 0.0017);
  }

  // Pole lights: `heads` are {position, aim} in scene coordinates.
  addPoleLights(heads) {
    for (const head of heads) {
      const spot = new THREE.SpotLight('#eef3ff', 0, 0, THREE.MathUtils.degToRad(POLE_CONE), 0.7, 2);
      spot.position.copy(head.position);
      spot.target.position.copy(head.aim);
      spot.visible = false;
      aimShadowAtAction(spot);
      spot.shadow.camera.near = 6;
      spot.shadow.camera.far = 160;
      spot.shadow.bias = -0.0003;
      spot.shadow.normalBias = 0.03;
      spot.shadow.radius = 2;
      spot.shadow.mapSize.copy(this.sun.shadow.mapSize);
      this.scene.add(spot, spot.target);
      this.spots.push(spot);
    }
  }

  // By day the sun casts the shadows. At night the pole banks nearest the
  // play do: one on Balanced, two from High up, so every player throws the
  // crossed pair of shadows that says "under the lights". None on the
  // performance tier.
  updateShadowCasters() {
    const night = this.preset.poles > 0;
    this.sun.castShadow = this.shadowsEnabled && !night;
    for (const spot of this.spots) spot.castShadow = this.shadowsEnabled && night && this.casters.includes(spot);
  }

  // The pole lights nearest a scene-space point (re-chosen only between reps).
  chooseDominant(point) {
    const distance = spot => Math.hypot(spot.position.x - point.x, spot.position.z - point.z);
    this.casters = [...this.spots].sort((a, b) => distance(a) - distance(b)).slice(0, this.poleShadows);
    this.updateShadowCasters();
  }

  get dominant() { return this.casters[0] || null; }

  setPreset(mode) {
    this.mode = PRESETS[mode] ? mode : 'day';
    const p = this.preset = PRESETS[this.mode];
    this.sky.apply(p);
    if (p.sun.skyElevation !== undefined) this.sky.setSun(p.sun.skyElevation, p.sun.azimuth);
    const el = THREE.MathUtils.degToRad(p.sun.elevation), az = THREE.MathUtils.degToRad(p.sun.azimuth);
    this.sunDirection.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)).normalize();
    this.sun.color.set(p.sun.color);
    this.sun.intensity = p.sun.intensity;
    this.hemisphere.color.set(p.hemisphere.sky);
    this.hemisphere.groundColor.set(p.hemisphere.ground);
    this.hemisphere.intensity = p.hemisphere.intensity;
    this.scene.fog.color.set(p.fog);
    this.scene.fog.density = p.fogDensity;
    this.renderer.toneMappingExposure = p.exposure;
    for (const spot of this.spots) {
      spot.visible = p.poles > 0;
      spot.intensity = p.poles;
    }
    this.applyEnvironment();
    this.followFocus(this.focus, true);
  }

  applyEnvironment() {
    const p = this.preset;
    let texture = null;
    if (p.environment.source === 'hdr') texture = this.hdr;
    else texture = this.generatedEnvironment(this.mode);
    this.scene.environment = texture;
    this.scene.environmentIntensity = p.environment.intensity;
    this.onEnvironment?.(texture, p);
  }

  // Pre-filtered environment rendered from the sky itself (plus a ground
  // hemisphere and, at night, the four light banks) so reflections match.
  generatedEnvironment(mode) {
    if (this.generated.has(mode)) return this.generated.get(mode);
    const envScene = new THREE.Scene();
    envScene.add(this.sky.clone());
    const p = PRESETS[mode];
    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(90, 32).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(p.hemisphere.ground).multiplyScalar(mode === 'night' ? 0.25 : 0.9) }),
    );
    ground.position.y = -1.5;
    envScene.add(ground);
    if (p.poles > 0) {
      const lamp = new THREE.MeshBasicMaterial({ color: new THREE.Color(14, 14, 15) });
      for (const spot of this.spots) {
        const panel = new THREE.Mesh(new THREE.PlaneGeometry(4, 2), lamp);
        const dir = spot.position.clone().sub(spot.target.position).normalize();
        panel.position.copy(dir.multiplyScalar(60));
        panel.lookAt(0, 0, 0);
        envScene.add(panel);
      }
    }
    const target = this.pmrem.fromScene(envScene, 0.02, 0.5, 600);
    this.generated.set(mode, target.texture);
    return target.texture;
  }

  setQuality(profile) {
    const enabled = profile.shadow > 0;
    this.shadowsEnabled = enabled;
    const poleShadows = profile.shadow >= 2048 ? 2 : 1;
    if (poleShadows !== this.poleShadows) {
      this.poleShadows = poleShadows;
      this.chooseDominant(this.focus);
    }
    this.renderer.shadowMap.enabled = enabled;
    if (enabled) {
      for (const light of [this.sun, ...this.spots]) {
        const shadow = light.shadow;
        if (shadow.mapSize.x === profile.shadow) continue;
        shadow.mapSize.set(profile.shadow, profile.shadow);
        if (shadow.map) {
          shadow.map.dispose();
          shadow.map = null;
        }
      }
    }
    this.updateShadowCasters();
  }

  // Width in yards of the square area the shadow map covers.
  setShadowSize(size) {
    if (this.shadowSize === size) return;
    this.shadowSize = size;
    const camera = this.sun.shadow.camera;
    camera.left = camera.bottom = -size / 2;
    camera.right = camera.top = size / 2;
    camera.updateProjectionMatrix();
    for (const spot of this.spots) spot.shadow.coverRadius = size / 2;
  }

  // Keeps the tight shadow frustum centred on the action. The centre snaps to
  // whole shadow texels in light space so edges do not shimmer as it moves.
  followFocus(point, immediate = false) {
    this.focus.copy(point);
    const d = this.sunDirection;
    const right = TMP_RIGHT.crossVectors(UP, d).normalize();
    const up = TMP_UP.crossVectors(d, right);
    const texel = this.shadowSize / this.sun.shadow.mapSize.x;
    const a = Math.round(point.dot(right) / texel) * texel;
    const b = Math.round(point.dot(up) / texel) * texel;
    const c = point.dot(d);
    const snapped = right.multiplyScalar(a).addScaledVector(up, b).addScaledVector(d, c);
    this.sun.target.position.copy(snapped);
    this.sun.position.copy(snapped).addScaledVector(d, 120);
    this.sun.target.updateMatrixWorld();
    this.sun.updateMatrixWorld();
    for (const spot of this.spots) spot.shadow.aim.position.copy(point);
    if (immediate) this.chooseDominant(point);
  }
}

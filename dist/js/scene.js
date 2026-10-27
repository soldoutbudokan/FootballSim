import * as THREE from '../vendor/three.module.js';
import { Environment } from './environment.js';
import { Athletes } from './athletes.js';
import { pixelRatio, PROFILES } from './graphics.js';
import { CameraDirector, normalizeCameraMode } from './env/camera.js';

// Orchestrates the renderer, the camera and the two visual layers
// (Environment: field, facility, sky and light; Athletes: players and ball).
// Simulation space is yards with +z toward the opponent's goal; scene space
// negates z.
export class FieldScene {
  constructor(canvas, players) {
    this.canvas = canvas;
    this.scene = new THREE.Scene();
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'default' });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.camera = new THREE.PerspectiveCamera(42, 1, 0.25, 2600);
    this.director = new CameraDirector(this.camera);
    this.profile = PROFILES[1];
    this.scale = 1;
    this.firstFrame = true;
    this.currentSpot = 35;

    this.assetsReady = false;
    this.assetManager = new THREE.LoadingManager(() => { this.assetsReady = true; });
    this.assetManager.onError = url => console.error('Environment asset failed: ' + url);
    this.environment = new Environment(this.scene, this.renderer, this.assetManager);
    this.athletes = new Athletes(this.scene, players);
    this.projectVector = new THREE.Vector3();
    this.groundFocus = new THREE.Vector3();
    this.resize();
  }

  // Camera mode ids: 'game' (default), 'broadcast', 'all22'. Unknown or old
  // saved values ('wide', 'qb') fall back to 'game'.
  get cameraMode() { return this.director.mode; }
  set cameraMode(mode) {
    const next = normalizeCameraMode(mode);
    if (next !== this.director.mode) this.director.mode = next;
  }

  get firstDown() { return this.environment.firstDown; }

  setLighting(mode) { this.environment.setLighting(mode); }

  setQuality(profile, scale = 1) {
    this.profile = profile;
    this.scale = scale;
    this.environment.setQuality(profile);
    this.athletes.setQuality(profile);
    this.resize();
  }

  resize() {
    const w = this.canvas.clientWidth || window.innerWidth, h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setPixelRatio(pixelRatio(w, h, window.devicePixelRatio || 1, this.profile, this.scale));
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  setPlay(play, spot, flip, toGo = null) {
    this.currentSpot = spot;
    this.environment.setPlay(play, spot, flip, toGo);
  }

  // Pixel position of a simulation-space point (receiver badges).
  project(x, y, z) {
    this.projectVector.set(x, y, -z).project(this.camera);
    return {
      x: (this.projectVector.x * 0.5 + 0.5) * this.canvas.clientWidth,
      y: (-0.5 * this.projectVector.y + 0.5) * this.canvas.clientHeight,
      visible: this.projectVector.z < 1 && this.projectVector.z > -1 && Math.abs(this.projectVector.x) < 1.05 && Math.abs(this.projectVector.y) < 1.05,
    };
  }

  render(state, dt, { menu = false, showArt = false, replay = false } = {}) {
    this.environment.art.visible = showArt && !menu && state.phase === 'presnap';
    if (this.firstFrame) this.director.cut();
    this.firstFrame = false;
    this.director.update(state, dt, { menu, replay, aspect: this.camera.aspect });
    // Grass tufts only matter for the low cameras.
    const low = menu || replay || this.director.mode === 'game';
    this.environment.update(state, dt, { menu, focus: this.tuftFocus(), grass: low });
    this.athletes.update(state, dt, { menu });
    this.renderer.render(this.scene, this.camera);
  }

  // Centre of the grass tile: on the ground about 10 yd in front of the camera.
  tuftFocus() {
    const camera = this.camera.position, target = this.director.target;
    const dx = target.x - camera.x, dz = -target.z - camera.z, length = Math.hypot(dx, dz) || 1;
    return this.groundFocus.set(camera.x + dx / length * 10, 0, camera.z + dz / length * 10);
  }
}

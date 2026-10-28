// Close-up visual QA uses the production geometry and materials. No external
// models, development-only modules or extra runtime files are needed.
export async function captureModels(page) {
  const base = new URL('.', page.url()).href;
  // Stop the game loop before constructing a small, deterministic studio scene.
  const studio = new URL('__model-studio__.html', base).href;
  await page.route(studio, route => route.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><html><head><link rel="icon" href="./icon.svg"><style>body{margin:0;background:#d5dce0;font:14px system-ui;color:#172c40}canvas{display:block}#label{position:fixed;left:36px;top:26px;font-size:18px;font-weight:600;letter-spacing:.08em}</style></head><body><div id="label">PLAYER MODELS · FULL DETAIL</div></body></html>',
  }));
  await page.goto(studio);
  await page.evaluate(async base => {
    const THREE = await import(new URL('vendor/three.module.js', base).href);
    const { Squad, Rig, createGeometries } = await import(new URL('js/athletes/rig.js', base).href);
    const { createMaterials } = await import(new URL('js/athletes/uniform.js', base).href);
    const { Pose, armAngles } = await import(new URL('js/athletes/pose.js', base).href);
    const width = innerWidth, height = innerHeight;
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(width, height); renderer.setPixelRatio(1);
    renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    document.body.append(renderer.domElement);
    const scene = new THREE.Scene(); scene.background = new THREE.Color('#d5dce0');
    scene.add(new THREE.HemisphereLight('#eaf4ff', '#687264', 2.3));
    const key = new THREE.DirectionalLight('#fff1dc', 3); key.position.set(3, 6, 6); key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024); Object.assign(key.shadow.camera, { left: -5, right: 5, top: 4, bottom: -4 });
    scene.add(key);
    const fill = new THREE.DirectionalLight('#c5dfff', 1.2); fill.position.set(-4, 3, -5); scene.add(fill);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(30, 30), new THREE.MeshStandardMaterial({ color: '#c3ccd0', roughness: 1 }));
    floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; scene.add(floor);
    const specs = [
      { id: 'QB', role: 'qb', number: 12, team: 'offense' },
      { id: 'X', role: 'wr', number: 81, team: 'offense' },
      { id: 'C', role: 'ol', number: 65, team: 'offense' },
      { id: 'CB1', role: 'cb', number: 24, team: 'defense' },
      { id: 'R', role: 'rb', number: 22, team: 'offense' },
    ];
    const materials = createMaterials(specs), squad = new Squad(scene, specs.length, materials);
    const full = createGeometries(), low = createGeometries({ low: true });
    const rigs = specs.map((spec, i) => new Rig(squad, spec, i, full, {
      offset: materials.atlas.offsets.get(spec.id), scale: materials.atlas.scale, white: materials.atlas.white,
    }, low));
    squad.finish();
    rigs.forEach((rig, i) => {
      const pose = new Pose(), d = rig.dims;
      pose.pelvis.set(0, d.hipY - 0.03, 0);
      pose.feet[0].set(0.16, d.ankle, 0.015); pose.feet[1].set(-0.16, d.ankle, -0.015);
      armAngles(pose, 0, d, 0.08, 0.2, 0.12); armAngles(pose, 1, d, -0.05, 0.18, 0.12);
      rig.apply(pose, (i - 2) * 1.18, 0, i === 4 ? Math.PI : i === 3 ? -0.7 : 0.2);
    });
    squad.commit();
    const camera = new THREE.PerspectiveCamera(30, width / height, 0.05, 100);
    camera.position.set(2.1, 2.3, 8.4); camera.lookAt(0, 1.02, 0);
    renderer.render(scene, camera);
    window.modelStudio = { renderer, scene, camera, squad };
  }, base);
  await page.screenshot({ path: 'test-results/10-models-full.png' });
  await page.evaluate(() => {
    const { renderer, scene, camera, squad } = window.modelStudio;
    squad.setLevels(new Uint8Array(5).fill(1)); squad.setDetail(false);
    document.querySelector('#label').textContent = 'PLAYER MODELS · REDUCED DETAIL';
    renderer.render(scene, camera);
  });
  await page.screenshot({ path: 'test-results/11-models-reduced.png' });
}

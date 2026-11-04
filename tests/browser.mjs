// End-to-end browser check. Run on a machine with Playwright and Chromium installed:
//   TEST_URL=http://127.0.0.1:8000 node tests/browser.mjs
// It drives the real UI (keyboard, mouse, dialogs) and fails on any console error or failed request.
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { PLAYS, ROUTE_COLORS, RECEIVERS, formationFor, passKey, readParts, readText } from '../dist/js/plays.js';
import { captureModels } from './model-screenshots.mjs';

const url = process.env.TEST_URL || 'http://127.0.0.1:8000';
await mkdir('test-results', { recursive: true });
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.TEST_CHROME_PATH || undefined,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.setDefaultTimeout(60000);
// Without a published character model the game's HEAD probe for
// ./models/player.glb answers 404 by design (it then keeps the procedural
// athletes); that one request is not an error.
const modelProbe = u => /\/models\/player\.(glb|fbx)$/.test(new URL(u || 'http://x/').pathname);
page.on('pageerror', e => errors.push(e.message));
page.on('response', r => { if (r.status() >= 400 && !(r.request().method() === 'HEAD' && modelProbe(r.url()))) errors.push(r.status() + ' ' + r.url()); });
page.on('console', m => { if (m.type() === 'error' && !modelProbe(m.location()?.url)) errors.push(m.text() + ' ' + (m.location()?.url || '')); });

const game = fn => page.evaluate(fn);
const sim = expression => page.evaluate(`window.footballsim.sim.${expression}`);
const visible = selector => page.locator(selector).isVisible();
const shot = name => page.screenshot({ path: `test-results/${name}.png` });
const waitFor = (fn, timeout = 60000) => page.waitForFunction(fn, {}, { timeout });
const activeMenuItem = () => game(() => document.querySelector('.menu-item.is-active')?.id);

try {
  // A preference saved by an older version ('wide' camera) must fall back to the game camera.
  await page.addInitScript(() => {
    try { localStorage.setItem('footballsim.preferences.v1', JSON.stringify({ camera: 'wide' })); } catch { /* ignore */ }
  });
  await page.goto(url + '/?debug=1');
  await waitFor(() => window.footballsim?.view.assetsReady && window.footballsim.view.renderer.info.render.calls > 0);
  await game(() => document.fonts.ready);
  assert.equal(await visible('#error'), false);
  assert.equal(await page.locator('#camera').inputValue(), 'game');
  assert.equal(await game(() => window.footballsim.view.cameraMode), 'game');
  assert.deepEqual(await page.locator('#lighting option').allTextContents(), ['Afternoon', 'Golden hour', 'Under the lights']);
  assert.deepEqual(await page.locator('#camera option').allTextContents(), ['Game camera', 'Broadcast', 'All-22']);
  await shot('01-welcome');

  // Title menu: keyboard navigation, fullscreen, then Practice.
  assert.equal(await activeMenuItem(), 'start');
  await page.keyboard.press('ArrowDown');
  assert.equal(await activeMenuItem(), 'menu-playbook');
  await page.keyboard.press('ArrowUp');
  assert.equal(await activeMenuItem(), 'start');
  await page.keyboard.press('f');
  await waitFor(() => !!document.fullscreenElement);
  await page.keyboard.press('f');
  await waitFor(() => !document.fullscreenElement);
  await page.getByRole('button', { name: 'Practice', exact: true }).click();
  await waitFor(() => window.footballsim.sim.phase === 'presnap');
  assert.equal(await visible('#welcome'), false);
  assert.equal(await page.locator('#offense').inputValue(), 'random');
  assert.equal(await page.locator('#coverage').inputValue(), 'random');
  assert.equal(await page.locator('#difficulty').inputValue(), 'allpro');
  assert.equal(await page.locator('#practice-mode').inputValue(), 'drive');
  assert.equal(await sim('config.difficulty'), 'allpro');
  assert.equal(await sim('config.mode'), 'drive');
  assert.equal(await visible('#down-distance'), true);
  assert.equal(await page.locator('#down-distance').innerText(), '1ST & 10');
  assert.equal(await visible('#to-go-cell'), true);
  assert.equal(await game(() => window.footballsim.view.firstDown.visible), true);
  await shot('02-presnap');

  // Camera cycling: game -> broadcast -> all22 -> game.
  for (const id of ['broadcast', 'all22', 'game']) {
    await page.keyboard.press('c');
    assert.equal(await game(() => window.footballsim.view.cameraMode), id);
  }

  // Playbook: choose a play, then switch to the light graphics tier for the interaction checks.
  await page.getByRole('button', { name: 'Playbook', exact: true }).click();
  assert.equal(await page.locator('.play-card').count(), PLAYS.length);
  // The expanded book remains searchable, and diagrams/lineups share the formation data.
  const newPlay = PLAYS.find(p => p.formationId && p.formationId !== 'doubles');
  assert.ok(newPlay, 'includes another formation');
  await page.locator('#play-formation-filter').selectOption({ label: newPlay.formation });
  assert.equal(await page.locator('.play-card').count(), PLAYS.filter(p => p.formation === newPlay.formation).length);
  await page.locator('#play-search').fill(newPlay.name);
  assert.equal(await page.locator('.play-card').count(), 1);
  await page.getByRole('button', { name: newPlay.name + ' — ' + newPlay.tag, exact: true }).click();
  assert.equal(await sim('play.id'), newPlay.id);
  const alignment = formationFor(newPlay);
  for (const id of ['QB', 'X', 'Y', 'A', 'B', 'R']) {
    const spec = alignment.find(p => p.id === id);
    const actual = await page.evaluate(id => {
      const s = window.footballsim.sim, p = s.byId[id]; return [p.x, p.z - s.spot];
    }, id);
    assert.ok(Math.abs(actual[0] - spec.x) < 1e-8 && Math.abs(actual[1] - spec.z) < 1e-8, id + ' uses the called alignment');
  }
  // The coaching cue names receivers by pass key, each in a badge of his route colour.
  const rgb = hex => 'rgb(' + [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)).join(', ') + ')';
  const cue = await page.locator('#read-tip').evaluate(el => ({ text: el.textContent,
    badges: [...el.querySelectorAll('.read-badge')].map(b => [b.textContent, getComputedStyle(b).backgroundColor]) }));
  assert.equal(cue.text, readText(newPlay));
  assert.deepEqual(cue.badges, readParts(newPlay).filter(p => p.receiver !== undefined).map(p => [passKey(p.receiver).label, rgb(ROUTE_COLORS[p.receiver])]));
  // Helmet badges and throw buttons show the same keys, the buttons in A W S D Space order.
  const labels = () => game(() => ({
    markers: ['X', 'Y', 'A', 'B', 'R'].map(id => document.getElementById('marker-' + id).textContent),
    buttons: [...document.querySelectorAll('.target-button')].sort((a, b) => a.style.order - b.style.order).map(b => b.textContent),
  }));
  assert.deepEqual(await labels(), { markers: ['A', 'W', 'S', 'D', 'Space'], buttons: ['A', 'W', 'S', 'D', 'Space'] });
  await page.locator('#playbook-open').click();
  await page.locator('#play-formation-filter').selectOption('');
  await page.locator('#play-search').fill('no such concept');
  assert.equal(await page.locator('.play-card').count(), 0);
  assert.match(await page.locator('#playbook-results').innerText(), /No matching plays/);
  // Search reads the cue as plain text, with the pass keys.
  const cueQuery = readText(newPlay).slice(-40);
  assert.match(cueQuery, /\b([AWSD]|Space)\b/);
  await page.locator('#play-search').fill(cueQuery);
  assert.equal(await page.locator('.play-card').count(), PLAYS.filter(p => readText(p).includes(cueQuery)).length);
  assert.equal(await page.locator('.play-card .play-read').first().textContent(), readText(PLAYS.find(p => readText(p).includes(cueQuery))));
  await page.locator('#play-search').fill('');
  await shot('03-playbook');
  await page.getByRole('button', { name: 'Mesh concept — SHORT', exact: true }).click();
  // Capture the default visual tier above, then use the low GPU budget for
  // interaction checks on shared software-rendering CI machines.
  await page.locator('#settings-open').click();
  await page.locator('#graphics').selectOption('performance');
  await page.locator('#coverage').selectOption('cover3');
  await page.locator('#difficulty').selectOption('pro');
  await page.locator('#practice-mode').selectOption('reps');
  await page.locator('#apply-settings').click();
  assert.equal(await sim('play.id'), 'mesh');

  // Hot route: the tight end (pass key S) to an out (route 5).
  await page.keyboard.press('h');
  assert.equal(await visible('#hot-routes'), true);
  await page.keyboard.press('s');
  await page.keyboard.press('5');
  assert.equal(await sim('hotRoutes.A'), 'out');
  assert.match(await page.locator('#hot-route-current').innerText(), /Receiver S/i);
  await shot('08-hot-routes');
  await page.getByRole('button', { name: 'Close hot routes', exact: true }).click();

  // Pass: a quarter-second hold must already select a bullet. Keep this input
  // interval exact even on slow CI renderers, then let the real throw play out.
  await page.getByRole('button', { name: 'Snap ball' }).click();
  await waitFor(() => window.footballsim.sim.time > 1.5);
  const chargedStyle = await game(() => {
    const original = Object.getOwnPropertyDescriptor(performance, 'now');
    let now = performance.now();
    Object.defineProperty(performance, 'now', { configurable: true, value: () => now });
    try {
      const key = (type, code) => window.dispatchEvent(new KeyboardEvent(type, { key: code, code, bubbles: true }));
      // Left held before the pass key keeps moving him; Up pressed during the charge leads.
      key('keydown', 'ArrowLeft');
      key('keydown', 'KeyA');
      key('keydown', 'ArrowUp');
      now += 250;
      key('keyup', 'KeyA');
      key('keyup', 'ArrowUp');
      key('keyup', 'ArrowLeft');
      const intent = window.footballsim.sim.throwIntent;
      return intent && [intent.id, intent.style, intent.lead];
    } finally {
      if (original) Object.defineProperty(performance, 'now', original);
      else delete performance.now;
    }
  });
  assert.deepEqual(chargedStyle, ['X', 'bullet', { x: 0, z: 1 }]);
  await waitFor(() => window.footballsim.sim.stats.attempts === 1);
  assert.equal(await sim('pass.style'), 'bullet');
  await waitFor(() => window.footballsim.sim.phase === 'dead');
  assert.equal(await visible('#result'), true);
  await shot('04-pass-result');

  // Replay.
  await page.locator('#replay-open').click();
  assert.equal(await visible('#replay-controls'), true);
  await page.waitForTimeout(800);
  await shot('05-replay');
  await page.locator('#replay-close').click();
  assert.equal(await visible('#replay-controls'), false);

  // Run play with sprint.
  await page.getByRole('button', { name: 'Call play', exact: true }).click();
  await page.getByRole('button', { name: 'Inside zone — ' + PLAYS.find(p => p.id === 'zone').tag, exact: true }).click();
  await page.getByRole('button', { name: 'Snap ball' }).click();
  await waitFor(() => window.footballsim.sim.handoff);
  await page.keyboard.down('ArrowUp');
  await page.keyboard.down('Shift');
  await waitFor(() => window.footballsim.sim.phase === 'dead');
  await page.keyboard.up('ArrowUp');
  await page.keyboard.up('Shift');
  assert.equal(await sim('stats.attempts'), 1);

  // Pause freezes the simulation.
  await page.locator('#next').click();
  await page.keyboard.press('Escape');
  assert.equal(await visible('#pause'), true);
  // Passer rating to one decimal, from the session's passing line.
  const stats = await sim('stats');
  const part = v => Math.max(0, Math.min(2.375, v)), att = stats.attempts;
  const rating = (part((stats.completions / att - 0.3) * 5) + part((stats.passing / att - 3) * 0.25)
    + part(stats.passTd / att * 20) + part(2.375 - stats.ints / att * 25)) / 6 * 100;
  const cells = await page.locator('#session-stats > div').evaluateAll(els => els.map(el => [el.querySelector('span').textContent, el.querySelector('strong').textContent]));
  assert.equal(cells.length, 9);
  assert.deepEqual(cells.find(([label]) => label === 'Passer rating'), ['Passer rating', rating.toFixed(1)]);
  await shot('10-pause');
  const pausedAt = await sim('time');
  await page.waitForTimeout(150);
  assert.equal(await sim('time'), pausedAt);
  await page.locator('#resume').click();
  assert.equal(await visible('#pause'), false);

  // Settings: performance tier, sunset, Cover 0 blitz, Move the chains.
  await page.locator('#settings-open').click();
  await page.locator('#graphics').selectOption('performance');
  assert.equal(await game(() => window.footballsim.view.renderer.shadowMap.enabled), false);
  await page.locator('#lighting').selectOption('sunset');
  await page.locator('#coverage').selectOption('blitz');
  await page.locator('#practice-mode').selectOption('drive');
  await page.locator('#apply-settings').click();
  assert.equal(await sim('coverage'), 'blitz');
  assert.equal(await visible('#down-distance'), true);
  assert.equal(await page.locator('#down-distance').innerText(), '1ST & 10');
  assert.equal(await visible('#to-go-cell'), true);
  assert.match(await page.locator('#drive-detail').innerText(), /10 YDS TO GO/);
  assert.equal(await game(() => window.footballsim.view.firstDown.visible), true);
  await shot('07-move-the-chains');

  // Throw it away, flip the next play and keep the drive state.
  await page.locator('#playbook-open').click();
  await page.getByRole('button', { name: 'Quick slants — QUICK GAME', exact: true }).click();
  // Space snaps; its release right after the snap must not throw.
  await page.keyboard.press('Space');
  assert.equal(await sim('phase'), 'live');
  assert.equal(await visible('#charge'), false);
  await waitFor(() => window.footballsim.sim.time > .4);
  // Once the pass play is live Space charges the checkdown; a throw-away
  // while it is held ends the rep, and the late release neither throws nor toasts.
  await game(() => { document.getElementById('toast').hidden = true; });
  await page.keyboard.down('Space');
  assert.equal(await visible('#charge'), true);
  assert.equal(await page.locator('#charge-target').textContent(), 'Space');
  await page.keyboard.press('x');
  await waitFor(() => window.footballsim.sim.phase === 'dead');
  await page.keyboard.up('Space');
  assert.equal(await sim('result.kind'), 'incomplete');
  assert.equal(await visible('#charge'), false);
  assert.equal(await visible('#toast'), false);
  await page.locator('#result-playbook').click();
  await page.locator('#flip-play').check();
  assert.equal(await sim('down'), 2);
  await page.getByRole('button', { name: 'Mesh concept — SHORT', exact: true }).click();
  assert.equal(await sim('config.flip'), true);
  // Flipped, A still throws to the left outside receiver (now B), and every label follows.
  assert.deepEqual(await labels(), { markers: ['D', 'W', 'S', 'A', 'Space'], buttons: ['A', 'W', 'S', 'D', 'Space'] });
  assert.equal(await page.locator('#read-tip').textContent(), readText(PLAYS.find(p => p.id === 'mesh'), true));
  assert.equal(await page.locator('#down-distance').innerText(), '2ND & 10');

  // Audible keeps the drive and the defensive alignment.
  const defense = () => game(() => window.footballsim.sim.players.filter(p => p.team === 'defense').map(p => [p.id, p.x, p.z]));
  const defenseBeforeAudible = await defense();
  await page.keyboard.press('z');
  assert.equal(await visible('#audibles'), true);
  await shot('09-audibles');
  await page.keyboard.press('4');
  assert.equal(await sim('play.id'), 'slants');
  assert.equal(await page.locator('#down-distance').innerText(), '2ND & 10');
  assert.deepEqual(await defense(), defenseBeforeAudible);

  // All new concepts are reachable by keyboard; digit shortcuts address the visible page.
  await page.keyboard.press('z');
  await page.getByRole('button', { name: 'Next audible page', exact: true }).click();
  assert.match(await page.locator('#audible-page').innerText(), /Page 2/);
  await page.keyboard.press('1');
  assert.equal(await sim('play.id'), PLAYS[8].id);
  assert.equal(await page.locator('#down-distance').innerText(), '2ND & 10');

  await page.locator('#playbook-open').click();
  await page.getByRole('button', { name: 'Coordinator’s call', exact: true }).click();
  assert.equal(await page.locator('#offense').inputValue(), 'random');
  assert.equal(await page.locator('#down-distance').innerText(), '2ND & 10');

  // Phone layout: no horizontal scroll.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(500);
  await shot('06-mobile');
  assert.equal(await game(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.locator('#playbook-open').click();
  assert.equal(await game(() => {
    const d = document.getElementById('playbook'); return d.scrollWidth <= d.clientWidth;
  }), true);
  await page.getByRole('button', { name: 'Close playbook', exact: true }).click();

  // Back to practice reps: drive information and the first-down line disappear.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator('#settings-open').click();
  await page.locator('#practice-mode').selectOption('reps');
  await page.locator('#coverage').selectOption('random');
  await page.locator('#apply-settings').click();
  assert.equal(await visible('#down-distance'), false);
  assert.equal(await visible('#to-go-cell'), false);
  assert.equal(await game(() => window.footballsim.view.firstDown.visible), false);

  // Pause menu returns to the title screen, and Practice resumes.
  await page.keyboard.press('Escape');
  await page.locator('#quit-menu').click();
  assert.equal(await visible('#welcome'), true);
  assert.equal(await visible('#hud'), false);
  await page.keyboard.press('Enter');
  assert.equal(await visible('#welcome'), false);
  assert.equal(await sim('phase'), 'presnap');

  await captureModels(page);
  assert.deepEqual(errors, []);
  console.log('Browser checks passed: render, title menu, camera fallback and cycling, random defaults, play selection, pass keys and labels, passing, the checkdown key, handoff, replay, pause and passer rating, Move the chains, hot routes, audibles, fullscreen, settings, mobile layout, return to menu.');
} catch (error) {
  console.error('Browser state at failure:', await page.evaluate(() => ({
    phase: window.footballsim?.sim.phase, time: window.footballsim?.sim.time, paused: window.footballsim?.paused,
    hidden: document.hidden, quality: window.footballsim?.graphics.profile.id,
  })).catch(() => ({ unavailable: true })));
  console.error('Console errors so far:', errors);
  await page.screenshot({ path: 'test-results/failure.png' }).catch(() => {});
  throw error;
} finally {
  await browser.close();
}

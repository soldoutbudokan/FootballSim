# FootballSim

An original, offense-only 3D American football practice game for GitHub Pages. You run reps on an outdoor practice field: call a play, read a CPU defense from a low camera behind the offense, play quarterback, and take over the receiver or running back once he has the ball.

## Play and publish

Intended Pages address: **https://soldoutbudokan.github.io/FootballSim/**.

One-time repository setup: open **Settings → Pages → Build and deployment → Source → GitHub Actions**. The `Verify FootballSim` workflow runs the simulation and graphics tests, the module and asset checks, the release build and a Chromium gameplay test. A successful push verification on `main` triggers `Publish GitHub Pages`, which can also be run by hand from Actions. No account or backend is needed to play.

The release contains every runtime file: Three.js 0.180.0 and its addons, textures, the HDR environment and the interface fonts. All of them are downloaded from pinned commits or tags and hash-verified by `scripts/vendor.mjs`; credits and licences are in `ASSETS.md`. The published game makes no third-party requests. Paths are relative, so it works under `/FootballSim/` or any other static subdirectory, and the build versions CSS and the whole JavaScript import graph together so a browser never mixes two releases.

## The practice facility

- **Two natural-grass NFL fields** side by side, 120 × 53⅓ yd, with 4-inch lines, 8-inch goal lines, a 6 ft white border, hash marks at the NFL inbound lines (70 ft 9 in from each sideline), sideline ticks, numbers every 10 yards 12 yards in from the sideline with direction arrows, yellow gooseneck goal posts and orange pylons. No midfield logo and no end-zone lettering. The turf is a desaturated natural green with 5-yard mowing stripes, worn grass between the hashes, and paint that lets the grass show through.
- **Around the field:** a two-storey team building with a glass front and a deep roof overhang behind the offense, a green windscreen fence on chain-link posts, four practice light poles, a scaffold film tower, a scissor lift with a camera platform, a small aluminium bleacher at the 50, and sideline equipment (two-man sled, cones, ball cart, water station, trainer's tent, tackling dummies, benches, a play clock on a trailer) with a few staff figures. Beyond the fence are trees, gentle terrain, a parking lot and a few low buildings. There is no stadium, crowd, skyline or scoreboard.
- **Sky and light:** the three.js physically based `Sky` with procedural clouds drives the sun and the fog colour. *Afternoon* uses an HDR environment for reflections; *Golden hour* has a low warm sun and long shadows; *Under the lights* uses four pole-light banks with visible pools, the nearest one casting shadows. ACES tone mapping with an exposure per preset.
- **Shadows:** a tight shadow frustum (about 48 × 48 yd) follows the ball and the controlled player each frame; every player also has a soft contact shadow. Instanced grass tufts with a cheap wind sway grow around the camera on the low views.

## Athletes

Twenty-two procedural athletes built around a 6 ft 2 in frame, with wider lineman builds and distinct skill-position proportions: a helmet shell with jaw flaps and ear holes, facemask, chin strap and a few visors, shoulder pads under the jersey, numbers front and back, pants with knee pads, socks, cleats, gloves, towels and tape. The models have fuller thighs and calves, a tapered torso, shaped shoulder sleeves, sculpted faces, outlined jersey numbers, stitched panels, sleeve trim and pant stripes. Cloth and skin use matte finishes while helmets retain their gloss. Each rig is driven by inverse kinematics and skinned on the GPU, one merged mesh per material for the whole squad.

The team is a fictional navy-and-silver club: navy helmets with a silver stripe, the offense in navy practice jerseys, the defense in white, and the quarterback in the red non-contact jersey.

Animation is procedural and driven by the simulation: stride length and cadence follow speed, the body leans with acceleration and banks into turns, defensive backs backpedal and flip their hips, linemen and backs set in their stances, the quarterback drops, sets and throws through a full motion (the ball leaves the hand 0.23 s into the 0.4 s throw), receivers reach for the ball where it will arrive, carriers tuck it high and tight, and cuts, jukes, blocks, wrap tackles, stumbles and falls each have their own pose. The practice ball is a prolate spheroid with laces and stripes that spirals nose-first along its flight.

Player models: drop a rigged character at dist/models/player.glb (and optional clips at dist/models/clips/<slot>.glb|.fbx) to replace the procedural athletes. See MODELS.md. ?athletes=procedural|skinned|dev overrides the choice.

## Movement and play

The simulation runs at a fixed 120 Hz, in yards and seconds, on a seeded random number generator.

- **Momentum.** Every player has a top speed, an acceleration curve, braking and lateral grip for his position (receivers and corners about 9.3 yd/s, backs and safeties 9.0, linebackers and tight ends about 8.3, the quarterback 7.6, linemen about 7). Acceleration tapers toward top speed, sideways force is limited by grip, so a fast runner turns on a wide arc and a sharp cut needs him to slow down first. A sprinting back needs about 0.6 s to stop and drifts 2–3 yd forward before he can reverse.
- **Cuts and jukes.** A change of direction over about 55° at speed is an automatic plant-and-cut: the runner brakes in proportion to the angle, plants and drives out. Q/E jukes are hard lateral plants that need some speed; they chain every 0.45 s and each one costs speed and a little stamina. There is no stun: defenders are beaten by their own momentum and reaction time.
- **Routes.** Receivers run their stems at full speed and slow into each break according to its angle (a 90° out is taken at about 40 % of top speed), then accelerate out. Throws are aimed with the same movement model, so leading a receiver works.
- **Defense.** Each defender reacts to where the ball carrier was a moment ago (0.40 s at Rookie, 0.28 s at Pro, 0.18 s at All-pro) and aims at an intercept point, so a well-timed cutback makes a pursuer overrun. Cover 3, Cover 2, 2-man and Cover 0 blitz keep their zone and match rules; man defenders align with receivers across formations; backs backpedal facing the quarterback until a receiver threatens them deep, then flip. Linemen engage in pass protection and run blocking and shed blocks when the runner comes close.
- **Playing the ball.** A defender must locate the pass, face its arrival and reach it at a catchable height before attempting a play. Clean catches, swats and misses resolve separately, with one attempt per defender per pass. An engaged blocker cannot intercept through a block. Higher difficulty improves recognition, route anticipation and flight estimates; player speed, reach and catch odds stay the same.
- **Tackling.** A free defender within reach gets one tackle attempt whose odds depend on relative speed, approach angle and whether the carrier has just cut. A tackle wraps the runner and drags him down within a second, giving 0–3 real yards after contact (about one yard typically); a miss leaves the tackler stumbling and costs the carrier some speed. Pursuers who cannot close the last yard dive. Passes can be dropped, more often when contested or when a bullet is thrown from close range. Sacks, interceptions, out of bounds, touchdowns and safeties end the rep.
- **Practice tools.** Twenty-four calls across shotgun doubles, trips, bunch, empty, tight, pistol and singleback alignments, each of which can be flipped. The book includes Mesh, Stick, Snag, Spacing, Levels, Y Cross, Dagger, Smash, Mills, Scissors, Post-wheel, Ohio, three play-action calls and five runs. Power and Counter use pulling guards; zone and stretch use different blocking tracks. Filter by formation or run/pass, search by concept or read, and review the route diagram and coaching cue. Random offense and defense every rep by default; choose a play to repeat it. Pre-snap hot routes (streak, slant, drag, in, out, curl, flat, corner) for any of the five receivers and audibles to any play. Disguised or called coverages, varied fronts and three difficulty levels (recognition, anticipation and pursuit). Repeat-spot reps, or **Move the chains** with downs, distance and a first-down line. Instant half-speed replay with scrubbing, and session totals.

## Front end

The title screen sits over a slow cinematic pass across the facility: the FOOTBALLSIM wordmark, a vertical **Practice / Playbook / Settings / Controls** menu (keyboard, mouse, touch or controller), and a thin bar with the graphics tier, frame rate and input device.

In play, a broadcast-style score bug shows field position and rep (or down, distance and yards to go when moving the chains). Numbered badges ride above the receivers' helmets in their route colours, a pass meter appears beside the quarterback while a throw charges, the play call sits in a small card at the lower left, and each result slides in as a lower-third banner. An optional field strip (Settings, off by default) shows the whole field with the line of scrimmage, the line to gain and every player. Playbook, Hot routes, Audible, Settings, Controls and Paused share one dialog style; Pause can return to the title menu.

Interface type is Barlow Condensed and Barlow (OFL, vendored), with a system-font fallback.

### Cameras

| Camera | View |
| --- | --- |
| Game camera (default) | Behind the offense. Before the snap it sits 15–22 yd behind and 8–10 yd above the quarterback with a 58° lens, far enough back for all five receivers and their badges at 16:9 and 16:10, then eases into the play camera at the snap: 12 yd behind and 7.5 yd above the controlled player, looking 14 yd downfield, 46° lens. It frames the ball and the catch point while a pass is in the air, swings behind the new carrier after a catch or handoff, swings aside and up while the carrier is wrapped so the tackler does not hide him, and holds on the downed carrier after the whistle. |
| Broadcast | Sideline press-box position, following the ball with a long lens that keeps the players a similar size. |
| All-22 | High end-zone view behind the offense showing all 22 players. |

Replays use a low three-quarter angle that tracks the ball. A camera saved by an older version (`wide`, `qb`) falls back to the game camera.

## Controls

| Input | Action |
| --- | --- |
| Arrow keys / W S, Enter / Space | Title menu: move, select |
| Space / Enter | Snap, next rep |
| WASD / arrow keys | Move the quarterback or ball carrier |
| Shift | Sprint |
| 1 / 2 / 3 / 4 / 5 | Hold and release to pass to that receiver: tap for a lob, hold for touch, hold longer for a bullet |
| Arrow keys while holding a receiver | Lead the pass |
| Q / E | Juke left / right |
| X | Throw away |
| B | Playbook between reps |
| H (pre-snap) | Hot routes: receiver 1–5, then the route key |
| Z (pre-snap) | Audible: 1–8 on the visible page; [ / ] changes page |
| Tab | Toggle pre-snap play art |
| C | Cycle camera: game, broadcast, all-22 |
| R | Replay after a rep |
| F | Fullscreen |
| Escape / P | Pause |

Controller (standard mapping): left stick moves, RT sprints, A snaps; after the snap A / X / Y / B / RB pass to receivers 1–5. D-pad left/right jukes, Back changes the camera, Start pauses. In menus and dialogs the D-pad moves, A selects and B closes. Touch devices get a movement pad, Sprint and Juke buttons and receiver buttons. Physical controllers depend on the browser's standard gamepad mapping and have only been reviewed in code.

## Adaptive graphics

Auto starts at Balanced, waits through a warm-up, and lowers quality after repeated slow two-second windows; sustained headroom raises it again. Changes apply between reps; a manual choice stays fixed. Hidden tabs stop rendering and pause the game, dialogs suspend the simulation and audio, the title screen renders at 20 fps and play is capped at 60 fps.

| Profile | Pixel budget | Max pixel ratio | Sun shadow map | Environment detail | Grass tufts | Small details |
| --- | ---: | ---: | --- | --- | ---: | --- |
| Performance | 800,000 | 0.85 | none (contact shadows only) | 35 % of the trees with single-sided leaf cards, no small sideline props, simple turf shading, athletes beyond 20 yd at reduced detail | 0 | off |
| Balanced | 1,500,000 | 1.15 | 1024² | 70 % of the trees with single-sided leaf cards, full sideline, detailed turf without anisotropic filtering, athletes beyond 30 yd at reduced detail | 9,000 | on |
| High | 2,500,000 | 1.5 | 2048² | all trees with double-sided, alpha-to-coverage leaf cards, full sideline, detailed turf with 8x anisotropic filtering, full-detail athletes | 22,000 | on |
| Ultra | 4,200,000 | 2 | 4096² | as High | 45,000 | on |

"Small details" are the goal-post wind ribbons and the athletes' small parts (towels, tape, belts, chin straps). Reduced-detail athletes (about 2,800 instead of 11,000 triangles, no small details) are drawn from a second set of meshes on the same skeletons, chosen per athlete by distance from the camera. There is no post-processing on any tier. Rendering quality never changes the 120 Hz simulation. At the lowest tier Auto can also lower the resolution. These are budgets, not promised frame rates. WebGL 2 is required.

## Scope and realism

This is an original browser game inspired by the practice modes of modern football games. It is candid about what it is:

- **Everything visual is procedural.** The athletes are built from lofted superellipse tubes and simple primitives and posed by hand-written procedural animation and inverse kinematics; there are no scanned players, motion capture, motion matching or ragdolls. The facility is modelled from simple shapes and generated textures. Grass detail comes from CC0 photographs and the three.js lawn texture, re-tinted by the field shader; the field markings are painted analytically.
- **The physics is a model, not an engine.** Players are points with momentum, grip and a facing; bodies do not collide except through simple separation, blocking engagement and tackle rules. Tackles, catches, drops and block sheds are resolved with probabilities on top of that model. The numbers are tuned to plausible NFL figures (about 1.8 s ten-yard splits and 5.1 s forty-yard times for a back) but are not measured from real players.
- **Football is simplified.** Offense only, seven alignments using the same 11 personnel (one back, one tight end, three receivers), 24 calls, four coverage families. There are no substitutions or pre-snap motion. No fumbles, penalties, intentional grounding, defensive control, special teams, clock or complete NFL rules. Throw-away simply ends the rep incomplete.
- **No licensed content.** No NFL teams, league marks, players, commentary or Madden assets.

## Development

Requires Node 22 or later. The runtime and the core tests have no package dependencies. The first run needs network access to download the pinned third-party files; later runs use the verified local copies.

```sh
npm run dev       # vendor assets, then http://localhost:8000
npm test          # deterministic simulation and graphics tests
npm run check     # syntax and local imports of every module, vendored assets
npm run build     # standalone .pages-dist release
```

Browser checks (a development-only dependency):

```sh
npm install --no-save --package-lock=false --ignore-scripts playwright@1.56.1
npx playwright install chromium
node scripts/serve.mjs .pages-dist
# In a second terminal:
node tests/browser.mjs
```

The browser test drives the real UI: title menu, camera fallback and cycling, play search, formation filters, formation alignment, hot routes, passing, handoff, replay, pause, settings and the performance tier, Move the chains, paged audibles, fullscreen, the 390 px phone layout and the return to the menu. It fails on any console error or failed request, and its screenshots are uploaded by the verification workflow. Add `?debug=1` for a developer-only `window.footballsim` handle (`sim`, `view`, `graphics`, `start()`, `snap()`).

Code layout: `dist/js/sim.js` and `plays.js` (simulation and playbook), `scene.js` with `environment.js` and `env/` (field, facility, sky, lighting, cameras, grass), `athletes.js` with `athletes/` (rigs, skinning, poses, ball), `characters/` (the optional skinned-model layer, see `MODELS.md`), `app.js`, `audio.js`, `index.html` and `style.css` (front end), and `graphics.js` (quality tiers).

All game-specific code and procedural assets were created for this repository. Third-party credits: `ASSETS.md`.

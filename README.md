# FootballSim

An original, offense-only 3D American football practice game for GitHub Pages. Call a play, read a CPU defense, control the quarterback, and take over the ball carrier after a catch or handoff.

## Play and publish

Intended Pages address: **https://soldoutbudokan.github.io/FootballSim/**.

One-time repository setup: open **Settings → Pages → Build and deployment → Source → GitHub Actions**. The `Verify FootballSim` workflow runs simulation checks and a Chromium gameplay smoke test. A successful push verification on `main` triggers `Publish GitHub Pages`. After enabling Pages, the publishing workflow can also be run manually from Actions. GitHub Pages is the intended public host; no account or backend is needed to play.

The release contains all runtime assets, including Three.js 0.180.0 and its MIT license. The build downloads CricSim's renderer from a pinned commit and verifies each file's Git blob hash; subsequent local builds use that verified copy. The published game makes no third-party asset requests. Paths are relative, so it works under `/FootballSim/` and other static subdirectories. The release build versions CSS and the complete JavaScript import graph together to prevent mixed cached releases.

## Included

- 22 articulated players with instanced helmets, facemasks, pads, uniforms and procedural running, blocking, throwing, catching and tackle poses. Photographed grass materials and an HDR reflection environment complement the procedural stadium; asset credits are in `ASSETS.md`.
- Random offense and defense are selected for each new rep by default. Select a named play to repeat it, or choose **Random every rep** in the playbook/settings to restore random offense.
- Eight concepts: Mesh, PA Flood, Four Verticals, Quick Slants, Dagger, Smash, Inside Zone and HB Stretch. Flip any play.
- Pre-snap hot routes (H): choose receiver 1–5, then a streak, slant, drag, in, out, curl, flat or corner. Z opens eight audibles for the current snap. Both preserve drive progress; audibles retain the defensive call.
- Four CPU defensive looks: Cover 3, Cover 2, 2-man and Cover 0 blitz; optional concealed random coverage. Three difficulty levels. Defensive fronts vary between even, over, under and wide alignments; coverage calls use different corner cushions, safety shells and blitz positions. Two-man keeps two deep safeties, and Cover 0 assigns the five remaining defenders to the five eligible receivers.
- Acceleration, route landmarks, zone/man pursuit, pass protection, pressure and movement accuracy penalties, ballistic passing, swept catch checks, interceptions, handoffs, sprint stamina, jukes and tackles.
- Automatic control transfer to the receiver or running back. No defensive player control.
- Repeat-spot practice hides downs, distance and the first-down line. **Move the chains** enables them, adds a prominent drive display, and tracks gains, first downs, touchdowns and turnover resets.
- Instant half-speed replay with scrubbing; session passing, rushing, sack, interception and touchdown totals.
- Broadcast, All-22 and quarterback cameras; afternoon, sunset and stadium-light settings. Keyboard, pointer/touch and standard-mapped gamepad inputs.
- Synthesized field ambience and snap, catch, whistle and touchdown sounds; opt-in sound control.

## Controls

| Input | Action |
| --- | --- |
| Space / Enter | Enter field, snap, next rep |
| WASD / arrow keys | Move current ball carrier |
| Shift | Sprint |
| 1 / 2 / 3 / 4 / 5 | Hold and release to pass to the receiver with the matching number |
| Tap / medium hold / long hold | Lob / touch / bullet |
| Arrow keys while holding a receiver | Lead the pass |
| Q / E | Juke left / right |
| X | Throw away |
| B | Playbook between reps |
| H (pre-snap) | Hot routes: receiver 1–5, then the displayed route key |
| Z (pre-snap) | Audible: choose play 1–8 |
| F | Enter / exit fullscreen |
| Tab | Toggle pre-snap route art |
| C | Cycle camera |
| R | Replay after a rep |
| Escape / P | Pause |

Controller: left stick moves, RT sprints, A snaps; after the snap A / X / Y / B / RB pass to receivers 1–5. D-pad left/right jukes, Back changes the camera, Start pauses. Touch controls include a movement pad, sprint/juke buttons and receiver buttons. Physical controller behavior depends on the browser's standard gamepad mapping; automated checks do not replace testing a physical controller.

## Adaptive graphics

The controller follows racer2's physical-pixel budgets and sustained frame-time sampling. Auto starts at Balanced, waits through warmup, and lowers quality after repeated slow windows. Sustained headroom can raise quality. Changes apply between reps. Manual choices stay fixed. Hidden tabs stop rendering and pause gameplay; dialogs suspend simulation and audio. The opening screen renders at 20 fps; play targets 60 fps.

| Profile | Pixel budget | Max pixel ratio | Shadow map | Spectators | Grass blades |
| --- | ---: | ---: | ---: | ---: | ---: |
| Performance | 800,000 | 0.85 | Contact shadows | 900 | 0 |
| Balanced | 1,500,000 | 1.15 | 1024² | 2,600 | 10,000 |
| High | 2,500,000 | 1.5 | 2048² | 5,200 | 24,000 |
| Ultra | 4,200,000 | 2 | 4096² | 7,500 | 40,000 |

Rendering quality does not alter the fixed 120 Hz simulation. The minimum tier can additionally lower resolution. These are budgets, not promised frame rates. WebGL 2 is required; no 2D fallback is substituted.

## Scope and realism

This is a playable original browser simulation inspired by professional football practice modes. It does **not** reproduce Madden's photorealistic scanned players, motion-captured animation, licensed teams, commentary or full physics engine. The athletes and stadium are procedural. Blocking, catches and tackles use simplified physical/AI models; there is no motion matching, ragdoll system, fumble/penalty system, defensive possession, special teams or complete NFL ruleset. Throw-away currently ends the rep as an incompletion without an intentional-grounding rule. Its eight concepts use a shotgun doubles personnel grouping. Those limits are explicit rather than presenting this release as AAA-equivalent realism.

## Development

Requires Node 22 or later. Runtime and core tests have no package dependencies. The first development run or build needs network access to retrieve the pinned renderer; subsequent runs use the verified local copy.

```sh
npm run dev       # http://localhost:8000
npm test          # deterministic simulation and graphics tests
npm run check     # syntax, local imports and vendored assets
npm run build     # standalone .pages-dist release
```

Browser checks (separate development-only dependency):

```sh
npm install --no-save --package-lock=false --ignore-scripts playwright@1.56.1
npx playwright install chromium
node scripts/serve.mjs .pages-dist
# In a second terminal:
node tests/browser.mjs
```

The browser test exercises field loading, play selection, passing, handoff, replay, pausing, graphics/settings and mobile layout. Screenshots are uploaded by the verification workflow. Add `?debug=1` for a developer-only `window.footballsim` inspection handle.

All game-specific code and procedural assets were created for this repository. Third-party renderer license: `dist/vendor/THREE-LICENSE.txt`.

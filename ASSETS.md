# Third-party assets

FootballSim reuses the following third-party files. Each one is listed in a manifest under `scripts/assets/`, downloaded by `scripts/vendor.mjs` from a pinned commit or tag, and verified by hash before it is used or included in the static release. They are served locally from GitHub Pages at runtime.

| Asset | Creator | Source | License |
| --- | --- | --- | --- |
| Sparse Grass base color and OpenGL normal maps, 1024² (worn turf and soil, grass micro-normals; the matching roughness map is vendored but not currently used) | Amal Kumar | https://polyhaven.com/a/sparse_grass, via CricSim commit `b70aaf8a1bae5aa4ca42690b8c4e3ee8a79d05a6` | CC0 1.0 |
| Noon Grass HDR environment, 1024×512 (daytime reflections) | Greg Zaal | https://polyhaven.com/a/noon_grass, via CricSim commit `b70aaf8a1bae5aa4ca42690b8c4e3ee8a79d05a6` | CC0 1.0 |
| Three.js 0.180.0 and HDRLoader | Three.js authors | https://github.com/mrdoob/three.js, via CricSim commit `b70aaf8a1bae5aa4ca42690b8c4e3ee8a79d05a6` | MIT; see `dist/vendor/THREE-LICENSE.txt` |
| `Sky.js` (Preetham analytic sky), r180 | Three.js authors | https://github.com/mrdoob/three.js/blob/r180/examples/jsm/objects/Sky.js (`scripts/assets/renderer-addons.json`) | MIT; see `dist/vendor/THREE-LICENSE.txt` |
| `grasslight-big.jpg` lawn texture, 2048² (natural-grass albedo detail) | Three.js authors | https://github.com/mrdoob/three.js/blob/r180/examples/textures/terrain/grasslight-big.jpg (`scripts/assets/environment.json`) | MIT (three.js repository); see `dist/vendor/THREE-LICENSE.txt` |
| glTF and FBX loaders with their helpers (`GLTFLoader.js`, `FBXLoader.js`, `BufferGeometryUtils.js`, `SkeletonUtils.js`, `NURBSCurve.js`, `NURBSUtils.js`), r180, for the skinned-character work in progress (not loaded by the current game) | Three.js authors | https://github.com/mrdoob/three.js/tree/r180/examples/jsm (`scripts/assets/characters.json`) | MIT; see `dist/vendor/THREE-LICENSE.txt` |
| `fflate.module.js` (zlib decompression used by the FBX loader), as shipped in three.js r180 | Arjun Barrett (101arrowz) | https://github.com/mrdoob/three.js/blob/r180/examples/jsm/libs/fflate.module.js (`scripts/assets/characters.json`) | MIT |
| Barlow (400, 500, 600) and Barlow Condensed (600, 700, 800, 800 italic) interface fonts | Jeremy Tribby, The Barlow Project Authors | https://github.com/google/fonts/tree/ddf386ba1b9fbc6b2c818f1ddcd9148f54ced94b/ofl (`barlow`, `barlowcondensed`); manifest `scripts/assets/fonts.json` | SIL Open Font License 1.1; see `dist/fonts/OFL.txt` |

`scripts/assets/characters.json` also downloads `Xbot.glb` from the three.js r180 examples into `dist/dev/` as a development-only stand-in rig. It is git-ignored, the game never loads it, and `scripts/build.mjs` leaves `dist/dev/` out of the published release, so it is not redistributed.

The grass photographs provide surface detail only: the field shader re-tints them to natural turf and paints every NFL marking analytically on top. They are not a scan of a named football venue. The HDR photograph supplies daytime material reflections; sunset and night reflections are pre-filtered from the procedural sky at runtime. Poly Haven's licensing statement: https://polyhaven.com/license. Full CC0 text: https://creativecommons.org/publicdomain/zero/1.0/.

Athletes, uniforms, field paint and numbers, the practice facility (team building, fences, light poles, film tower, sideline equipment, trees and horizon), clouds and all game-specific visuals are original procedural assets. There are no NFL team assets, league marks or Madden assets.

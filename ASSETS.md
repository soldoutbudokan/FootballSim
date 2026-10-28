# Environment and renderer assets

FootballSim reuses the following third-party files. Each one is listed in a manifest under `scripts/assets/`, downloaded by `scripts/vendor.mjs` from a pinned commit or tag, and verified by hash before it is used or included in the static release. They are served locally from GitHub Pages at runtime.

| Asset | Creator | Source | License |
| --- | --- | --- | --- |
| Sparse Grass base color, OpenGL normal and roughness maps, 1024² (worn turf and soil, grass micro-normals) | Amal Kumar | https://polyhaven.com/a/sparse_grass, via CricSim commit `b70aaf8a1bae5aa4ca42690b8c4e3ee8a79d05a6` | CC0 1.0 |
| Noon Grass HDR environment, 1024×512 (daytime reflections) | Greg Zaal | https://polyhaven.com/a/noon_grass, via CricSim commit `b70aaf8a1bae5aa4ca42690b8c4e3ee8a79d05a6` | CC0 1.0 |
| Three.js 0.180.0 and HDRLoader | Three.js authors | https://github.com/mrdoob/three.js, via CricSim commit `b70aaf8a1bae5aa4ca42690b8c4e3ee8a79d05a6` | MIT; see `dist/vendor/THREE-LICENSE.txt` |
| `Sky.js` (Preetham analytic sky), r180 | Three.js authors | https://github.com/mrdoob/three.js/blob/r180/examples/jsm/objects/Sky.js (`scripts/assets/renderer-addons.json`) | MIT; see `dist/vendor/THREE-LICENSE.txt` |
| `grasslight-big.jpg` lawn texture, 2048² (natural-grass albedo detail) | Three.js authors | https://github.com/mrdoob/three.js/blob/r180/examples/textures/terrain/grasslight-big.jpg (`scripts/assets/environment.json`) | MIT (three.js repository); see `dist/vendor/THREE-LICENSE.txt` |

The grass photographs provide surface detail only: the field shader re-tints them to natural turf and paints every NFL marking analytically on top. They are not a scan of a named football venue. The HDR photograph supplies daytime material reflections; sunset and night reflections are pre-filtered from the procedural sky at runtime. Poly Haven's licensing statement: https://polyhaven.com/license. Full CC0 text: https://creativecommons.org/publicdomain/zero/1.0/.

Athletes, uniforms, field paint and numbers, the practice facility (team building, fences, light poles, film tower, sideline equipment, trees and horizon), clouds and all game-specific visuals are original procedural assets. There are no NFL team assets, league marks or Madden assets.

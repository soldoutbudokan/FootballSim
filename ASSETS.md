# Environment and renderer assets

FootballSim reuses the following files from CricSim's pinned commit `b70aaf8a1bae5aa4ca42690b8c4e3ee8a79d05a6`. The build verifies their hashes before including them in the static release. They are served locally from GitHub Pages at runtime.

| Asset | Creator | Source | License |
| --- | --- | --- | --- |
| Sparse Grass base color, OpenGL normal and roughness maps, 1024² | Amal Kumar | https://polyhaven.com/a/sparse_grass | CC0 1.0 |
| Noon Grass HDR environment, 1024×512 | Greg Zaal | https://polyhaven.com/a/noon_grass | CC0 1.0 |
| Three.js 0.180.0 and HDRLoader | Three.js authors | https://github.com/mrdoob/three.js | MIT; see `dist/vendor/THREE-LICENSE.txt` |

The grass photographs represent 2 m tiles. They provide surface detail over the original field paint; they are not a scan of a named football venue. The HDR photograph supplies material reflections, while the stadium and visible sky are procedural. Poly Haven's licensing statement: https://polyhaven.com/license. Full CC0 text: https://creativecommons.org/publicdomain/zero/1.0/.

Athletes, uniforms, field paint, stadium geometry and all game-specific visuals are original procedural assets. There are no NFL team assets or Madden assets.

# Credits and licences

Everything under `assets/` is **CC0 1.0 Universal** (public domain dedication) and may be
committed to this public repo, used commercially, and redistributed without attribution.
The credits below are given because it is decent practice, not because CC0 demands them.

Everything under `vendor/` is **MIT** (three.js).

## Characters and animation

| | |
|---|---|
| Author | **Quaternius** (Tomás Quaternius) |
| Licence | [CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/) |
| Author site | https://quaternius.com |
| Support | https://www.patreon.com/quaternius |
| Obtained from | **ActionForge** — https://actionforge.app |
| Retrieved | 2026-09-28 |

`assets/rig-human.glb` and every file in `assets/clips/` are Quaternius's CC0 rig and
animations, retargeted, edited and repackaged by ActionForge (CGstuff) and redistributed
by it under the same CC0 terms. ActionForge's own
[THIRD-PARTY-NOTICES](https://actionforge.app/THIRD-PARTY-NOTICES.txt) states this
explicitly: *"THE ANIMATIONS, THE RIG AND THE PROPS — Created by Quaternius and dedicated
by him to the public domain under CC0 1.0 Universal. This site redistributes them —
retargeted, edited and repackaged — under the same terms."* Each clip additionally carries
`source.license: "CC0"` and `source.resaleAllowed: true` in ActionForge's own
`manifests/library.json`, which is how the set below was selected.

Two things from that source are deliberately **not** in this repo:

- **ActionForge's site code** is all rights reserved. None of it is vendored here.
- **The clip `fps_test`** is the only one of the 86 in the library whose `source.license`
  is `null` (origin `"original"`, not Quaternius). It is not CC0-cleared and was excluded.
- The library mentions a **Mixamo reference skeleton** used by ActionForge as a retargeting
  reference. That file is Adobe's and is not CC0 — it is not distributed here, and none of
  the committed files is a Mixamo asset.

### Files

Base rig — 71-bone humanoid, rigged fingers, UE-style bone names:

| File | Bytes | Source URL (upstream version hash) |
|---|---|---|
| `rig-human.glb` | 628,904 | `assets/animation-library/rig/rig-human.glb?v=3e5b0afb` |

Animation clips — one `AnimationClip` per file, no mesh:

| File | Clip | Bytes | Upstream `?v=` |
|---|---|---|---|
| `clips/walk_loop.glb` | `walk_loop` | 79,692 | `e4bda6bf` |
| `clips/walk_formal_loop.glb` | `walk_formal_loop` | 78,968 | `5e36bc6e` |
| `clips/jog_fwd_loop.glb` | `jog_fwd_loop` | 75,208 | `ef163d0b` |
| `clips/idle_loop.glb` | `idle_loop` | 87,216 | `21b7a135` |
| `clips/idle_foldarms_loop.glb` | `idle_foldarms_loop` | 83,888 | `b95b95e0` |
| `clips/idle_talking_loop.glb` | `idle_talking_loop` | 121,824 | `5d6cf37b` |
| `clips/idle_talkingphone_loop.glb` | `idle_talkingphone_loop` | 101,008 | `cef16b2b` |
| `clips/idle_no_loop.glb` | `idle_no_loop` | 87,356 | `071cd584` |
| `clips/yes.glb` | `yes` | 91,868 | `7e597d8a` |
| `clips/sitting_idle_loop.glb` | `sitting_idle_loop` | 83,272 | `6414d0a6` |
| `clips/sitting_talking_loop.glb` | `sitting_talking_loop` | 117,440 | `ffaa96e9` |
| `clips/sitting_enter.glb` | `sitting_enter` | 95,952 | `ed0836d1` |
| `clips/sitting_exit.glb` | `sitting_exit` | 89,700 | `aa1fe1f3` |
| `clips/fixing_kneeling.glb` | `fixing_kneeling` | 192,432 | `4ddb6148` |
| `clips/interact.glb` | `interact` | 82,192 | `ebfd41d0` |
| `clips/pickup_table.glb` | `pickup_table` | 75,412 | `db821874` |
| `clips/consume.glb` | `consume` | 82,988 | `1d994082` |
| `clips/push_loop.glb` | `push_loop` | 90,788 | `f121fba8` |

Subtotal: **2,346,108 bytes (2.24 MB)**.

Upstream base for every URL above: `https://actionforge.app/`. The `?v=` hashes are
ActionForge's cache-busting versions, recorded so a re-fetch can be checked against
what is committed here. The library snapshot these came from is
`manifests/library.json`, `schemaVersion: 2`, `generatedAt: 2026-09-26T05:12:07.479Z`.

## Second body and hairstyles

| | |
|---|---|
| Author | **Quaternius** |
| Licence | [CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/) |
| Author site | https://quaternius.com |
| Packs | *Universal Animation Library 2* (female mannequin) and *Universal Base Characters* (hairstyles), both the free Standard editions |
| Obtained from | https://github.com/NafisRayan/Animate-Rigged-Humanoid-No-Blender |
| Retrieved | 2026-09-29 |

Quaternius's own pages put these behind Google Drive and itch.io, neither of which can be
fetched without a browser session; the repo above mirrors both packs verbatim, including
each pack's own licence file. Both read `CC0 1.0 Universal (CC0 1.0) Public Domain
Dedication`, `Models by @Quaternius` — quoted from
`Universal Base Characters[Standard]/License_Standard.txt` and
`Universal Animation Library 2[Standard]/License.txt`.

| File | Bytes | Source file in the mirror |
|---|---|---|
| `rig-human-f.glb` | 1,442,824 | `Universal Animation Library 2[Standard]/…/Female Mannequin/Unreal-Godot/Mannequin_F.glb` |
| `hair/hair-long.glb` | 92,412 | `…/Hairstyles/Rigged to Head Bone/glTF (Godot -Unreal)/Hair_Long.gltf` |
| `hair/hair-buns.glb` | 104,788 | same directory, `Hair_Buns.gltf` |
| `hair/hair-parted.glb` | 27,032 | same directory, `Hair_SimpleParted.gltf` |
| `hair/hair-buzzed.glb` | 17,220 | same directory, `Hair_Buzzed.gltf` |
| `hair/hair-buzzed-female.glb` | 17,244 | same directory, `Hair_BuzzedFemale.gltf` |
| `hair/hair-beard.glb` | 21,564 | same directory, `Hair_Beard.gltf` |

`rig-human-f.glb` is the mirror's file byte for byte. The six hair files were rebaked from
their `.gltf` + `.bin` pairs into static GLBs in Head-bone local space: geometry and normals
are Quaternius's unchanged, the 65-joint skin data and the texture references were dropped.

Deliberately **not** taken from these packs:

- **The textures** (`T_Hair_*`, `T_Superhero_*`) — 1.5–4.7 MB each, and unused, because
  both mannequins are flat-shaded.
- **`Superhero_Female_FullBody` / `Superhero_Male_FullBody`** — CC0 and on the same
  skeleton, but they need those textures to read as intended.
- **The mirror's FBX, Unity, `.blend` and animation-library directories** — not needed.
- The paid **SOURCE** editions of both packs, offered on Quaternius's site. Nothing from
  them is here; only the free Standard editions are, and only those are CC0.

Total for `assets/`: **4,069,192 bytes (3.88 MB)** — inside the ~8 MB budget.

## Props

None. Every prop type in the contract's vocabulary is built from primitives, so no
third-party prop geometry is committed and nothing more needs crediting.

## three.js

| | |
|---|---|
| Project | three.js r160 (`0.160.0`) |
| Author | three.js authors (mrdoob and contributors) |
| Licence | MIT |
| Source | https://cdn.jsdelivr.net/npm/three@0.160.0 |
| Retrieved | 2026-09-28 |

Vendored files: `vendor/three.module.js` (from `build/`), and from `examples/jsm/`:
`GLTFLoader.js`, `SkeletonUtils.js`, `OrbitControls.js`, `BufferGeometryUtils.js`.

The only edit made to any of them: the bare specifier `from 'three'` was rewritten to
`from './three.module.js'`, and GLTFLoader's `from '../utils/BufferGeometryUtils.js'` to
`from './BufferGeometryUtils.js'`, so the addons resolve as plain ES modules with no
import map and no build step. MIT licence headers are intact.

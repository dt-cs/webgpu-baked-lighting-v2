# WebGPU Baked Lighting — Parallax-Corrected Cubemap Reflections

A real-time architectural interior rendered in Three.js WebGPU with baked diffuse GI lightmaps and parallax-corrected cubemap reflections. Built as a rendering harness for a portfolio room scene modelled and lit in Blender/Cycles.

---

## Rendering Architecture

The scene uses a split lighting model:

**Diffuse** is owned entirely by baked lightmaps. `scene.environment` is always `null`. No ambient light, no directional light, no IBL diffuse. What you see in the lightmap is what you get — direct illumination, indirect bounce, and colour bleeding from Cycles path tracing.

**Reflections** come from a parallax-corrected cubemap captured once at load from the room's geometric centre. The cubemap is photographed with lightmap-only basic materials (no view-dependent shading), so the cube map records the room as a diffuse scene. Full PBR materials with the BPCEM env node are applied after capture.

**Ambient Occlusion** attenuates the reflection in occluded areas (under the table, wall/floor junctions) without touching the baked diffuse.

---

## Blender Workflow

### Scene Setup

The scene (`simple_bake_01.glb`) is a black-tile interior room with a long table, wood shelving, and a forest HDRI lit opening at one end. All geometry is single-sided (interior shell only, normals inward). The room was exported as a GLB with `+Y Up` from Blender's Z-up coordinate system.

### Lightmap Baking

Two separate lightmap atlases were baked in Cycles:

- `bake_black_tile.png` — floor, roof, walls, table tiles
- `wood_lm.png` — shelf, table wood, table wood beading, table metal

**Settings used:**
- Bake Type: **Diffuse**
- Contributions: **Direct ON, Indirect ON, Color OFF**
  - Color OFF means the albedo is excluded from the bake. The lightmap stores only the lighting, not the surface colour. This allows PBR textures to multiply cleanly against it in Three.js.
- UV channel: a dedicated second UV set (`lightmap_bake`, exported as `TEXCOORD_1 / uv1`) with no overlapping islands
- Resolution: 2K for testing, with plans for 4K production
- Samples: 128–256 with denoising
- Output: 8-bit sRGB PNG (decoded as sRGB in Three.js)
- View Transform: **Standard** (not Filmic or AgX) so values round-trip predictably to Three.js with `toneMapping: NoToneMapping`

### AO Baking

Two AO atlases baked on the same `uv1` UV set:

- `ao_tile.png`
- `ao_wood.png`

These are used only to attenuate the parallax-corrected reflection in occluded areas. They do not affect the diffuse lightmap. Output as 8-bit sRGB PNG.

### PBR Textures

Tiling PBR texture sets for each surface group, using Blender UVs as authored (no code-side tiling multiplier):

| Group | Textures |
|---|---|
| Floor | diffuse, normal |
| Walls | diffuse, normal, roughness |
| Roof | diffuse, normal, roughness |

### Forest HDRI

The forest HDRI (`fall-forest-dirt-road_2K.exr`) is used as the cubemap capture background so the opening reads real forest. It is never assigned to `scene.environment`. World mapping: Rotation Z = 277°, applied as `scene.backgroundRotation.y` in Three.js to match the Blender world node orientation.

---

## Parallax-Corrected Cubemap (BPCEM)

The reflection system is based directly on:

> **Simon Geilfus — Cinder-Experiments / ParallaxCorrectedCubemap**
> https://github.com/simongeilfus/Cinder-Experiments/tree/master/ParallaxCorrectedCubemap

The GLSL `getBoxIntersection` function from `shader.frag` is translated line-for-line into Three.js TSL (Three Shading Language) using `Fn`, `positionWorld`, and `reflectVector`:

```glsl
// Cinder original (shader.frag)
vec3 rbmax = ( 0.5f * ( cubeSize - cubePos ) - pos ) / R;
vec3 rbmin = ( -0.5f * ( cubeSize - cubePos ) - pos ) / R;
// ... component-wise select ...
vec3 lookup = boxIntersection - cubePos;
```

```ts
// TSL equivalent (App.tsx)
const half   = cubeSize.sub(cubePos).mul(0.5)
const rbmax  = half.sub(pos).div(R)
const rbmin  = half.negate().sub(pos).div(R)
const rbminmax = vec3(
  R.x.greaterThan(float(0)).select(rbmax.x, rbmin.x),
  R.y.greaterThan(float(0)).select(rbmax.y, rbmin.y),
  R.z.greaterThan(float(0)).select(rbmax.z, rbmin.z),
)
const correction      = tslMin(tslMin(rbminmax.x, rbminmax.y), rbminmax.z)
const boxIntersection = pos.add(R.mul(correction))
return boxIntersection.sub(cubePos)
```

The room geometry is recentred at world origin after loading so the cubemap position is `vec3(0,0,0)`, matching the Cinder example's coordinate convention.

---

## Tech Stack

- **Three.js r184** — WebGPU renderer (`three/webgpu`)
- **React Three Fiber** — React renderer for Three.js
- **Drei** — OrbitControls
- **Leva** — live parameter panel
- **Vite** — dev server and bundler
- **Blender 5.1.2** — modelling, lighting, baking

---

## Project Structure

```
public/
  assets/
    simple_bake_01.glb        # room geometry (DRACO compressed)
    bake_black_tile.png       # tile lightmap atlas (uv1)
    wood_lm.png               # wood lightmap atlas (uv1)
    ao_tile.png               # tile AO atlas (uv1)
    ao_wood.png               # wood AO atlas (uv1)
  hdr/
    fall-forest-dirt-road_2K_*.exr   # forest HDRI (background + cubemap capture)
  pbr/
    floor/                    # tiles-11 diffuse + normal
    roof/                     # concrete_04 diffuse + normal + roughness
    wall/                     # tiles10 diffuse + normal + roughness
  draco/                      # DRACO WASM decoder
src/
  App.tsx                     # main scene, materials, BPCEM
  main.tsx
  styles.css
```

---

## Credits

**Parallax-corrected cubemap algorithm:**
Simon Geilfus — [Cinder-Experiments](https://github.com/simongeilfus/Cinder-Experiments/tree/master/ParallaxCorrectedCubemap)
The GLSL box intersection shader that made the reflections work correctly.

**WebGPU rendering harness, TSL shader translation, baking pipeline, and Three.js integration:**
Claude (Anthropic) — developed iteratively across a long session covering lightmap baking theory, WebGPU material architecture, BPCEM TSL implementation, coordinate system conversions, and debugging.

---

## Running Locally

```bash
npm install
npm run dev
```

Open `http://localhost:5173`.
# WebGPU Baked Room — Architecture

React Three Fiber + WebGPU scene: a Blender-baked architectural room with
parallax-corrected cubemap (BPCEM) reflections, a GLB reflector mirror on the
table, real-time directional + spotlight with shadows, and a light probe that
gives imported models GI-like diffuse lighting. Controls via Leva.

Written so a human or coding agent can find the right file for any change.

---

## File structure

```
src/
├── main.tsx            entry — mounts <App/>
├── config.ts           constants + types + leva schema (change together)
├── lib.ts              pure helpers: draco, classify, textures, bpcem
├── ARCHITECTURE.md     this file
└── scene/
    ├── App.tsx         Canvas + renderer init + Diagnostics overlay
    ├── Scene.tsx       assembly: renderer settings, camera, probe lifecycle
    ├── SceneLights.tsx directional + spotlight (with shadows)
    ├── BakedRoom.tsx   room materials, reflector, cubemap capture, probe extract
    └── TestModels.tsx  imported models, selective lighting
```

Seven source files. `config.ts` and `lib.ts` are the two leaf modules with no
internal dependencies; everything in `scene/` imports from them via `../config`
and `../lib`.

---

## Quick map: "I want to change X" → file

| Goal | File | Where |
|------|------|-------|
| Add/remove/relabel a UI control | `config.ts` | `levaSchema` + `flattenControls` + `SceneControls` (all in this one file now) |
| Room material logic (roughness, normal, AO, env reflection) | `scene/BakedRoom.tsx` | `applyLm`, `makePbr`, `fromGlb`, `groupRoughness`, `groupNormalScale` |
| Which mesh → which material group | `lib.ts` | `classify()` |
| Reflector mirror (mask, distortion, plane alignment) | `scene/BakedRoom.tsx` | the `reflectorRoot` useMemo |
| BPCEM reflection math | `lib.ts` | `makeBpcemEnvNode` |
| Lights (add/remove, shadows, intensity) | `scene/SceneLights.tsx` | the `useEffect` (create) + `useFrame` (update) |
| How models are lit / their material | `scene/TestModels.tsx` | the `useEffect` building `lightsNode` |
| Camera start / orbit pivot | `scene/Scene.tsx` | `FrameOnce` |
| Tone mapping / exposure / FOV | `scene/Scene.tsx` | `RendererSettings` |
| Background / environment / probe lifecycle | `scene/Scene.tsx` | `Scene` body effects |
| Asset paths, room size, tone-mapping table | `config.ts` | section 1 (constants) |
| Cubemap resolution | `scene/BakedRoom.tsx` | `cube capture` leva folder |
| Canvas / renderer init | `scene/App.tsx` | `createRenderer`, `<Canvas>` |

---

## Dependency graph

```
main.tsx
└── scene/App.tsx
     ├── config.ts                  (leaf: no internal imports)
     └── scene/Scene.tsx
          ├── config.ts
          ├── lib.ts                (leaf: imports only config.ts)
          ├── scene/SceneLights.tsx ── config.ts
          ├── scene/BakedRoom.tsx  ─── config.ts + lib.ts
          └── scene/TestModels.tsx ─── config.ts + lib.ts
```

`config.ts` is imported by everything. `lib.ts` imports `config.ts` (for
`CUBEMAP_SIZE`, `Group`, `Atlas`) and is imported by the two heavy components.

---

## config.ts — three sections

1. **Constants** — asset URLs, room AABB `CUBEMAP_SIZE`, capture origin
   `CUBEMAP_POS` (0,0,0), skybox rotation, `TONE_MAPPING` table.
2. **Types** — `Group`, `Atlas`, `MaterialMode`, `PbrSet`, `MeshReport`, and
   `SceneControls` (the flat control object passed everywhere).
3. **Leva** — `levaSchema` (the control tree) and `flattenControls(raw)` which
   flattens Leva's nested folder output into a typed `SceneControls`.

**Adding a control is now a single-file change**: add to `levaSchema`, add a
`pick()` line in `flattenControls`, add the field to `SceneControls`. All three
edits in `config.ts`.

## lib.ts — four leaf utilities

- `dracoLoader` — shared DRACO singleton (`/draco/`).
- `classify(name)` → `{ group, lightmap }` — mesh routing. Table → wall group.
- `configurePbrTexture` / `configureLightMap` / `configureAoMap` / `copyPbr`.
- `makeBpcemEnvNode(cubeRt)` — Cinder box-projected cubemap TSL node, origin
  fixed at room centre.

## scene/ components

- **App.tsx** — async WebGPU renderer, `<Canvas shadows>`, Leva hook, Diagnostics.
- **Scene.tsx** — owns light + probe React state, wires producers (SceneLights)
  to consumers (BakedRoom, TestModels). `RendererSettings`, `FrameOnce`.
- **SceneLights.tsx** — DirectionalLight + SpotLight, both cast shadows. Added
  globally; selectivity lives in materials' `lightsNode`.
- **BakedRoom.tsx** — the big one. Loads room/reflector/textures, recentres,
  shadow planes, one-time cubemap capture + LightProbe extraction, builds all
  room materials, builds the reflector. `groupRoughness`/`groupNormalScale` are
  the single source of truth for surface roughness/normal (also drive the
  reflector mask/distortion).
- **TestModels.tsx** — white models lit by `lights([dirLight, spotLight,
  lightProbe])`. Room baked-only setup never touches them.

---

## Critical invariants (don't break)

1. **`<Canvas shadows>` enables shadows**, not manual `renderer.shadowMap.enabled`
   — R3F overwrites manual renderer config after `createRenderer` returns.
2. **Room materials use `lights([])`** (empty) so no real-time light hits baked
   surfaces. Models list their lights explicitly. `lightsNode = null` means "all
   lights" and is wrong here.
3. **`envMapIntensity` is ignored on node materials** — reflection strength is
   baked into the TSL envNode (hardcoded 1 in `applyLm`).
4. **Cubemap is captured once** — move geometry then hit the `recapture` button.
5. **Camera pivot is a FIXED position**, never a computed Box3 (which would
   include spotlight targets and offset the pivot).
6. **Table is in the `wall` group** — `wall roughness` / `wall normal` drive the
   table material AND the reflector. One slider, both effects.

---

## Data flow

```
Leva UI ──useControls──► raw nested ──flattenControls()──► SceneControls (flat, typed)
                                                                  │
                          ┌───────────────────────────────────────┼──────────────────┐
                          ▼                                        ▼                  ▼
                    SceneLights                               BakedRoom          TestModels
                 (dir + spot)                           (room+reflector+      (lit by dir+
                          │                               cubemap+probe)        spot+probe)
                          └── dirLight, spotLight ───────────┴────────────────────┘
                                                       lightProbe
                                            (extracted from cubemap, lifted to Scene)
```
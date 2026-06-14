/**
 * App.tsx -- WebGPU BPCEM following the Cruciform / original three.js approach.
 * ---------------------------------------------------------------------------
 * Pipeline (from https://www.clicktorelease.com/blog/making-of-cruciform/):
 *
 *   1. Load room model
 *   2. Create CubeCamera at scene centre
 *   3. For cube capture: use MeshBasicMaterial with ONLY the lightmap (no
 *      reflections, no view-dependent shading) so walls bake into the cube
 *      map as diffuse-only. Hide the floor (glossy surface).
 *   4. Render cubemap ONCE after textures load. Static. Never again.
 *   5. Switch all meshes to full PBR material with lightmap + BPCEM envNode.
 *
 * BPCEM (from the Cruciform shader, mapped to TSL):
 *   pmremTexture(rt.texture, getParallaxCorrectNormal(reflectVector, boxSize, cubePos))
 *   cubePos  = cube camera world position = ROOM_PROBE_CENTRE
 *   boxSize  = room interior wall-to-wall dimensions = ROOM_BOX_SIZE
 *   These two must always match.
 *
 * DIFFUSE: scene.environment = null always. lightmaps own all diffuse.
 * ---------------------------------------------------------------------------
 */

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Canvas, extend, useFrame, useLoader, useThree } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import { folder, useControls, button } from 'leva'
import * as THREE from 'three/webgpu'
import { Fn, float, min as tslMin, positionWorld, pmremTexture, reflectVector, vec3 } from 'three/tsl'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js'
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js'

extend(THREE as unknown as Record<string, unknown>)

/* ------------------------------ asset paths ------------------------------ */

const MODEL_URL         = '/assets/simple_bake_01.glb'
const TILE_LIGHTMAP_URL = '/assets/bake_black_tile.png'
const WOOD_LIGHTMAP_URL = '/assets/wood_lm.png'
const FOREST_EXR_URL    = '/hdr/fall-forest-dirt-road_2K_e53f34e1-5505-4646-adfa-a7d03f4259eb.exr'

const FLOOR_COLOR_URL    = '/pbr/floor/tiles-11_diffuse.jpg'
const FLOOR_NORMAL_URL   = '/pbr/floor/tiles-11_normal.jpg'
const ROOF_COLOR_URL     = '/pbr/roof/concrete_04_color.jpg'
const ROOF_NORMAL_URL    = '/pbr/roof/concrete_04_normal.jpg'
const ROOF_ROUGHNESS_URL = '/pbr/roof/concrete_04_roughness.jpg'
const WALL_COLOR_URL     = '/pbr/wall/tiles10_diffuse.jpg'
const WALL_NORMAL_URL    = '/pbr/wall/tiles10_normal_opengl.jpg'
const WALL_ROUGHNESS_URL = '/pbr/wall/tiles10_roughness.jpg'

/* Blender world mapping Z = 277deg */
const BLENDER_WORLD_Z_RAD = THREE.MathUtils.degToRad(277)

/* Room interior dimensions from new_floor.001 (Blender cm ÷ 100 = three metres).
   Opening faces -X in Blender so depth runs along Blender X.
   Blender X (depth  16868.7cm) → three X: 168.687
   Blender Z (height  6825.1cm) → three Y:  68.251
   Blender Y (width  10016.7cm) → three Z: 100.167 */
const ROOM_BOX_SIZE = new THREE.Vector3(168.687, 68.251, 100.167)

/* After loading, the room root is translated so its bounding box centre
   sits at world origin. The cube camera and BPCEM box centre are therefore
   both vec3(0,0,0). This matches the Cruciform / official example exactly. */
const ROOM_PROBE_CENTRE = new THREE.Vector3(0, 0, 0)

/* --------------------------- mesh-name routing --------------------------- */

type Group = 'floor' | 'wall' | 'roof' | 'wood' | 'metal' | 'unknown'
type Atlas  = 'tile'  | 'wood'

function classify(name: string): { group: Group; lightmap: Atlas } {
  const n = name.toLowerCase()
  if (n.includes('beading') || n.includes('wood'))        return { group: 'wood',  lightmap: 'wood' }
  if (n.includes('metal'))                                return { group: 'metal', lightmap: 'wood' }
  if (n.startsWith('shelf'))                              return { group: 'wood',  lightmap: 'wood' }
  if (n.includes('table') && n.includes('tile'))          return { group: 'wall',  lightmap: 'tile' }
  if (n.startsWith('new_floor') || n.startsWith('floor')) return { group: 'floor', lightmap: 'tile' }
  if (n.startsWith('new_roof')  || n.startsWith('roof') || n.includes('ceiling'))
                                                          return { group: 'roof',  lightmap: 'tile' }
  if (n.startsWith('new_wall')  || n.startsWith('wall'))  return { group: 'wall',  lightmap: 'tile' }
  return { group: 'unknown', lightmap: 'tile' }
}

/* -------------------------------- draco ---------------------------------- */

const dracoLoader = new DRACOLoader()
dracoLoader.setDecoderPath('/draco/')
dracoLoader.setDecoderConfig({ type: 'wasm' })

/* ------------------------------ tone mapping ----------------------------- */

const TONE_MAPPING: Record<string, THREE.ToneMapping> = {
  None:    THREE.NoToneMapping,
  AgX:     THREE.AgXToneMapping,
  Neutral: THREE.NeutralToneMapping,
  ACES:    THREE.ACESFilmicToneMapping,
}

/* --------------------------------- types --------------------------------- */

type MaterialMode = 'GI only' | 'PBR + baked GI' | 'UV debug'

type SceneControls = {
  materialMode:              MaterialMode
  bakedGiEnabled:            boolean
  lightMapIntensity:         number
  lightMapChannel:           number
  lightMapFlipY:             boolean
  lightMapSRGB:              boolean
  toneMapping:               THREE.ToneMapping
  exposure:                  number
  background:                string
  forestAsBackground:        boolean
  reflectionsEnabled:        boolean
  globalReflectionIntensity: number
  probeOffsetX:              number
  probeOffsetY:              number
  probeOffsetZ:              number
  floorEnvIntensity:         number
  wallEnvIntensity:          number
  roofEnvIntensity:          number
  woodEnvIntensity:          number
  metalEnvIntensity:         number
  floorRoughness:            number
  wallRoughness:             number
  roofRoughness:             number
  allFromGlb:                boolean
}

type PbrSet    = { color: THREE.Texture; normal: THREE.Texture; roughness?: THREE.Texture }
type MeshReport = { meshCount: number; uv1Count: number; unmatched: string[] }

/* ------------------------------- renderer -------------------------------- */

function RendererSettings({ toneMapping, exposure }: { toneMapping: THREE.ToneMapping; exposure: number }) {
  const { gl } = useThree()
  useEffect(() => {
    const r = gl as unknown as THREE.WebGPURenderer
    r.outputColorSpace    = THREE.SRGBColorSpace
    r.toneMapping         = toneMapping
    r.toneMappingExposure = exposure
  }, [gl, toneMapping, exposure])
  return null
}

/* ---------------------------- texture helpers ---------------------------- */

function configurePbrTexture(t: THREE.Texture, cs: THREE.ColorSpace) {
  t.flipY = false; t.channel = 0; t.colorSpace = cs
  t.wrapS = THREE.RepeatWrapping; t.wrapT = THREE.RepeatWrapping
  t.anisotropy = 8; t.needsUpdate = true
}

function configureLightMap(t: THREE.Texture, channel: number, flipY: boolean, cs: THREE.ColorSpace) {
  t.flipY = flipY; t.channel = channel; t.colorSpace = cs
  t.wrapS = THREE.ClampToEdgeWrapping; t.wrapT = THREE.ClampToEdgeWrapping
  t.needsUpdate = true
}

function copyPbr(src: THREE.Material, dst: THREE.MeshStandardNodeMaterial) {
  const s = src as THREE.MeshStandardMaterial
  if (s.color)       dst.color.copy(s.color)
  if (s.normalScale) dst.normalScale.copy(s.normalScale)
  dst.map          = s.map          ?? null
  dst.normalMap    = s.normalMap    ?? null
  dst.roughness    = s.roughness    ?? 1
  dst.roughnessMap = s.roughnessMap ?? null
  dst.metalness    = s.metalness    ?? 0
  dst.metalnessMap = s.metalnessMap ?? null
  dst.side         = s.side         ?? THREE.FrontSide
  dst.name         = s.name         ?? ''
  return dst
}

function envIntensity(group: Group, c: SceneControls) {
  return c.globalReflectionIntensity * (
    group === 'floor' ? c.floorEnvIntensity :
    group === 'wall'  ? c.wallEnvIntensity  :
    group === 'roof'  ? c.roofEnvIntensity  :
    group === 'wood'  ? c.woodEnvIntensity  :
    group === 'metal' ? c.metalEnvIntensity :
    c.wallEnvIntensity
  )
}

/* --------------------------------- room ---------------------------------- */

function BakedRoom({ controls, forestExr, onReport }: {
  controls:  SceneControls
  forestExr: THREE.Texture | null
  onReport:  (r: MeshReport) => void
}) {
  const { gl, scene } = useThree()

  const gltf = useLoader(GLTFLoader, MODEL_URL, (l) => l.setDRACOLoader(dracoLoader))
  const [tileLightMap, woodLightMap] = useLoader(THREE.TextureLoader, [TILE_LIGHTMAP_URL, WOOD_LIGHTMAP_URL])
  const [
    floorColor, floorNormal,
    roofColor, roofNormal, roofRoughness,
    wallColor, wallNormal, wallRoughness,
  ] = useLoader(THREE.TextureLoader, [
    FLOOR_COLOR_URL, FLOOR_NORMAL_URL,
    ROOF_COLOR_URL,  ROOF_NORMAL_URL,  ROOF_ROUGHNESS_URL,
    WALL_COLOR_URL,  WALL_NORMAL_URL,  WALL_ROUGHNESS_URL,
  ])

  const root = useMemo(() => {
    const r = gltf.scene.clone(true)
    // Recentre the room at world origin so BPCEM box maths work with
    // cubePos = vec3(0,0,0), matching the Cruciform example exactly.
    r.updateMatrixWorld(true)
    const box = new THREE.Box3().setFromObject(r)
    const centre = box.getCenter(new THREE.Vector3())
    r.position.sub(centre)
    r.updateMatrixWorld(true)
    console.info('[room] recentred. bbox centre was:', centre)
    return r
  }, [gltf.scene])

  /* ---- cube render target (static) ---- */
  const capControls = useControls('cube capture', {
    cubeResolution: { value: 512, options: { '256': 256, '512': 512, '1024': 1024 }, label: 'resolution' },
    recapture: button(() => { capturedRef.current = false }),
  })
  const cubeRes = (capControls as unknown as { cubeResolution: number }).cubeResolution

  const { cubeRt, cubeCam } = useMemo(() => {
    const rt = new THREE.CubeRenderTarget(cubeRes, { type: THREE.HalfFloatType })
    rt.texture.minFilter       = THREE.LinearMipmapLinearFilter
    rt.texture.magFilter       = THREE.LinearFilter
    rt.texture.generateMipmaps = true
    rt.texture.mapping         = THREE.CubeReflectionMapping
    const cam = new THREE.CubeCamera(0.1, 10000, rt)
    return { cubeRt: rt, cubeCam: cam }
  }, [cubeRes])

  useEffect(() => () => cubeRt.dispose(), [cubeRt])

  /* ---- BPCEM env node ----
     Implements the exact shader from simongeilfus/Cinder-Experiments:
       vec3 rbmax = (0.5*(cubeSize - cubePos) - pos) / R;
       vec3 rbmin = (-0.5*(cubeSize - cubePos) - pos) / R;
       lookup = boxIntersection - cubePos;
     pos = positionWorld (fragment world position, room recentred at origin)
     cubePos = probe offset (default 0,0,0 = room centre)
     cubeSize = room interior dimensions
     No Y flip needed — the shader uses world space directly. */
  const bpcemEnvNode = useMemo(() => {
    const ox = controls.probeOffsetX ?? 0
    const oy = controls.probeOffsetY ?? 0
    const oz = controls.probeOffsetZ ?? 0

    // Custom BPCEM function matching the Cinder shader exactly
    const bpcemLookup = Fn(() => {
      const cubeSize = vec3(168.687, 68.251, 100.167)
      const cubePos  = vec3(ox, oy, oz)
      const pos      = positionWorld          // fragment world position
      const R        = reflectVector          // world-space reflection direction

      // Ray-AABB intersection (Cinder formula)
      const rbmax = cubeSize.sub(cubePos).mul(0.5).sub(pos).div(R)
      const rbmin = cubeSize.sub(cubePos).mul(-0.5).sub(pos).div(R)

      const rbminmax = vec3(
        R.x.greaterThan(float(0)).select(rbmax.x, rbmin.x),
        R.y.greaterThan(float(0)).select(rbmax.y, rbmin.y),
        R.z.greaterThan(float(0)).select(rbmax.z, rbmin.z),
      )

      const correction = tslMin(tslMin(rbminmax.x, rbminmax.y), rbminmax.z)
      const boxIntersection = pos.add(R.mul(correction))

      // Final lookup: intersection point relative to probe centre.
      return boxIntersection.sub(cubePos)
    })()

    return pmremTexture(cubeRt.texture, bpcemLookup)
  }, [cubeRt, controls.probeOffsetX, controls.probeOffsetY, controls.probeOffsetZ])

  /* ---- Cruciform capture pipeline:
     Step 1: apply BASIC materials (lightmap only, no reflections) to all meshes.
     Step 2: hide floor, render cubemap once.
     Step 3: restore floor, apply full PBR + BPCEM materials.
     This matches exactly: "Create MeshBasicMaterial only with the diffuse map,
     render cubemap, switch to ShaderMaterial." ---- */
  const capturedRef = useRef(false)

  useFrame(() => {
    if (capturedRef.current) return
    if (!forestExr) return
    capturedRef.current = true

    const cs = controls.lightMapSRGB ? THREE.SRGBColorSpace : THREE.NoColorSpace

    // Step 1: apply lightmap-only basic materials for the capture.
    // Cruciform uses MeshBasicMaterial with only the diffuse (baked) map.
    root.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (!mesh.isMesh) return
      const { lightmap } = classify(mesh.name || '')
      const lm = lightmap === 'wood' ? woodLightMap : tileLightMap
      configureLightMap(lm, controls.lightMapChannel, controls.lightMapFlipY, cs)
      mesh.material = new THREE.MeshBasicNodeMaterial({ map: lm, side: THREE.FrontSide })
    })

    // Step 2: place cube cam, hide floor, capture.
    // Room recentred at origin. Cube cam at probe offset (default 0,0,0).
    cubeCam.position.set(controls.probeOffsetX, controls.probeOffsetY, controls.probeOffsetZ)
    cubeCam.updateMatrixWorld(true)

    const prevBg  = scene.background
    const prevEnv = scene.environment
    scene.background = forestExr
    scene.backgroundRotation.set(0, BLENDER_WORLD_Z_RAD, 0)
    scene.environment = null

    // Do NOT hide the floor. Cruciform hides the ground plane because it's a
    // perfect mirror that would self-reflect. Our floor uses MeshBasicMaterial
    // with only the lightmap during capture — no reflections possible — so it's
    // safe to leave visible. Hiding it causes the cube cam to see forest ground
    // looking downward, which then appears in floor reflections instead of the
    // room ceiling.
    cubeCam.update(gl as unknown as THREE.WebGLRenderer, scene)
    scene.background  = prevBg
    scene.environment = prevEnv

    // Step 3: now apply full PBR + BPCEM to all meshes.
    // (triggers the material build effect below by marking materials stale)
    buildMaterials()
  })

  /* ---- texture config ---- */
  useEffect(() => {
    const cs = controls.lightMapSRGB ? THREE.SRGBColorSpace : THREE.NoColorSpace
    configureLightMap(tileLightMap, controls.lightMapChannel, controls.lightMapFlipY, cs)
    configureLightMap(woodLightMap, controls.lightMapChannel, controls.lightMapFlipY, cs)
  }, [tileLightMap, woodLightMap, controls.lightMapChannel, controls.lightMapFlipY, controls.lightMapSRGB])

  useEffect(() => {
    configurePbrTexture(floorColor,    THREE.SRGBColorSpace)
    configurePbrTexture(floorNormal,   THREE.NoColorSpace)
    configurePbrTexture(roofColor,     THREE.SRGBColorSpace)
    configurePbrTexture(roofNormal,    THREE.NoColorSpace)
    configurePbrTexture(roofRoughness, THREE.NoColorSpace)
    configurePbrTexture(wallColor,     THREE.SRGBColorSpace)
    configurePbrTexture(wallNormal,    THREE.NoColorSpace)
    configurePbrTexture(wallRoughness, THREE.NoColorSpace)
  }, [floorColor, floorNormal, roofColor, roofNormal, roofRoughness, wallColor, wallNormal, wallRoughness])

  const floorSet = useMemo<PbrSet>(() => ({ color: floorColor, normal: floorNormal }), [floorColor, floorNormal])
  const roofSet  = useMemo<PbrSet>(() => ({ color: roofColor,  normal: roofNormal, roughness: roofRoughness }), [roofColor, roofNormal, roofRoughness])
  const wallSet  = useMemo<PbrSet>(() => ({ color: wallColor,  normal: wallNormal, roughness: wallRoughness }), [wallColor, wallNormal, wallRoughness])

  /* ---- build full PBR materials ---- */
  const buildMaterialsRef = useRef<(() => void) | null>(null)

  const buildMaterials = () => { buildMaterialsRef.current?.() }

  useEffect(() => {
    buildMaterialsRef.current = () => {
      const created: THREE.Material[] = []
      let meshCount = 0, uv1Count = 0
      const unmatched: string[] = []
      const pbrMode = controls.materialMode === 'PBR + baked GI'

      const applyLm = (m: THREE.MeshStandardNodeMaterial, group: Group, lm: THREE.Texture) => {
        m.lightMap          = controls.bakedGiEnabled ? lm : null
        m.lightMapIntensity = controls.bakedGiEnabled ? controls.lightMapIntensity : 0
        m.envNode         = pbrMode && controls.reflectionsEnabled ? bpcemEnvNode : null
        m.envMap          = null
        m.envMapIntensity = pbrMode && controls.reflectionsEnabled ? envIntensity(group, controls) : 0
        m.needsUpdate     = true
        return m
      }

      const makeGiOnly = (lm: THREE.Texture) =>
        applyLm(new THREE.MeshStandardNodeMaterial({ color: '#fff', roughness: 1, metalness: 0, side: THREE.FrontSide }), 'unknown', lm)

      const makePbr = (set: PbrSet, rough: number, group: Group, lm: THREE.Texture) =>
        applyLm(new THREE.MeshStandardNodeMaterial({
          color: '#fff', map: set.color, normalMap: set.normal,
          roughnessMap: set.roughness ?? null, roughness: rough, metalness: 0, side: THREE.FrontSide,
        }), group, lm)

      const fromGlb = (orig: THREE.Material, group: Group, lm: THREE.Texture) =>
        applyLm(copyPbr(Array.isArray(orig) ? orig[0] : orig, new THREE.MeshStandardNodeMaterial()), group, lm)

      const makeUvDebug = (lm: THREE.Texture) =>
        new THREE.MeshBasicNodeMaterial({ map: lm, side: THREE.FrontSide })

      root.traverse((child) => {
        const mesh = child as THREE.Mesh
        if (!mesh.isMesh) return
        meshCount++
        if (mesh.geometry.getAttribute('uv1')) uv1Count++
        if (!mesh.userData.bakeOriginal) mesh.userData.bakeOriginal = mesh.material
        const original = mesh.userData.bakeOriginal as THREE.Material
        const { group, lightmap } = classify(mesh.name || '')
        const lm = lightmap === 'wood' ? woodLightMap : tileLightMap
        let material: THREE.Material

        if      (controls.materialMode === 'UV debug') material = makeUvDebug(lm)
        else if (controls.materialMode === 'GI only')  material = makeGiOnly(lm)
        else if (controls.allFromGlb)                  material = fromGlb(original, group, lm)
        else if (group === 'floor')  material = makePbr(floorSet, controls.floorRoughness, group, lm)
        else if (group === 'wall')   material = makePbr(wallSet,  controls.wallRoughness,  group, lm)
        else if (group === 'roof')   material = makePbr(roofSet,  controls.roofRoughness,  group, lm)
        else {
          if (group === 'unknown') unmatched.push(mesh.name || '(unnamed)')
          material = fromGlb(original, group, lm)
        }

        mesh.material = material
        created.push(material)
      })

      onReport({ meshCount, uv1Count, unmatched })
    }

    // Run immediately (pre-capture shows lightmap; capture then triggers again)
    buildMaterialsRef.current()
  }, [
    root, bpcemEnvNode, tileLightMap, woodLightMap, floorSet, roofSet, wallSet, onReport,
    controls.materialMode, controls.bakedGiEnabled, controls.lightMapIntensity,
    controls.reflectionsEnabled, controls.globalReflectionIntensity,
    controls.floorEnvIntensity, controls.wallEnvIntensity, controls.roofEnvIntensity,
    controls.woodEnvIntensity, controls.metalEnvIntensity,
    controls.floorRoughness, controls.wallRoughness, controls.roofRoughness,
    controls.allFromGlb,
  ])

  return <primitive object={root} />
}

/* ------------------------------ camera frame ----------------------------- */

function FrameOnce() {
  const { camera, scene, controls } = useThree()
  const done = useRef(false)
  useEffect(() => {
    if (done.current) return
    scene.updateMatrixWorld(true)
    const box = new THREE.Box3().setFromObject(scene)
    if (box.isEmpty()) return
    const size   = box.getSize(new THREE.Vector3())
    const center = box.getCenter(new THREE.Vector3())
    const maxDim = Math.max(size.x, size.y, size.z) || 1
    const dist   = maxDim * 1.4
    camera.position.set(center.x + dist * 0.7, center.y + dist * 0.5, center.z + dist)
    camera.near = Math.max(maxDim / 1000, 0.01)
    camera.far  = maxDim * 100
    camera.updateProjectionMatrix()
    const c = controls as unknown as { target?: THREE.Vector3; update?: () => void }
    if (c?.target) { c.target.copy(center); c.update?.(); done.current = true }
    else camera.lookAt(center)
  }, [camera, scene, controls])
  return null
}

/* -------------------------------- scene ---------------------------------- */

function Scene({ controls, onReport }: { controls: SceneControls; onReport: (r: MeshReport) => void }) {
  const [forestExr, setForestExr] = useState<THREE.Texture | null>(null)
  const { scene } = useThree()
  const exr = useLoader(EXRLoader, FOREST_EXR_URL) as THREE.Texture

  useEffect(() => {
    exr.mapping = THREE.EquirectangularReflectionMapping
    setForestExr(exr)
  }, [exr])

  useEffect(() => {
    scene.environment = null
    scene.background  = controls.forestAsBackground && forestExr
      ? forestExr : new THREE.Color(controls.background)
    scene.backgroundRotation.set(0, BLENDER_WORLD_Z_RAD, 0)
  }, [scene, forestExr, controls.forestAsBackground, controls.background])

  return (
    <>
      <RendererSettings toneMapping={controls.toneMapping} exposure={controls.exposure} />
      <BakedRoom controls={controls} forestExr={forestExr} onReport={onReport} />
      <FrameOnce />
      <OrbitControls makeDefault enablePan enableZoom enableDamping />
    </>
  )
}

/* ------------------------------ diagnostics ------------------------------ */

function Diagnostics({ report }: { report: MeshReport }) {
  const ok = report.meshCount > 0 && report.uv1Count === report.meshCount
  return (
    <div style={{
      position: 'fixed', top: 12, left: 12, zIndex: 10, padding: '10px 12px',
      font: '12px/1.4 monospace', color: ok ? '#9be39b' : '#ffcc66',
      background: 'rgba(0,0,0,0.6)', borderRadius: 6, pointerEvents: 'none',
    }}>
      <div>meshes: {report.meshCount}</div>
      <div>with uv1: {report.uv1Count}{ok ? '  (all good)' : '  (some missing uv1!)'}</div>
      {report.unmatched.length > 0 && <div>unmatched: {report.unmatched.slice(0,6).join(', ')}</div>}
    </div>
  )
}

/* ---------------------------------- app ---------------------------------- */

export default function App() {
  const [report, setReport] = useState<MeshReport>({ meshCount: 0, uv1Count: 0, unmatched: [] })

  const raw = useControls('bpcem test', {
    materialMode: { value: 'PBR + baked GI', options: ['GI only', 'PBR + baked GI', 'UV debug'], label: 'material mode' },
    bakedGiEnabled:    { value: true,  label: 'baked GI on' },
    lightMapIntensity: { value: 1, min: 0, max: 3, step: 0.05, label: 'lightmap intensity' },
    lightMapChannel:   { value: 1, options: { 'uv1 / channel 1': 1, 'uv / channel 0': 0 }, label: 'lightmap channel' },
    lightMapFlipY:     { value: false, label: 'lightmap flipY' },
    lightMapSRGB:      { value: true,  label: 'lightmap sRGB' },

    rendering: folder({
      toneMapping:        { value: 'None', options: Object.keys(TONE_MAPPING), label: 'tone mapping' },
      exposure:           { value: 1, min: 0.1, max: 2, step: 0.01 },
      background:         '#101010',
      forestAsBackground: { value: false, label: 'forest as background' },
    }),

    bpcem: folder({
      probeOffsetX: { value: 0, min: -20, max: 20, step: 0.1, label: 'probe offset X' },
      probeOffsetY: { value: 0, min: -20, max: 20, step: 0.1, label: 'probe offset Y' },
      probeOffsetZ: { value: 0, min: -20, max: 20, step: 0.1, label: 'probe offset Z' },
    }),

    reflections: folder({
      reflectionsEnabled:        { value: true, label: 'reflections on' },
      globalReflectionIntensity: { value: 1, min: 0, max: 5, step: 0.01, label: 'global reflection' },
      floorEnvIntensity:  { value: 1,    min: 0, max: 3, step: 0.01, label: 'floor' },
      wallEnvIntensity:   { value: 0.5,  min: 0, max: 3, step: 0.01, label: 'wall'  },
      roofEnvIntensity:   { value: 0.05, min: 0, max: 3, step: 0.01, label: 'roof'  },
      woodEnvIntensity:   { value: 0.4,  min: 0, max: 3, step: 0.01, label: 'wood'  },
      metalEnvIntensity:  { value: 1,    min: 0, max: 5, step: 0.01, label: 'metal' },
    }),

    roughness: folder({
      floorRoughness: { value: 0.2,  min: 0, max: 1, step: 0.01, label: 'floor' },
      wallRoughness:  { value: 0.5,  min: 0, max: 1, step: 0.01, label: 'wall'  },
      roofRoughness:  { value: 0.85, min: 0, max: 1, step: 0.01, label: 'roof'  },
      allFromGlb:     { value: false, label: 'all from GLB' },
    }),
  })

  const controls: SceneControls = {
    ...(raw as unknown as Omit<SceneControls, 'toneMapping'>),
    toneMapping: TONE_MAPPING[(raw as unknown as { toneMapping: string }).toneMapping],
  }

  const createRenderer = useCallback(async (props: Record<string, unknown>) => {
    const r = new THREE.WebGPURenderer({ ...props, antialias: true } as any)
    await r.init()
    return r as any
  }, [])

  return (
    <main style={{ width: '100vw', height: '100vh' }}>
      <Diagnostics report={report} />
      <Canvas gl={createRenderer} dpr={[1, 1.5]} camera={{ position: [5, 3, 6], fov: 42, near: 0.1, far: 50000 }}>
        <Suspense fallback={null}>
          <Scene controls={controls} onReport={setReport} />
        </Suspense>
      </Canvas>
    </main>
  )
}
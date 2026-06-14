/**
 * App.tsx
 * Parallax-corrected cubemap environment mapping for a baked WebGPU room scene.
 *
 * Reference: https://github.com/simongeilfus/Cinder-Experiments/tree/master/ParallaxCorrectedCubemap
 *
 * Pipeline follows the Cinder reference exactly:
 *   1. Load room model, rescale/recentre to origin
 *   2. Set cubemap bounds: position + size (AABB)
 *   3. renderCubemap(): render scene with uReflections=0 from bounds centre
 *   4. renderScene(): lightmap + reflection additively blended via uReflections=1
 *
 * Shader follows shader.frag exactly:
 *   getBoxIntersection(vPosition, R, cubeMapSize, cubeMapPos)
 *   lookup = boxIntersection - cubeMapPos
 *   oColor = lighting + mix(0, reflection, uReflections)
 *
 * Lightmap owns all diffuse. scene.environment = null always.
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

/* Skybox orientation — equivalent to Cinder's glm::rotate(-2.32f, vec3(0,1,0))
   Tuned to match the Blender world mapping so the forest faces the room opening. */
const SKYBOX_ROTATION_Y_RAD = THREE.MathUtils.degToRad(277)

/* Cubemap bounds — matches Cinder's:
     vec3 cubemapPos(0, 0, 0)          <- room centre after recentring
     vec3 cubemapSize(W, H, D)         <- room interior dimensions
   Room measured from new_floor.001 in Blender (cm ÷ 100 = metres):
     X: 168.687  Y: 68.251  Z: 100.167 */
const CUBEMAP_SIZE = new THREE.Vector3(168.687, 68.251, 100.167)
const CUBEMAP_POS  = new THREE.Vector3(0, 0, 0)  // room recentred at origin

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
  cubemapOffsetX:            number
  cubemapOffsetY:            number
  cubemapOffsetZ:            number
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

  /* Load model, recentre at origin (so CUBEMAP_POS = vec3(0,0,0) is the room centre).
     Cinder does this via: geom::Scale(1/bounds.getSize().y) which normalises the model.
     We translate so the bbox centre sits at origin instead. */
  const root = useMemo(() => {
    const r = gltf.scene.clone(true)
    r.updateMatrixWorld(true)
    const box    = new THREE.Box3().setFromObject(r)
    const centre = box.getCenter(new THREE.Vector3())
    r.position.sub(centre)
    r.updateMatrixWorld(true)
    console.info('[room] recentred. original centre:', centre)
    return r
  }, [gltf.scene])

  /* Cube render target — equivalent to Cinder's FboCubeMap */
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
    const cam = new THREE.CubeCamera(0.05, 10000, rt)
    return { cubeRt: rt, cubeCam: cam }
  }, [cubeRes])

  useEffect(() => () => cubeRt.dispose(), [cubeRt])

  /* BPCEM env node — exact translation of shader.frag getBoxIntersection():
       rbmax = (0.5*(cubeSize - cubePos) - pos) / R
       rbmin = (-0.5*(cubeSize - cubePos) - pos) / R
       correction = min(component-wise select based on sign of R)
       boxIntersection = pos + R * correction
       lookup = boxIntersection - cubePos                              */
  const bpcemEnvNode = useMemo(() => {
    const ox = controls.cubemapOffsetX ?? 0
    const oy = controls.cubemapOffsetY ?? 0
    const oz = controls.cubemapOffsetZ ?? 0

    const bpcemLookup = Fn(() => {
      const cubeSize = vec3(CUBEMAP_SIZE.x, CUBEMAP_SIZE.y, CUBEMAP_SIZE.z)
      const cubePos  = vec3(
        CUBEMAP_POS.x + ox,
        CUBEMAP_POS.y + oy,
        CUBEMAP_POS.z + oz,
      )
      const pos = positionWorld
      const R   = reflectVector

      const half = cubeSize.sub(cubePos).mul(0.5)
      const rbmax = half.sub(pos).div(R)
      const rbmin = half.negate().sub(pos).div(R)

      const rbminmax = vec3(
        R.x.greaterThan(float(0)).select(rbmax.x, rbmin.x),
        R.y.greaterThan(float(0)).select(rbmax.y, rbmin.y),
        R.z.greaterThan(float(0)).select(rbmax.z, rbmin.z),
      )

      const correction    = tslMin(tslMin(rbminmax.x, rbminmax.y), rbminmax.z)
      const boxIntersection = pos.add(R.mul(correction))
      return boxIntersection.sub(cubePos)
    })()

    return pmremTexture(cubeRt.texture, bpcemLookup)
  }, [cubeRt, controls.cubemapOffsetX, controls.cubemapOffsetY, controls.cubemapOffsetZ])

  /* renderCubemap() — Cinder equivalent:
     - render scene with uReflections=0 (MeshBasicNodeMaterial, lightmap only)
     - from mCubemapBounds.getCenter()
     - no geometry hidden (Cinder hides nothing either)
     - skybox visible so opening reads forest                           */
  const capturedRef = useRef(false)

  useFrame(() => {
    if (capturedRef.current || !forestExr) return
    capturedRef.current = true

    const cs = controls.lightMapSRGB ? THREE.SRGBColorSpace : THREE.NoColorSpace

    /* Step 1: apply lightmap-only basic materials (uReflections=0 equivalent) */
    root.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (!mesh.isMesh) return
      const { lightmap } = classify(mesh.name || '')
      const lm = lightmap === 'wood' ? woodLightMap : tileLightMap
      configureLightMap(lm, controls.lightMapChannel, controls.lightMapFlipY, cs)
      mesh.material = new THREE.MeshBasicNodeMaterial({ map: lm, side: THREE.FrontSide })
    })

    /* Step 2: place cubecam at bounds centre, render all 6 faces */
    const cx = CUBEMAP_POS.x + controls.cubemapOffsetX
    const cy = CUBEMAP_POS.y + controls.cubemapOffsetY
    const cz = CUBEMAP_POS.z + controls.cubemapOffsetZ
    cubeCam.position.set(cx, cy, cz)
    cubeCam.updateMatrixWorld(true)

    const prevBg  = scene.background
    const prevEnv = scene.environment
    scene.background = forestExr
    scene.backgroundRotation.set(0, SKYBOX_ROTATION_Y_RAD, 0)
    scene.environment = null

    cubeCam.update(gl as unknown as THREE.WebGLRenderer, scene)

    scene.background  = prevBg
    scene.environment = prevEnv

    /* Step 3: apply full PBR materials (uReflections=1 equivalent) */
    buildMaterials()
  })

  /* Texture configuration */
  useEffect(() => {
    const cs = controls.lightMapSRGB ? THREE.SRGBColorSpace : THREE.NoColorSpace
    configureLightMap(tileLightMap, controls.lightMapChannel, controls.lightMapFlipY, cs)
    configureLightMap(woodLightMap, controls.lightMapChannel, controls.lightMapFlipY, cs)
  }, [tileLightMap, woodLightMap, controls.lightMapChannel, controls.lightMapFlipY, controls.lightMapSRGB])

  useEffect(() => {
    configurePbrTexture(floorColor, THREE.SRGBColorSpace); configurePbrTexture(floorNormal, THREE.NoColorSpace)
    configurePbrTexture(roofColor,  THREE.SRGBColorSpace); configurePbrTexture(roofNormal,  THREE.NoColorSpace)
    configurePbrTexture(roofRoughness, THREE.NoColorSpace)
    configurePbrTexture(wallColor,  THREE.SRGBColorSpace); configurePbrTexture(wallNormal,  THREE.NoColorSpace)
    configurePbrTexture(wallRoughness, THREE.NoColorSpace)
  }, [floorColor, floorNormal, roofColor, roofNormal, roofRoughness, wallColor, wallNormal, wallRoughness])

  const floorSet = useMemo<PbrSet>(() => ({ color: floorColor, normal: floorNormal }), [floorColor, floorNormal])
  const roofSet  = useMemo<PbrSet>(() => ({ color: roofColor, normal: roofNormal, roughness: roofRoughness }), [roofColor, roofNormal, roofRoughness])
  const wallSet  = useMemo<PbrSet>(() => ({ color: wallColor, normal: wallNormal, roughness: wallRoughness }), [wallColor, wallNormal, wallRoughness])

  /* renderScene(withReflections=true) — build full PBR materials */
  const buildMaterialsRef = useRef<(() => void) | null>(null)
  const buildMaterials = () => buildMaterialsRef.current?.()

  useEffect(() => {
    buildMaterialsRef.current = () => {
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
      })

      onReport({ meshCount, uv1Count, unmatched })
    }
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
    scene.backgroundRotation.set(0, SKYBOX_ROTATION_Y_RAD, 0)
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

  const raw = useControls('parallax corrected cubemap', {
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

    cubemap: folder({
      // Equivalent to Cinder's ui::DragFloat3("cubemapPos") and ("cubemapSize")
      // Fine-tune the cubemap bounds centre from the room origin
      cubemapOffsetX: { value: 0, min: -20, max: 20, step: 0.1, label: 'cubemap centre X' },
      cubemapOffsetY: { value: 0, min: -20, max: 20, step: 0.1, label: 'cubemap centre Y' },
      cubemapOffsetZ: { value: 0, min: -20, max: 20, step: 0.1, label: 'cubemap centre Z' },
    }),

    reflections: folder({
      reflectionsEnabled:        { value: true,  label: 'reflections on' },
      globalReflectionIntensity: { value: 1,    min: 0, max: 5,   step: 0.01, label: 'global reflection' },
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
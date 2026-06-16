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
 * AO map attenuates the reflection (envNode) in occluded areas without
 * touching the baked diffuse lightmap.
 *
 * Lightmap owns all diffuse. scene.environment = null always.
 *
 * Post: an anisotropic Kuwahara watercolor chain is applied as a final
 * fullscreen pass via <WatercolorPost/>. It takes over rendering through
 * useFrame priority 1, so it must be mounted after <Scene/>.
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
import WatercolorPost from './WatercolorPost'

extend(THREE as unknown as Record<string, unknown>)

/* ------------------------------ asset paths ------------------------------ */

const MODEL_URL         = '/assets/simple_bake_01.glb'
const TILE_LIGHTMAP_URL = '/assets/bake_black_tile.png'
const WOOD_LIGHTMAP_URL = '/assets/wood_lm.png'
const TILE_AO_URL       = '/assets/ao_tile.png'
const WOOD_AO_URL       = '/assets/ao_wood.png'
const FOREST_EXR_URL    = '/hdr/fall-forest-dirt-road_2K_e53f34e1-5505-4646-adfa-a7d03f4259eb.exr'
const FLOOR_COLOR_URL    = '/pbr/floor/tiles-11_diffuse.jpg'
const FLOOR_NORMAL_URL   = '/pbr/floor/tiles-11_normal.jpg'
const ROOF_COLOR_URL     = '/pbr/roof/concrete_04_color.jpg'
const ROOF_NORMAL_URL    = '/pbr/roof/concrete_04_normal.jpg'
const ROOF_ROUGHNESS_URL = '/pbr/roof/concrete_04_roughness.jpg'
const WALL_COLOR_URL     = '/pbr/wall/tiles10_diffuse.jpg'
const WALL_NORMAL_URL    = '/pbr/wall/tiles10_normal_opengl.jpg'
const WALL_ROUGHNESS_URL = '/pbr/wall/tiles10_roughness.jpg'

const SKYBOX_ROTATION_Y_RAD = THREE.MathUtils.degToRad(277)
const CUBEMAP_SIZE = new THREE.Vector3(168.687, 68.251, 100.167)
const CUBEMAP_POS  = new THREE.Vector3(0, 0, 0)

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
  aoEnabled:                 boolean
  aoMapIntensity:            number
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

  const [tileLightMap, woodLightMap, tileAo, woodAo] = useLoader(THREE.TextureLoader, [
    TILE_LIGHTMAP_URL, WOOD_LIGHTMAP_URL, TILE_AO_URL, WOOD_AO_URL,
  ])

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
    r.updateMatrixWorld(true)
    const box    = new THREE.Box3().setFromObject(r)
    const centre = box.getCenter(new THREE.Vector3())
    r.position.sub(centre)
    r.updateMatrixWorld(true)
    console.info('[room] recentred. original centre:', centre)
    return r
  }, [gltf.scene])

  /* cube render target — static, captured once */
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

  /* BPCEM env node — exact Cinder shader.frag getBoxIntersection() */
  const bpcemEnvNode = useMemo(() => {
    const ox = controls.cubemapOffsetX ?? 0
    const oy = controls.cubemapOffsetY ?? 0
    const oz = controls.cubemapOffsetZ ?? 0

    const bpcemLookup = Fn(() => {
      const cubeSize = vec3(CUBEMAP_SIZE.x, CUBEMAP_SIZE.y, CUBEMAP_SIZE.z)
      const cubePos  = vec3(CUBEMAP_POS.x + ox, CUBEMAP_POS.y + oy, CUBEMAP_POS.z + oz)
      const pos = positionWorld
      const R   = reflectVector
      const half   = cubeSize.sub(cubePos).mul(0.5)
      const rbmax  = half.sub(pos).div(R)
      const rbmin  = half.negate().sub(pos).div(R)
      const rbminmax = vec3(
        R.x.greaterThan(float(0)).select(rbmax.x, rbmin.x),
        R.y.greaterThan(float(0)).select(rbmax.y, rbmin.y),
        R.z.greaterThan(float(0)).select(rbmax.z, rbmin.z),
      )
      const correction     = tslMin(tslMin(rbminmax.x, rbminmax.y), rbminmax.z)
      const boxIntersection = pos.add(R.mul(correction))
      return boxIntersection.sub(cubePos)
    })()

    return pmremTexture(cubeRt.texture, bpcemLookup)
  }, [cubeRt, controls.cubemapOffsetX, controls.cubemapOffsetY, controls.cubemapOffsetZ])

  /* renderCubemap() — once on load, never again */
  const capturedRef = useRef(false)

  useFrame(() => {
    if (capturedRef.current || !forestExr) return
    capturedRef.current = true

    const cs = controls.lightMapSRGB ? THREE.SRGBColorSpace : THREE.NoColorSpace

    // step 1: lightmap-only basic materials (no reflections during capture)
    root.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (!mesh.isMesh) return
      const { lightmap } = classify(mesh.name || '')
      const lm = lightmap === 'wood' ? woodLightMap : tileLightMap
      configureLightMap(lm, controls.lightMapChannel, controls.lightMapFlipY, cs)
      mesh.material = new THREE.MeshBasicNodeMaterial({ map: lm, side: THREE.FrontSide })
    })

    // step 2: render cubemap from bounds centre
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

    // step 3: apply full PBR + BPCEM + AO materials
    buildMaterials()
  })

  /* texture configuration */
  useEffect(() => {
    const cs = controls.lightMapSRGB ? THREE.SRGBColorSpace : THREE.NoColorSpace
    configureLightMap(tileLightMap, controls.lightMapChannel, controls.lightMapFlipY, cs)
    configureLightMap(woodLightMap, controls.lightMapChannel, controls.lightMapFlipY, cs)
    // AO baked as sRGB 8-bit PNG — decode sRGB so linear values feed correctly
    for (const ao of [tileAo, woodAo]) {
      ao.flipY      = controls.lightMapFlipY
      ao.channel    = controls.lightMapChannel
      ao.colorSpace = THREE.SRGBColorSpace
      ao.wrapS      = THREE.ClampToEdgeWrapping
      ao.wrapT      = THREE.ClampToEdgeWrapping
      ao.needsUpdate = true
    }
  }, [tileLightMap, woodLightMap, tileAo, woodAo, controls.lightMapChannel, controls.lightMapFlipY, controls.lightMapSRGB])

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

  /* build PBR materials */
  const buildMaterialsRef = useRef<(() => void) | null>(null)
  const buildMaterials = () => buildMaterialsRef.current?.()

  useEffect(() => {
    buildMaterialsRef.current = () => {
      let meshCount = 0, uv1Count = 0
      const unmatched: string[] = []
      const pbrMode = controls.materialMode === 'PBR + baked GI'

      const applyLm = (m: THREE.MeshStandardNodeMaterial, group: Group, lm: THREE.Texture, ao: THREE.Texture) => {
        m.lightMap          = controls.bakedGiEnabled ? lm : null
        m.lightMapIntensity = controls.bakedGiEnabled ? controls.lightMapIntensity : 0
        // AO attenuates envNode reflection in occluded areas (under table, corners).
        // Does not affect the baked diffuse lightmap.
        m.aoMap          = controls.aoEnabled ? ao : null
        m.aoMapIntensity = controls.aoEnabled ? controls.aoMapIntensity : 0
        m.envNode         = pbrMode && controls.reflectionsEnabled ? bpcemEnvNode : null
        m.envMap          = null
        m.envMapIntensity = pbrMode && controls.reflectionsEnabled ? envIntensity(group, controls) : 0
        m.needsUpdate     = true
        return m
      }

      const makeGiOnly = (lm: THREE.Texture, ao: THREE.Texture) =>
        applyLm(new THREE.MeshStandardNodeMaterial({ color: '#fff', roughness: 1, metalness: 0, side: THREE.FrontSide }), 'unknown', lm, ao)

      const makePbr = (set: PbrSet, rough: number, group: Group, lm: THREE.Texture, ao: THREE.Texture) =>
        applyLm(new THREE.MeshStandardNodeMaterial({
          color: '#fff', map: set.color, normalMap: set.normal,
          roughnessMap: set.roughness ?? null, roughness: rough, metalness: 0, side: THREE.FrontSide,
        }), group, lm, ao)

      const fromGlb = (orig: THREE.Material, group: Group, lm: THREE.Texture, ao: THREE.Texture) =>
        applyLm(copyPbr(Array.isArray(orig) ? orig[0] : orig, new THREE.MeshStandardNodeMaterial()), group, lm, ao)

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
        const ao = lightmap === 'wood' ? woodAo       : tileAo
        let material: THREE.Material

        if      (controls.materialMode === 'UV debug') material = makeUvDebug(lm)
        else if (controls.materialMode === 'GI only')  material = makeGiOnly(lm, ao)
        else if (controls.allFromGlb)                  material = fromGlb(original, group, lm, ao)
        else if (group === 'floor')  material = makePbr(floorSet, controls.floorRoughness, group, lm, ao)
        else if (group === 'wall')   material = makePbr(wallSet,  controls.wallRoughness,  group, lm, ao)
        else if (group === 'roof')   material = makePbr(roofSet,  controls.roofRoughness,  group, lm, ao)
        else {
          if (group === 'unknown') unmatched.push(mesh.name || '(unnamed)')
          material = fromGlb(original, group, lm, ao)
        }

        mesh.material = material
      })

      onReport({ meshCount, uv1Count, unmatched })
    }
    buildMaterialsRef.current()
  }, [
    root, bpcemEnvNode, tileLightMap, woodLightMap, tileAo, woodAo,
    floorSet, roofSet, wallSet, onReport,
    controls.materialMode, controls.bakedGiEnabled, controls.lightMapIntensity,
    controls.reflectionsEnabled, controls.globalReflectionIntensity,
    controls.floorEnvIntensity, controls.wallEnvIntensity, controls.roofEnvIntensity,
    controls.woodEnvIntensity, controls.metalEnvIntensity,
    controls.aoEnabled, controls.aoMapIntensity,
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

    ao: folder({
      aoEnabled:      { value: true,  label: 'AO on' },
      aoMapIntensity: { value: 0.5, min: 0, max: 1, step: 0.01, label: 'AO intensity' },
    }),

    roughness: folder({
      floorRoughness: { value: 0.2,  min: 0, max: 1, step: 0.01, label: 'floor' },
      wallRoughness:  { value: 0.5,  min: 0, max: 1, step: 0.01, label: 'wall'  },
      roofRoughness:  { value: 0.85, min: 0, max: 1, step: 0.01, label: 'roof'  },
      allFromGlb:     { value: false, label: 'all from GLB' },
    }),
  })

  const post = useControls('watercolor post', {
    postEnabled:  { value: true, label: 'effect on' },
    kuwaharaRadius: { value: 10, min: 1, max: 20, step: 1, label: 'kuwahara radius' },
    stylize: { value: false, label: 'stylize (quantize+ACES)' },
    resolutionScale: { value: 0.5, min: 0.25, max: 1, step: 0.05, label: 'resolution scale' },
  }) as unknown as { postEnabled: boolean; kuwaharaRadius: number; stylize: boolean; resolutionScale: number }

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
      <Canvas frameloop="demand" gl={createRenderer} dpr={[1, 1.5]} camera={{ position: [5, 3, 6], fov: 42, near: 0.1, far: 50000 }}>
        <Suspense fallback={null}>
          <Scene controls={controls} onReport={setReport} />
          <WatercolorPost
            radius={post.kuwaharaRadius}
            enabled={post.postEnabled}
            stylize={post.stylize}
            resolutionScale={post.resolutionScale}
          />
        </Suspense>
      </Canvas>
    </main>
  )
}
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
 * ─── Shadow fix note ─────────────────────────────────────────────────────────
 * WebGPU shadows MUST be enabled via <Canvas shadows={...} /> prop, NOT by
 * setting renderer.shadowMap.enabled manually inside createRenderer().
 * R3F initialises the renderer internally after createRenderer() returns —
 * any manual shadowMap config set before that point is overwritten.
 * The Canvas shadows prop hooks into R3F's own init sequence at the correct time.
 */

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Canvas, extend, useFrame, useLoader, useThree } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import { folder, useControls, button } from 'leva'
import * as THREE from 'three/webgpu'
import { Fn, float, lights, min as tslMin, positionWorld, pmremTexture, reflectVector, vec3 } from 'three/tsl'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js'
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js'

extend(THREE as unknown as Record<string, unknown>)

/* ------------------------------ asset paths ------------------------------ */

const MODEL_URL         = '/assets/simple_bake_01.glb'
const TEST_MODELS_URL   = '/assets/test_models.glb'
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
  None:     THREE.NoToneMapping,
  Linear:   THREE.LinearToneMapping,
  Reinhard: THREE.ReinhardToneMapping,
  Cineon:   THREE.CineonToneMapping,
  ACES:     THREE.ACESFilmicToneMapping,
  AgX:      THREE.AgXToneMapping,
  Neutral:  THREE.NeutralToneMapping,
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
  cameraFov:                 number
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
  modelX:                    number
  modelY:                    number
  modelZ:                    number
  modelScale:                number
  spotEnabled:               boolean
  spotX:                     number
  spotY:                     number
  spotZ:                     number
  spotTargetX:               number
  spotTargetY:               number
  spotTargetZ:               number
  spotColor:                 string
  spotIntensity:             number
  spotAngle:                 number
  spotPenumbra:              number
  spotDecay:                 number
  spotDistance:              number
  shadowNear:                number
  shadowFar:                 number
  shadowFocus:               number
  shadowIntensity:           number
  showHelper:                boolean
  // point lights
  roomLightX:      number
  roomLightY:      number
  roomLightZ:      number
  roomLightColor:  string
  roomLightIntensity: number
  modelLightX:     number
  modelLightY:     number
  modelLightZ:     number
  modelLightColor: string
  modelLightIntensity: number
  dirLightX:         number
  dirLightY:         number
  dirLightZ:         number
  dirLightColor:     string
  dirLightIntensity: number
}

type PbrSet    = { color: THREE.Texture; normal: THREE.Texture; roughness?: THREE.Texture }
type MeshReport = { meshCount: number; uv1Count: number; unmatched: string[] }

/* ------------------------------- renderer -------------------------------- */

function RendererSettings({ toneMapping, exposure, fov }: {
  toneMapping: THREE.ToneMapping
  exposure: number
  fov: number
}) {
  const { gl, camera } = useThree()
  useEffect(() => {
    const r = gl as unknown as THREE.WebGPURenderer
    r.outputColorSpace    = THREE.SRGBColorSpace
    r.toneMapping         = toneMapping
    r.toneMappingExposure = exposure
  }, [gl, toneMapping, exposure])
  useEffect(() => {
    const cam = camera as THREE.PerspectiveCamera
    cam.fov = fov
    cam.updateProjectionMatrix()
  }, [camera, fov])
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

/* ---------------------------- test models -------------------------------- */

function TestModels({ controls, modelLight, dirLight, spotLight }: {
  controls: SceneControls
  modelLight: THREE.PointLight | null
  dirLight:   THREE.DirectionalLight | null
  spotLight:  THREE.SpotLight | null
}) {
  const gltf = useLoader(GLTFLoader, TEST_MODELS_URL, (l) => l.setDRACOLoader(dracoLoader))
  const root = useMemo(() => gltf.scene.clone(true), [gltf.scene])

  useEffect(() => {
    root.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (!mesh.isMesh) return
      mesh.castShadow    = true
      mesh.receiveShadow = true
      // MeshStandardNodeMaterial so we can use lightsNode
      const m = new THREE.MeshStandardNodeMaterial({
        color: '#f2f2f2',
        roughness: 0.7,
        metalness: 0.0,
        side: THREE.DoubleSide,
      })
      // Selective lighting: model only receives modelLight, not roomLight or spotlight
      // Models get both point light and directional light
      const lightList = [...(modelLight ? [modelLight] : []), ...(dirLight ? [dirLight] : []), ...(spotLight ? [spotLight] : [])]
      m.lightsNode = lights(lightList)
      mesh.material = m
    })
  }, [root, modelLight, dirLight, spotLight])

  return (
    <primitive
      object={root}
      position={[controls.modelX, controls.modelY, controls.modelZ]}
      scale={controls.modelScale}
    />
  )
}

/* --------------------------------- room ---------------------------------- */

function BakedRoom({ controls, forestExr, onReport, roomLight }: {
  controls:  SceneControls
  forestExr: THREE.Texture | null
  onReport:  (r: MeshReport) => void
  roomLight: THREE.PointLight | null
  dirLight:  THREE.DirectionalLight | null
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
    // Table and shelf cast shadows to block the spotlight
    r.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (!mesh.isMesh) return
      mesh.receiveShadow = true
      const n = (mesh.name || '').toLowerCase()
      const isTable = n.includes('table') || n.includes('shelf')
      mesh.castShadow = isTable
      if (isTable && mesh.material) {
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
        mats.forEach((m: THREE.Material) => { m.side = THREE.DoubleSide })
      }
    })
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
      const correction      = tslMin(tslMin(rbminmax.x, rbminmax.y), rbminmax.z)
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

    root.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (!mesh.isMesh) return
      const { lightmap } = classify(mesh.name || '')
      const lm = lightmap === 'wood' ? woodLightMap : tileLightMap
      configureLightMap(lm, controls.lightMapChannel, controls.lightMapFlipY, cs)
      mesh.material = new THREE.MeshBasicNodeMaterial({ map: lm, side: THREE.FrontSide })
    })

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

    buildMaterials()
  })

  /* texture configuration */
  useEffect(() => {
    const cs = controls.lightMapSRGB ? THREE.SRGBColorSpace : THREE.NoColorSpace
    configureLightMap(tileLightMap, controls.lightMapChannel, controls.lightMapFlipY, cs)
    configureLightMap(woodLightMap, controls.lightMapChannel, controls.lightMapFlipY, cs)
    for (const ao of [tileAo, woodAo]) {
      ao.flipY       = controls.lightMapFlipY
      ao.channel     = controls.lightMapChannel
      ao.colorSpace  = THREE.SRGBColorSpace
      ao.wrapS       = THREE.ClampToEdgeWrapping
      ao.wrapT       = THREE.ClampToEdgeWrapping
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
        m.aoMap             = controls.aoEnabled ? ao : null
        m.aoMapIntensity    = controls.aoEnabled ? controls.aoMapIntensity : 0
        m.envNode           = pbrMode && controls.reflectionsEnabled ? bpcemEnvNode : null
        m.envMap            = null
        m.envMapIntensity   = pbrMode && controls.reflectionsEnabled ? envIntensity(group, controls) : 0
        // Selective lighting: room only receives roomLight, not modelLight or spotlight
        // Room gets roomLight only — dirLight is for models only
        m.lightsNode        = roomLight ? lights([roomLight]) : lights([])
        m.needsUpdate       = true
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
    controls.allFromGlb, roomLight,
  ])

  return <primitive object={root} />
}

/* ------------------------------ camera setup ----------------------------- */

function FrameOnce() {
  const { camera, controls } = useThree()
  const done = useRef(false)
  useEffect(() => {
    if (done.current) return
    // Room is 168 × 68 × 100 m recentred at origin.
    // Fixed position — avoids Box3 picking up spotlight targets and invisible objects.
    camera.position.set(80, 40, 120)
    camera.near = 0.5
    camera.far  = 2000
    camera.updateProjectionMatrix()
    const c = controls as unknown as {
      target?: THREE.Vector3; update?: () => void
      enableDamping?: boolean; dampingFactor?: number
      minDistance?: number; maxDistance?: number
    }
    if (c?.target) {
      c.target.set(0, 0, 0)
      c.enableDamping = true
      c.dampingFactor = 0.08
      c.minDistance   = 5
      c.maxDistance   = 800
      c.update?.()
      done.current = true
    } else {
      camera.lookAt(0, 0, 0)
    }
  }, [camera, controls])
  return null
}

/* ---------------------------- point lights -------------------------------- */
/* Two point lights following the selective lights example pattern:
   - roomLight: added to scene, lightsNode on room materials includes it
   - modelLight: added to scene, lightsNode on model materials includes it
   Room materials get lightsNode = lights([roomLight])
   Model materials get lightsNode = lights([modelLight])
   Each light only affects its assigned materials. */
function SceneLights({
  onRoomLight, onModelLight, onDirLight, onSpotLight, controls,
}: {
  onRoomLight:  (l: THREE.PointLight | null) => void
  onModelLight: (l: THREE.PointLight | null) => void
  onDirLight:   (l: THREE.DirectionalLight | null) => void
  onSpotLight:  (l: THREE.SpotLight | null) => void
  controls: SceneControls
}) {
  const { scene } = useThree()
  const roomRef  = useRef<THREE.PointLight | null>(null)
  const modelRef = useRef<THREE.PointLight | null>(null)
  const dirRef   = useRef<THREE.DirectionalLight | null>(null)
  const spotRef  = useRef<THREE.SpotLight | null>(null)
  const helperRef = useRef<THREE.SpotLightHelper | null>(null)

  useEffect(() => {
    const room  = new THREE.PointLight(controls.roomLightColor,  controls.roomLightIntensity,  0, 2)
    const model = new THREE.PointLight(controls.modelLightColor, controls.modelLightIntensity, 0, 2)
    const dir   = new THREE.DirectionalLight(controls.dirLightColor, controls.dirLightIntensity)
    dir.position.set(controls.dirLightX, controls.dirLightY, controls.dirLightZ)
    dir.castShadow = true
    dir.shadow.mapSize.width  = 2048
    dir.shadow.mapSize.height = 2048
    dir.shadow.camera.near   = 1
    dir.shadow.camera.far    = 500
    dir.shadow.camera.left   = -100
    dir.shadow.camera.right  =  100
    dir.shadow.camera.top    =  100
    dir.shadow.camera.bottom = -100
    dir.shadow.bias          = -0.001

    const spot = new THREE.SpotLight(0xffffff, 1000)
    spot.castShadow = true
    spot.shadow.mapSize.width  = 1024
    spot.shadow.mapSize.height = 1024
    spot.shadow.camera.near    = 10
    spot.shadow.camera.far     = 100
    spot.shadow.focus          = 1
    spot.shadow.bias           = -0.003

    const helper = new THREE.SpotLightHelper(spot)
    helper.visible = false

    scene.add(room, model, dir, spot, helper)
    roomRef.current  = room
    modelRef.current = model
    dirRef.current   = dir
    spotRef.current  = spot
    helperRef.current = helper
    onRoomLight(room)
    onModelLight(model)
    onDirLight(dir)
    onSpotLight(spot)

    return () => {
      scene.remove(room, model, dir, spot, helper)
      helper.dispose()
      onRoomLight(null); onModelLight(null); onDirLight(null); onSpotLight(null)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene])

  useFrame(() => {
    if (roomRef.current) {
      roomRef.current.position.set(controls.roomLightX, controls.roomLightY, controls.roomLightZ)
      roomRef.current.color.set(controls.roomLightColor)
      roomRef.current.intensity = controls.roomLightIntensity
    }
    if (modelRef.current) {
      modelRef.current.position.set(controls.modelLightX, controls.modelLightY, controls.modelLightZ)
      modelRef.current.color.set(controls.modelLightColor)
      modelRef.current.intensity = controls.modelLightIntensity
    }
    if (dirRef.current) {
      dirRef.current.position.set(controls.dirLightX, controls.dirLightY, controls.dirLightZ)
      dirRef.current.color.set(controls.dirLightColor)
      dirRef.current.intensity = controls.dirLightIntensity
    }
    if (spotRef.current && helperRef.current) {
      const s = spotRef.current
      s.visible   = controls.spotEnabled
      s.position.set(controls.spotX, controls.spotY, controls.spotZ)
      s.color.set(controls.spotColor)
      s.intensity = controls.spotIntensity
      s.angle     = controls.spotAngle
      s.penumbra  = controls.spotPenumbra
      s.decay     = controls.spotDecay
      s.distance  = controls.spotDistance
      s.target.position.set(controls.spotTargetX, controls.spotTargetY, controls.spotTargetZ)
      s.target.updateMatrixWorld()
      s.shadow.camera.near = controls.shadowNear
      s.shadow.camera.far  = controls.shadowFar
      s.shadow.camera.updateProjectionMatrix()
      s.shadow.focus       = controls.shadowFocus
      s.shadow.intensity   = controls.shadowIntensity
      helperRef.current.visible = controls.showHelper && controls.spotEnabled
      helperRef.current.update()
    }
  })

  return null
}

/* -------------------------------- scene ---------------------------------- */

function Scene({ controls, onReport }: { controls: SceneControls; onReport: (r: MeshReport) => void }) {
  const [forestExr,   setForestExr]   = useState<THREE.Texture | null>(null)
  const [roomLight,   setRoomLight]   = useState<THREE.PointLight | null>(null)
  const [modelLight,  setModelLight]  = useState<THREE.PointLight | null>(null)
  const [dirLight,    setDirLight]    = useState<THREE.DirectionalLight | null>(null)
  const [spotLight,   setSpotLight]   = useState<THREE.SpotLight | null>(null)
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
      <RendererSettings toneMapping={controls.toneMapping} exposure={controls.exposure} fov={controls.cameraFov} />
      <SceneLights onRoomLight={setRoomLight} onModelLight={setModelLight} onDirLight={setDirLight} onSpotLight={setSpotLight} controls={controls} />
      <BakedRoom controls={controls} forestExr={forestExr} onReport={onReport} roomLight={roomLight} dirLight={dirLight} />
      <Suspense fallback={null}>
        <TestModels controls={controls} modelLight={modelLight} dirLight={dirLight} spotLight={spotLight} />
      </Suspense>
      <FrameOnce />
      <OrbitControls makeDefault enablePan enableZoom enableDamping dampingFactor={0.08} />
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
      cameraFov:          { value: 42, min: 10, max: 90, step: 1, label: 'camera FOV' },
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
      aoMapIntensity: { value: 0.5, min: 0, max: 3, step: 0.01, label: 'AO intensity' },
    }),

    roughness: folder({
      floorRoughness: { value: 0.2,  min: 0, max: 1, step: 0.01, label: 'floor' },
      wallRoughness:  { value: 0.5,  min: 0, max: 1, step: 0.01, label: 'wall'  },
      roofRoughness:  { value: 0.85, min: 0, max: 1, step: 0.01, label: 'roof'  },
      allFromGlb:     { value: false, label: 'all from GLB' },
    }),

    testModels: folder({
      modelX:     { value: 16.5,  min: -200, max: 200, step: 0.5,  label: 'model X' },
      modelY:     { value: -36.3, min: -100, max: 100, step: 0.1,  label: 'model Y' },
      modelZ:     { value: -13.0, min: -200, max: 200, step: 0.5,  label: 'model Z' },
      modelScale: { value: 1,     min: 0.01, max: 10,  step: 0.01, label: 'model scale' },
    }),

    pointLights: folder({
      roomLightX:         { value: 0,       min: -200, max: 200, step: 1,    label: 'room light X' },
      roomLightY:         { value: 30,      min: -100, max: 200, step: 1,    label: 'room light Y' },
      roomLightZ:         { value: 0,       min: -200, max: 200, step: 1,    label: 'room light Z' },
      roomLightColor:     { value: '#ffcc88',                               label: 'room light color' },
      roomLightIntensity: { value: 0,       min: 0,    max: 50000, step: 10, label: 'room light intensity' },
      modelLightX:        { value: 16.5,    min: -200, max: 200, step: 1,    label: 'model light X' },
      modelLightY:        { value: 10,      min: -100, max: 200, step: 1,    label: 'model light Y' },
      modelLightZ:        { value: -13.0,   min: -200, max: 200, step: 1,    label: 'model light Z' },
      modelLightColor:    { value: '#aaddff',                               label: 'model light color' },
      modelLightIntensity:{ value: 5000,    min: 0,    max: 50000, step: 10, label: 'model light intensity' },
      dirLightX:          { value: -80,     min: -300, max: 300, step: 1,    label: 'dir light X' },
      dirLightY:          { value: 40,      min: -100, max: 300, step: 1,    label: 'dir light Y' },
      dirLightZ:          { value: 120,     min: -300, max: 300, step: 1,    label: 'dir light Z' },
      dirLightColor:      { value: '#fff8f0',                               label: 'dir light color' },
      dirLightIntensity:  { value: 3.0,     min: 0,    max: 20,  step: 0.1,  label: 'dir light intensity' },
    }),

    spotlight: folder({
      spotEnabled:     { value: true,      label: 'spotlight on' },
      spotX:           { value: 16.5,  min: -200, max: 200,   step: 1,    label: 'light X' },
      spotY:           { value: 20,    min: -100, max: 200,   step: 1,    label: 'light Y' },
      spotZ:           { value: -13.0, min: -200, max: 200,   step: 1,    label: 'light Z' },
      spotTargetX:     { value: 16.5,  min: -200, max: 200,   step: 1,    label: 'target X' },
      spotTargetY:     { value: -36.0, min: -100, max: 50,    step: 1,    label: 'target Y' },
      spotTargetZ:     { value: -13.0, min: -200, max: 200,   step: 1,    label: 'target Z' },
      spotColor:       { value: '#ffffff',                                label: 'color' },
      spotIntensity:   { value: 1000,  min: 0,    max: 50000, step: 10,   label: 'intensity' },
      spotAngle:       { value: 0.4,   min: 0.01, max: 1.05,  step: 0.01, label: 'angle (rad)' },
      spotPenumbra:    { value: 0.5,   min: 0,    max: 1,     step: 0.01, label: 'penumbra' },
      spotDecay:       { value: 2,     min: 0,    max: 2,     step: 0.1,  label: 'decay' },
      spotDistance:    { value: 0,     min: 0,    max: 500,   step: 1,    label: 'distance (0=∞)' },
      shadowNear:      { value: 10,    min: 0.1,  max: 100,   step: 0.5,  label: 'shadow near' },
      shadowFar:       { value: 80,    min: 10,   max: 500,   step: 1,    label: 'shadow far' },
      shadowFocus:     { value: 1,     min: 0,    max: 1,     step: 0.01, label: 'shadow focus' },
      shadowIntensity: { value: 1,     min: 0,    max: 1,     step: 0.01, label: 'shadow intensity' },
      showHelper:      { value: false,                                    label: 'show helper' },
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
      <Canvas gl={createRenderer} shadows dpr={[1, 1.5]} camera={{ position: [5, 3, 6], fov: 42, near: 0.1, far: 50000 }}>
        <Suspense fallback={null}>
          <Scene controls={controls} onReport={setReport} />
        </Suspense>
      </Canvas>
    </main>
  )
}
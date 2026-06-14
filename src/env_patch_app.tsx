/**
 * App.tsx
 * ---------------------------------------------------------------------------
 * Lightmap-check harness, wired to this project, with exact mesh-name routing.
 *
 * LIGHTING MODEL
 *   - Diffuse is owned ENTIRELY by the baked lightmap (Blender/Cycles direct +
 *     indirect). The scene is never lit globally: scene.environment stays null.
 *   - Reflections come from a per-material envMap whose DIFFUSE contribution is
 *     zeroed in-shader (uEnvDiffuseScale, default 0), so it never floods or
 *     double-counts the bake. envMapIntensity is therefore a clean specular knob.
 *   - Reflection source is selectable:
 *       'hdri'        -> PMREM of the forest EXR (infinite, generic)
 *       'room cubemap'-> CubeCamera capture of THIS room, PMREM'd. Captured once
 *                        (static lighting), recapture on demand. Mostly dark
 *                        walls + bright opening, so it reflects the real room
 *                        and cannot flood.
 *       'none'        -> no reflections.
 *
 * CUBE CAPTURE (static): the room is photographed from a point inside it. To
 *   keep it a clean single bounce, each capture temporarily zeroes every
 *   material's envMapIntensity and forces the forest EXR as background (so the
 *   opening reads real forest), then restores. Rendered once at load; hit
 *   "recapture" in the 'cube capture' panel after changing the bake/lighting.
 *
 * Meshes in lightmap_bake_simple:
 *   new_floor, new_roof, new_wall_01/02/03   -> tile bake  (bake_black_tile.png)
 *   table_tiles                              -> tile bake
 *   shelf, table_wood, table_wood_beading    -> wood bake  (wood_lm.png)
 *   table_metal                              -> wood bake  (assumed; see note)
 *
 * VERIFY THE BAKE: materialMode "GI only", materialEnv off, tone mapping None,
 * intensity 1 -> white room lit only by the two bakes; should match Blender.
 * ---------------------------------------------------------------------------
 */

import { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { Canvas, useLoader, useThree } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import { useControls, button } from 'leva'
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js'
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js'

/* ------------------------------ asset paths ------------------------------ */

const MODEL_URL = '/assets/simple_bake_01.glb'

const TILE_LIGHTMAP_URL = '/assets/bake_black_tile.png'
const WOOD_LIGHTMAP_URL = '/assets/wood_lm.png'

const TILE_AO_URL = '/assets/ao_tile.png'
const WOOD_AO_URL = '/assets/ao_wood.png'

const HDR_URL =
  '/hdr/fall-forest-dirt-road_2K_e53f34e1-5505-4646-adfa-a7d03f4259eb.exr'

const FLOOR_COLOR_URL = '/pbr/floor/tiles-11_diffuse.jpg'
const FLOOR_NORMAL_URL = '/pbr/floor/tiles-11_normal.jpg'

const ROOF_COLOR_URL = '/pbr/roof/concrete_04_color.jpg'
const ROOF_NORMAL_URL = '/pbr/roof/concrete_04_normal.jpg'
const ROOF_ROUGHNESS_URL = '/pbr/roof/concrete_04_roughness.jpg'

const WALL_COLOR_URL = '/pbr/wall/tiles10_diffuse.jpg'
const WALL_NORMAL_URL = '/pbr/wall/tiles10_normal_opengl.jpg'
const WALL_ROUGHNESS_URL = '/pbr/wall/tiles10_roughness.jpg'

/* --------------------------- mesh name routing --------------------------- */

type Group = 'floor' | 'wall' | 'roof' | 'wood' | 'metal' | 'unknown'
type Atlas = 'tile' | 'wood'

/* Classify each mesh by name. `group` picks the material, `lightmap` picks
   which baked atlas it samples. Edit here if a mesh routes wrong. */
function classify(name: string): { group: Group; lightmap: Atlas } {
  const n = name.toLowerCase()

  if (n.includes('beading') || n.includes('wood')) return { group: 'wood', lightmap: 'wood' }
  if (n.includes('metal')) return { group: 'metal', lightmap: 'wood' }
  if (n.startsWith('shelf')) return { group: 'wood', lightmap: 'wood' }

  // table top tile uses the same black grid as the walls
  if (n.includes('table') && n.includes('tile')) return { group: 'wall', lightmap: 'tile' }

  if (n.startsWith('new_floor') || n.startsWith('floor')) return { group: 'floor', lightmap: 'tile' }
  if (n.startsWith('new_roof') || n.startsWith('roof') || n.includes('ceiling'))
    return { group: 'roof', lightmap: 'tile' }
  if (n.startsWith('new_wall') || n.startsWith('wall')) return { group: 'wall', lightmap: 'tile' }

  return { group: 'unknown', lightmap: 'tile' }
}

/* --------------------------------- draco --------------------------------- */

const dracoLoader = new DRACOLoader()
dracoLoader.setDecoderPath('/draco/')
dracoLoader.setDecoderConfig({ type: 'wasm' })

/* ------------------------------ tone mapping ----------------------------- */

const TONE_MAPPING: Record<string, THREE.ToneMapping> = {
  None: THREE.NoToneMapping, // closest match to Blender "Standard"
  AgX: THREE.AgXToneMapping, // use this if you keep Blender on AgX
  Neutral: THREE.NeutralToneMapping,
  ACES: THREE.ACESFilmicToneMapping,
}

type ReflectionSource = 'hdri' | 'room cubemap' | 'none'

/* ------------------- env diffuse kill (shader patch) --------------------- */
/* Zero (or scale) the env map's DIFFUSE irradiance while leaving the specular
   radiance intact, so any envMap gives reflections without flooding or double-
   counting the baked diffuse. Driven by a uEnvDiffuseScale uniform so the patch
   string is constant (stable program cache key) and tunable live.

   Target line lives in three/src/.../ShaderChunk/lights_fragment_maps.glsl.js
   for r152+. If a future three release renames it, the replace no-ops and we
   warn instead of silently flooding. */
const ENV_KILL_FLAG = '__envDiffuseKillPatched'
const IBL_TARGET = 'iblIrradiance += getIBLIrradiance( geometryNormal );'
const IBL_REPLACE =
  'iblIrradiance += getIBLIrradiance( geometryNormal ) * uEnvDiffuseScale;'

function patchEnvDiffuseKill(
  mat: THREE.MeshStandardMaterial,
  initialScale: number,
  collect: (u: { value: number }) => void,
) {
  const flagged = mat as unknown as Record<string, boolean>
  if (flagged[ENV_KILL_FLAG]) return
  flagged[ENV_KILL_FLAG] = true

  const prev = mat.onBeforeCompile?.bind(mat)
  mat.onBeforeCompile = (shader, renderer) => {
    prev?.(shader, renderer)
    const u = { value: initialScale }
    shader.uniforms.uEnvDiffuseScale = u
    shader.fragmentShader = 'uniform float uEnvDiffuseScale;\n' + shader.fragmentShader
    if (shader.fragmentShader.includes(IBL_TARGET)) {
      shader.fragmentShader = shader.fragmentShader.replace(IBL_TARGET, IBL_REPLACE)
    } else {
      console.warn(
        '[envDiffuseKill] IBL irradiance line not found; env diffuse NOT ' +
          'suppressed. Check lights_fragment_maps.glsl.js for your three version.',
      )
    }
    collect(u)
  }
  mat.customProgramCacheKey = () => 'envDiffuseKill'
  mat.needsUpdate = true
}

function envIntensityForGroup(group: Group, c: SceneControls): number {
  switch (group) {
    case 'floor': return c.floorEnvIntensity
    case 'wall': return c.wallEnvIntensity
    case 'roof': return c.roofEnvIntensity
    case 'wood': return c.woodEnvIntensity
    case 'metal': return c.metalEnvIntensity
    default: return c.wallEnvIntensity
  }
}

/* ------------------------------- renderer -------------------------------- */

function RendererSettings({
  toneMapping,
  exposure,
}: {
  toneMapping: THREE.ToneMapping
  exposure: number
}) {
  const { gl } = useThree()
  useEffect(() => {
    gl.outputColorSpace = THREE.SRGBColorSpace
    gl.toneMapping = toneMapping
    gl.toneMappingExposure = exposure
  }, [gl, toneMapping, exposure])
  return null
}

/* ----------------- HDR background + reflection-only env ------------------ */
/* Loads the EXR manually. Keeps the raw equirect for the optional background
   AND for the cube-capture background, PMREM-prefilters a copy for the 'hdri'
   reflection option, and pins scene.environment = null so nothing is globally
   lit. Both textures are reported up via onReady. */
function HdrBackgroundAndReflectionMap({
  asBackground,
  rotationDeg,
  backgroundColor,
  onReady,
}: {
  asBackground: boolean
  rotationDeg: number
  backgroundColor: string
  onReady: (h: { reflection: THREE.Texture; raw: THREE.Texture } | null) => void
}) {
  const { gl, scene } = useThree()
  const exr = useLoader(EXRLoader, HDR_URL)

  const envTex = useMemo(() => {
    exr.mapping = THREE.EquirectangularReflectionMapping
    const pmrem = new THREE.PMREMGenerator(gl)
    pmrem.compileEquirectangularShader()
    const tex = pmrem.fromEquirectangular(exr).texture
    pmrem.dispose()
    return tex
  }, [exr, gl])

  useEffect(() => {
    onReady({ reflection: envTex, raw: exr })
    return () => {
      onReady(null)
      envTex.dispose()
    }
  }, [envTex, exr, onReady])

  useEffect(() => {
    scene.environment = null
    scene.background = asBackground ? exr : new THREE.Color(backgroundColor)
    const s = scene as unknown as { backgroundRotation?: THREE.Euler }
    if (s.backgroundRotation?.set) {
      s.backgroundRotation.set(0, THREE.MathUtils.degToRad(rotationDeg), 0)
    }
  }, [scene, asBackground, backgroundColor, rotationDeg, exr])

  return null
}

/* ---------------------------- texture helpers ---------------------------- */

function configurePbrTexture(
  texture: THREE.Texture,
  colorSpace: THREE.ColorSpace,
) {
  texture.flipY = false
  texture.channel = 0 // base maps use uv0 (your Blender UVs, as-is)
  texture.colorSpace = colorSpace
  texture.wrapS = THREE.RepeatWrapping
  texture.wrapT = THREE.RepeatWrapping
  texture.anisotropy = 8 // filtering only, not tiling
  texture.needsUpdate = true
}

function configureLightMap(
  lightMap: THREE.Texture,
  channel: number,
  flipY: boolean,
  colorSpace: THREE.ColorSpace,
) {
  lightMap.flipY = flipY
  lightMap.channel = channel // uv1
  lightMap.colorSpace = colorSpace
  lightMap.wrapS = THREE.ClampToEdgeWrapping
  lightMap.wrapT = THREE.ClampToEdgeWrapping
  lightMap.needsUpdate = true
}

/* --------------------------------- types --------------------------------- */

type MaterialMode = 'GI only' | 'PBR + baked GI' | 'UV debug' | 'plain white'

type SceneControls = {
  materialMode: MaterialMode
  bakedGiEnabled: boolean
  lightMapIntensity: number
  lightMapChannel: number
  lightMapFlipY: boolean
  lightMapSRGB: boolean
  toneMapping: THREE.ToneMapping
  exposure: number
  materialEnvEnabled: boolean
  reflectionSource: ReflectionSource
  envAsBackground: boolean
  envRotation: number
  envDiffuseScale: number
  wallEnvIntensity: number
  floorEnvIntensity: number
  roofEnvIntensity: number
  woodEnvIntensity: number
  metalEnvIntensity: number
  floorRoughness: number
  wallRoughness: number
  roofRoughness: number
  allFromGlb: boolean
  aoEnabled: boolean
  aoMapIntensity: number
  metalColor: string
  metalRoughness: number
  metalness: number
  normalStrength: number
  background: string
}

type PbrSet = {
  color: THREE.Texture
  normal: THREE.Texture
  roughness?: THREE.Texture
}

type MeshReport = { meshCount: number; uv1Count: number; unmatched: string[] }

/* --------------------------------- room ---------------------------------- */

function BakedRoom({
  controls,
  hdriEnvTex,
  rawExr,
  onReport,
}: {
  controls: SceneControls
  hdriEnvTex: THREE.Texture | null
  rawExr: THREE.Texture | null
  onReport: (r: MeshReport) => void
}) {
  const { gl, scene } = useThree()

  const gltf = useLoader(GLTFLoader, MODEL_URL, (loader) => {
    loader.setDRACOLoader(dracoLoader)
  })

  const [tileLightMap, woodLightMap, tileAo, woodAo] = useLoader(
    THREE.TextureLoader,
    [TILE_LIGHTMAP_URL, WOOD_LIGHTMAP_URL, TILE_AO_URL, WOOD_AO_URL],
  )

  const [
    floorColor,
    floorNormal,
    roofColor,
    roofNormal,
    roofRoughness,
    wallColor,
    wallNormal,
    wallRoughness,
  ] = useLoader(THREE.TextureLoader, [
    FLOOR_COLOR_URL,
    FLOOR_NORMAL_URL,
    ROOF_COLOR_URL,
    ROOF_NORMAL_URL,
    ROOF_ROUGHNESS_URL,
    WALL_COLOR_URL,
    WALL_NORMAL_URL,
    WALL_ROUGHNESS_URL,
  ])

  const root = useMemo(() => gltf.scene.clone(true), [gltf.scene])

  /* ----------------------- cube capture machinery ----------------------- */

  const cubeCap = useControls('cube capture', {
    cubeResolution: { value: 256, options: { '128': 128, '256': 256, '512': 512 }, label: 'cube resolution' },
    captureOffsetX: { value: 0, min: -10, max: 10, step: 0.1, label: 'capture offset X' },
    captureOffsetY: { value: 0, min: -10, max: 10, step: 0.1, label: 'capture offset Y' },
    captureOffsetZ: { value: 0, min: -10, max: 10, step: 0.1, label: 'capture offset Z' },
    recapture: button(() => captureRef.current?.()),
  })

  const [roomEnvTex, setRoomEnvTex] = useState<THREE.Texture | null>(null)
  const roomEnvTexRef = useRef<THREE.Texture | null>(null)
  const captureRef = useRef<(() => void) | null>(null)
  const offsetRef = useRef({ x: 0, y: 0, z: 0 })
  offsetRef.current = {
    x: cubeCap.captureOffsetX,
    y: cubeCap.captureOffsetY,
    z: cubeCap.captureOffsetZ,
  }

  // cube render target + camera, rebuilt only when resolution changes
  const { cubeRt, cubeCam } = useMemo(() => {
    const rt = new THREE.WebGLCubeRenderTarget(cubeCap.cubeResolution, {
      type: THREE.HalfFloatType,
    })
    const cam = new THREE.CubeCamera(0.1, 1000, rt)
    return { cubeRt: rt, cubeCam: cam }
  }, [cubeCap.cubeResolution])

  useEffect(() => () => cubeRt.dispose(), [cubeRt])
  useEffect(() => () => roomEnvTexRef.current?.dispose(), [])

  // (re)assigned every render so it closes over the latest refs/props
  captureRef.current = () => {
    if (!rawExr) return

    scene.updateMatrixWorld(true)

    const box = new THREE.Box3().setFromObject(root)
    const center = box.getCenter(new THREE.Vector3())
    const { x, y, z } = offsetRef.current
    cubeCam.position.set(center.x + x, center.y + y, center.z + z)
    cubeCam.updateMatrixWorld(true)

    // capture conditions: forest through the opening, no self-reflection
    const prevBg = scene.background
    scene.background = rawExr

    const stash: { m: THREE.MeshStandardMaterial; i: number }[] = []
    root.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial
      if (m && m.isMeshStandardMaterial && m.envMap) {
        stash.push({ m, i: m.envMapIntensity })
        m.envMapIntensity = 0
      }
    })

    cubeCam.update(gl, scene)

    scene.background = prevBg
    for (const s of stash) s.m.envMapIntensity = s.i

    // PMREM the captured cube so rough surfaces blur correctly
    const pmrem = new THREE.PMREMGenerator(gl)
    const tex = pmrem.fromCubemap(cubeRt.texture).texture
    pmrem.dispose()

    roomEnvTexRef.current?.dispose()
    roomEnvTexRef.current = tex
    setRoomEnvTex(tex)
  }

  // the active reflection texture, by source
  const activeEnvTex =
    controls.reflectionSource === 'hdri'
      ? hdriEnvTex
      : controls.reflectionSource === 'room cubemap'
        ? roomEnvTex
        : null

  /* ----------------------- live env-diffuse scale ----------------------- */

  const envScaleUniforms = useRef<{ value: number }[]>([])
  const scaleRef = useRef(controls.envDiffuseScale)

  useEffect(() => {
    scaleRef.current = controls.envDiffuseScale
    for (const u of envScaleUniforms.current) u.value = controls.envDiffuseScale
  }, [controls.envDiffuseScale])

  const floorSet = useMemo<PbrSet>(
    () => ({ color: floorColor, normal: floorNormal }),
    [floorColor, floorNormal],
  )
  const roofSet = useMemo<PbrSet>(
    () => ({ color: roofColor, normal: roofNormal, roughness: roofRoughness }),
    [roofColor, roofNormal, roofRoughness],
  )
  const wallSet = useMemo<PbrSet>(
    () => ({ color: wallColor, normal: wallNormal, roughness: wallRoughness }),
    [wallColor, wallNormal, wallRoughness],
  )

  /* configure both lightmaps */
  useEffect(() => {
    const cs = controls.lightMapSRGB ? THREE.SRGBColorSpace : THREE.NoColorSpace
    configureLightMap(tileLightMap, controls.lightMapChannel, controls.lightMapFlipY, cs)
    configureLightMap(woodLightMap, controls.lightMapChannel, controls.lightMapFlipY, cs)

    for (const ao of [tileAo, woodAo]) {
      ao.flipY = controls.lightMapFlipY
      ao.channel = controls.lightMapChannel
      ao.colorSpace = THREE.NoColorSpace
      ao.wrapS = THREE.ClampToEdgeWrapping
      ao.wrapT = THREE.ClampToEdgeWrapping
      ao.needsUpdate = true
    }
  }, [
    tileLightMap,
    woodLightMap,
    tileAo,
    woodAo,
    controls.lightMapChannel,
    controls.lightMapFlipY,
    controls.lightMapSRGB,
  ])

  /* configure the PBR textures (no code tiling; uses Blender UVs) */
  useEffect(() => {
    configurePbrTexture(floorColor, THREE.SRGBColorSpace)
    configurePbrTexture(floorNormal, THREE.NoColorSpace)
    configurePbrTexture(roofColor, THREE.SRGBColorSpace)
    configurePbrTexture(roofNormal, THREE.NoColorSpace)
    configurePbrTexture(roofRoughness, THREE.NoColorSpace)
    configurePbrTexture(wallColor, THREE.SRGBColorSpace)
    configurePbrTexture(wallNormal, THREE.NoColorSpace)
    configurePbrTexture(wallRoughness, THREE.NoColorSpace)
  }, [
    floorColor, floorNormal,
    roofColor, roofNormal, roofRoughness,
    wallColor, wallNormal, wallRoughness,
  ])

  /* build materials, routing lightmap + textures + reflection env per mesh.
     Defined BEFORE the capture effect so on first mount the room exists and is
     lightmap-lit (envMap still null) before the cube camera photographs it. */
  useEffect(() => {
    const created: THREE.Material[] = []
    let meshCount = 0
    let uv1Count = 0
    const unmatched: string[] = []

    envScaleUniforms.current = []
    const collect = (u: { value: number }) => envScaleUniforms.current.push(u)

    const gi = controls.bakedGiEnabled
    const intensity = controls.lightMapIntensity
    const applyLm = (m: THREE.MeshStandardMaterial, lm: THREE.Texture) => {
      m.lightMap = gi ? lm : null
      m.lightMapIntensity = gi ? intensity : 0
      return m
    }

    const makeGiOnly = (lm: THREE.Texture) =>
      applyLm(
        new THREE.MeshStandardMaterial({
          color: '#ffffff', roughness: 1, metalness: 0, side: THREE.FrontSide,
        }),
        lm,
      )

    const makePbr = (set: PbrSet, roughness: number, lm: THREE.Texture) => {
      const m = new THREE.MeshStandardMaterial({
        color: '#ffffff',
        map: set.color,
        normalMap: set.normal,
        roughnessMap: set.roughness ?? null,
        roughness, metalness: 0, side: THREE.FrontSide,
      })
      m.normalScale.set(controls.normalStrength, controls.normalStrength)
      return applyLm(m, lm)
    }

    const fromGlb = (orig: THREE.Material, lm: THREE.Texture) => {
      const base = (Array.isArray(orig) ? orig[0] : orig) as THREE.Material
      const m = base.clone() as THREE.MeshStandardMaterial
      return applyLm(m, lm)
    }

    const makeMetal = (lm: THREE.Texture) =>
      applyLm(
        new THREE.MeshStandardMaterial({
          color: controls.metalColor,
          roughness: controls.metalRoughness,
          metalness: controls.metalness,
          side: THREE.FrontSide,
        }),
        lm,
      )

    const makeUvDebug = (lm: THREE.Texture) =>
      new THREE.MeshBasicMaterial({ map: lm, side: THREE.FrontSide })

    const makeWhite = () =>
      new THREE.MeshStandardMaterial({
        color: '#ffffff', roughness: 0.9, metalness: 0, side: THREE.FrontSide,
      })

    const envModeActive =
      controls.materialMode === 'PBR + baked GI' &&
      controls.materialEnvEnabled &&
      controls.reflectionSource !== 'none' &&
      !!activeEnvTex

    root.traverse((child) => {
      const mesh = child as THREE.Mesh
      if (!mesh.isMesh) return

      meshCount += 1
      if (mesh.geometry.getAttribute('uv1')) uv1Count += 1

      if (!mesh.userData.bakeOriginal) mesh.userData.bakeOriginal = mesh.material
      const original = mesh.userData.bakeOriginal as THREE.Material

      const { group, lightmap } = classify(mesh.name || '')
      const lm = lightmap === 'wood' ? woodLightMap : tileLightMap
      let material: THREE.Material

      if (controls.materialMode === 'UV debug') {
        material = makeUvDebug(lm)
      } else if (controls.materialMode === 'plain white') {
        material = makeWhite()
      } else if (controls.materialMode === 'GI only') {
        material = makeGiOnly(lm)
      } else if (controls.allFromGlb) {
        material = fromGlb(original, lm)
      } else if (group === 'floor') {
        material = makePbr(floorSet, controls.floorRoughness, lm)
      } else if (group === 'wall') {
        material = makePbr(wallSet, controls.wallRoughness, lm)
      } else if (group === 'roof') {
        material = makePbr(roofSet, controls.roofRoughness, lm)
      } else if (group === 'metal') {
        material = makeMetal(lm)
      } else {
        if (group === 'unknown') unmatched.push(mesh.name || '(unnamed)')
        material = fromGlb(original, lm)
      }

      const std = material as THREE.MeshStandardMaterial

      // per-material reflection env (specular only; diffuse killed in-shader)
      if (std.isMeshStandardMaterial) {
        if (envModeActive) {
          std.envMap = activeEnvTex
          std.envMapIntensity = envIntensityForGroup(group, controls)
          patchEnvDiffuseKill(std, scaleRef.current, collect)
          std.needsUpdate = true
        } else {
          std.envMap = null
        }
      }

      const aoFor = lightmap === 'wood' ? woodAo : tileAo
      if (std.isMeshStandardMaterial && controls.aoEnabled) {
        std.aoMap = aoFor
        std.aoMapIntensity = controls.aoMapIntensity
        std.needsUpdate = true
      }

      mesh.material = material
      created.push(material)
    })

    onReport({ meshCount, uv1Count, unmatched })
    return () => created.forEach((m) => m.dispose())
  }, [
    root, tileLightMap, woodLightMap, floorSet, roofSet, wallSet, onReport,
    controls.materialMode, controls.bakedGiEnabled, controls.lightMapIntensity,
    controls.normalStrength, controls.floorRoughness, controls.roofRoughness,
    controls.wallRoughness, controls.allFromGlb,
    controls.metalColor, controls.metalRoughness, controls.metalness,
    tileAo, woodAo, controls.aoEnabled, controls.aoMapIntensity,
    // reflection (envDiffuseScale excluded: updated live via uniforms)
    activeEnvTex, controls.materialEnvEnabled, controls.reflectionSource,
    controls.wallEnvIntensity, controls.floorEnvIntensity,
    controls.roofEnvIntensity, controls.woodEnvIntensity, controls.metalEnvIntensity,
  ])

  /* one-time room capture: runs after the build effect (so the room is built
     and lightmap-lit). Re-runs when switching to 'room cubemap' or when the EXR
     finishes loading. Manual recapture is the leva button. Offsets do NOT auto-
     recapture (would thrash on slider drag); change them, then hit recapture. */
  useEffect(() => {
    if (controls.reflectionSource !== 'room cubemap') return
    if (!rawExr) return
    captureRef.current?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controls.reflectionSource, rawExr])

  return <primitive object={root} />
}

/* --------------------------------- scene --------------------------------- */

/* Frames the model ONCE on load, then never touches the camera again. */
function FrameOnce() {
  const { camera, scene, controls } = useThree()
  const done = useRef(false)

  useEffect(() => {
    if (done.current) return

    scene.updateMatrixWorld(true)
    const box = new THREE.Box3().setFromObject(scene)
    if (box.isEmpty()) return

    const size = box.getSize(new THREE.Vector3())
    const center = box.getCenter(new THREE.Vector3())
    const maxDim = Math.max(size.x, size.y, size.z) || 1
    const dist = maxDim * 1.4

    camera.position.set(
      center.x + dist * 0.7,
      center.y + dist * 0.5,
      center.z + dist,
    )
    camera.near = Math.max(maxDim / 1000, 0.01)
    camera.far = maxDim * 100
    camera.updateProjectionMatrix()

    const c = controls as unknown as {
      target?: THREE.Vector3
      update?: () => void
    }
    if (c?.target) {
      c.target.copy(center)
      c.update?.()
      done.current = true
    } else {
      camera.lookAt(center)
    }
  }, [camera, scene, controls])

  return null
}

function Scene({
  controls,
  onReport,
}: {
  controls: SceneControls
  onReport: (r: MeshReport) => void
}) {
  const [hdr, setHdr] = useState<{
    reflection: THREE.Texture
    raw: THREE.Texture
  } | null>(null)

  return (
    <>
      <RendererSettings toneMapping={controls.toneMapping} exposure={controls.exposure} />

      <HdrBackgroundAndReflectionMap
        asBackground={controls.envAsBackground}
        rotationDeg={controls.envRotation}
        backgroundColor={controls.background}
        onReady={setHdr}
      />

      <BakedRoom
        controls={controls}
        hdriEnvTex={hdr?.reflection ?? null}
        rawExr={hdr?.raw ?? null}
        onReport={onReport}
      />
      <FrameOnce />

      <OrbitControls makeDefault enablePan enableZoom enableDamping />
    </>
  )
}

/* ------------------------------ diagnostics ------------------------------ */

function Diagnostics({ report }: { report: MeshReport }) {
  const ok = report.meshCount > 0 && report.uv1Count === report.meshCount
  return (
    <div
      style={{
        position: 'fixed', top: 12, left: 12, zIndex: 10, padding: '10px 12px',
        font: '12px/1.4 monospace', color: ok ? '#9be39b' : '#ffcc66',
        background: 'rgba(0,0,0,0.6)', borderRadius: 6, pointerEvents: 'none',
      }}
    >
      <div>meshes: {report.meshCount}</div>
      <div>with uv1: {report.uv1Count}{ok ? '  (all good)' : '  (some missing uv1!)'}</div>
      {report.unmatched.length > 0 ? (
        <div>unmatched: {report.unmatched.slice(0, 6).join(', ')}</div>
      ) : null}
    </div>
  )
}

/* ---------------------------------- app ---------------------------------- */

export default function App() {
  const [report, setReport] = useState<MeshReport>({
    meshCount: 0, uv1Count: 0, unmatched: [],
  })

  const raw = useControls('bake check', {
    materialMode: {
      value: 'PBR + baked GI',
      options: ['GI only', 'PBR + baked GI', 'UV debug', 'plain white'],
      label: 'material mode',
    },
    bakedGiEnabled: { value: true, label: 'baked GI on' },
    lightMapIntensity: { value: 1, min: 0, max: 3, step: 0.05, label: 'lightmap intensity' },
    lightMapChannel: {
      value: 1, options: { 'uv1 / channel 1': 1, 'uv / channel 0': 0 },
      label: 'lightmap channel',
    },
    lightMapFlipY: { value: false, label: 'lightmap flipY' },
    lightMapSRGB: { value: true, label: 'lightmap sRGB (off = linear)' },
    toneMapping: { value: 'None', options: Object.keys(TONE_MAPPING), label: 'tone mapping' },
    exposure: { value: 1, min: 0.1, max: 2, step: 0.01 },

    // reflection-only environment (no scene.environment; diffuse killed in-shader)
    materialEnvEnabled: { value: true, label: 'material env (reflections)' },
    reflectionSource: {
      value: 'room cubemap',
      options: ['hdri', 'room cubemap', 'none'],
      label: 'reflection source',
    },
    envAsBackground: { value: false, label: 'show env as background' },
    envRotation: { value: 0, min: 0, max: 360, step: 1, label: 'env bg rotation (deg)' },
    envDiffuseScale: { value: 0, min: 0, max: 1, step: 0.01, label: 'env diffuse scale (0 = off)' },
    wallEnvIntensity: { value: 0.01, min: 0, max: 1, step: 0.005, label: 'wall env intensity' },
    floorEnvIntensity: { value: 0.01, min: 0, max: 1, step: 0.005, label: 'floor env intensity' },
    roofEnvIntensity: { value: 0.01, min: 0, max: 1, step: 0.005, label: 'roof env intensity' },
    woodEnvIntensity: { value: 0.02, min: 0, max: 1, step: 0.005, label: 'wood env intensity' },
    metalEnvIntensity: { value: 0.3, min: 0, max: 2, step: 0.01, label: 'metal env intensity' },

    floorRoughness: { value: 0.7, min: 0, max: 1, step: 0.01, label: 'floor roughness' },
    wallRoughness: { value: 0.8, min: 0, max: 1, step: 0.01, label: 'wall roughness' },
    roofRoughness: { value: 0.85, min: 0, max: 1, step: 0.01, label: 'roof roughness' },
    allFromGlb: { value: false, label: 'all materials from GLB' },
    aoEnabled: { value: false, label: 'AO map on' },
    aoMapIntensity: { value: 0.5, min: 0, max: 1, step: 0.05, label: 'AO intensity' },
    metalColor: { value: '#8a8a8a', label: 'metal color (placeholder)' },
    metalRoughness: { value: 0.35, min: 0, max: 1, step: 0.01, label: 'metal roughness' },
    metalness: { value: 0.8, min: 0, max: 1, step: 0.01, label: 'metalness' },
    normalStrength: { value: 1, min: 0, max: 2, step: 0.01, label: 'normal strength' },
    background: '#101010',
  })

  const controls: SceneControls = {
    ...(raw as unknown as Omit<SceneControls, 'toneMapping'>),
    toneMapping: TONE_MAPPING[(raw as unknown as { toneMapping: string }).toneMapping],
  }

  return (
    <main style={{ width: '100vw', height: '100vh' }}>
      <Diagnostics report={report} />
      <Canvas dpr={[1, 1.5]} camera={{ position: [5, 3, 6], fov: 42, near: 0.1, far: 50000 }}>
        <Suspense fallback={null}>
          <Scene controls={controls} onReport={setReport} />
        </Suspense>
      </Canvas>
    </main>
  )
}
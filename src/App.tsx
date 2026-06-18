/*
 * App_with_light_probes.tsx
 *
 * Parallax‑corrected cubemap environment mapping for a baked WebGPU room
 * scene, augmented with a dynamic light probe for GI‑like lighting on
 * imported test models. This version of the app builds upon the original
 * implementation and demonstrates how to generate a spherical harmonic
 * light probe from a captured environment cubemap using three.js’s
 * LightProbeGenerator. The resulting probe provides diffuse global
 * illumination on the test models without re‑baking the scene. A Leva
 * control allows adjusting the light probe intensity at runtime, and an
 * optional helper renders a visualisation of the probe’s SH basis.
 */

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Canvas, extend, useFrame, useLoader, useThree } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import { folder, useControls, button } from 'leva'
import * as THREE from 'three/webgpu'
import { Fn, float, lights, min as tslMin, positionWorld, pmremTexture, reflectVector, vec2, vec3, reflector, texture, uv } from 'three/tsl'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js'
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js'
import { LightProbeGenerator } from 'three/addons/lights/LightProbeGenerator.js'
import { LightProbeHelper } from 'three/addons/helpers/LightProbeHelperGPU.js'

extend(THREE as unknown as Record<string, unknown>)

/* ------------------------------ asset paths ------------------------------ */

const MODEL_URL         = '/assets/simple_bake_01.glb'
const TEST_MODELS_URL   = '/assets/test_models.glb'
const REFLECTOR_URL     = '/assets/reflector.glb'
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

/* --------------------------- mesh‑name routing --------------------------- */

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

// Extend the existing SceneControls to include probe configuration
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
  // light probe
  lightProbeIntensity: number
  showProbeHelper:     boolean
  shadowPlaneOpacity?: number
  mirrorOpacity?: number
  reflectorEnabled: boolean
  reflectorStrength: number
  reflectorNormalDistortion: number
  reflectorRoughnessMaskStrength: number
  reflectorYOffset: number
  reflectorTargetRotX: number
  reflectorTargetRotY: number
  reflectorTargetRotZ: number
  reflectorUvFlipX: boolean
  reflectorUvFlipY: boolean
  reflectorUvScaleX: number
  reflectorUvScaleY: number
  reflectorUvOffsetX: number
  reflectorUvOffsetY: number
  reflectorDebugMode: 'reflection' | 'base color' | 'normal map' | 'roughness mask'
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

function TestModels({ controls, modelLight, dirLight, spotLight, lightProbe }: {
  controls: SceneControls
  modelLight: THREE.PointLight | null
  dirLight:   THREE.DirectionalLight | null
  spotLight:  THREE.SpotLight | null
  lightProbe: THREE.LightProbe | null
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
      // Compose the list of lights: model lights, directional, spot, and probe
      const lightList = [
        ...(modelLight ? [modelLight] : []),
        ...(dirLight   ? [dirLight]   : []),
        ...(spotLight  ? [spotLight]  : []),
        ...(lightProbe ? [lightProbe] : []),
      ]
      m.lightsNode = lights(lightList)
      // Use the cubemap environment from BPCEM for specular reflections if enabled
      // Reflection intensity is controlled globally via envNode within Scene
      mesh.material = m
    })
  }, [root, modelLight, dirLight, spotLight, lightProbe])

  return (
    <primitive
      object={root}
      position={[controls.modelX, controls.modelY, controls.modelZ]}
      scale={controls.modelScale}
    />
  )
}

/* --------------------------------- room ---------------------------------- */

function BakedRoom({ controls, forestExr, onReport, roomLight, dirLight, onLightProbe }: {
  controls:  SceneControls
  forestExr: THREE.Texture | null
  onReport:  (r: MeshReport) => void
  roomLight: THREE.PointLight | null
  dirLight:  THREE.DirectionalLight | null
  onLightProbe: (lp: THREE.LightProbe) => void
}) {
  const { gl, scene } = useThree()

  const gltf = useLoader(GLTFLoader, MODEL_URL, (l) => l.setDRACOLoader(dracoLoader))
  const reflectorGltf = useLoader(GLTFLoader, REFLECTOR_URL, (l) => l.setDRACOLoader(dracoLoader))

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
    r.userData.recenterOffset = centre.clone().multiplyScalar(-1)
    r.updateMatrixWorld(true)
    console.info('[room] recentred. original centre:', centre)
    // Table and shelf cast shadows to block the spotlight
    r.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (!mesh.isMesh) return
      mesh.receiveShadow = true
      const n = (mesh.name || '').toLowerCase()
      const isTableSurface = n.includes('table')
      mesh.castShadow = isTableSurface
      if (isTableSurface && mesh.material) {
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
        mats.forEach((m: THREE.Material) => { m.side = THREE.DoubleSide })
      }
    })
    return r
  }, [gltf.scene])

  const shadowPlanes = useMemo(() => {
    const planes: { width: number; depth: number; position: THREE.Vector3 }[] = []
    root.traverse((child) => {
      const mesh = child as THREE.Mesh
      if (!mesh.isMesh) return
      const name = (mesh.name || '').toLowerCase()
      if (name.includes('table')) {
        const box = new THREE.Box3().setFromObject(mesh)
        const size = new THREE.Vector3()
        box.getSize(size)
        const center = new THREE.Vector3()
        box.getCenter(center)
        planes.push({
          width: size.x,
          depth: size.z,
          position: new THREE.Vector3(center.x, box.max.y + 0.01, center.z),
        })
      }
    })
    return planes
  }, [root])


  /* ------------------------------------------------------------------------
   * GLB reflector receiver
   *
   * /assets/reflector.glb is a real plane mesh authored on top of the table.
   * It uses the same UVs as the table. We keep the real table material below,
   * then add this as a WebGPU TSL reflector layer. The wall/table roughness map
   * masks the reflection so rough areas stay diffuse and glossy areas reflect.
   */
  const reflectorRoot = useMemo(() => {
    const r = reflectorGltf.scene.clone(true)
    const recenterOffset = (root.userData.recenterOffset as THREE.Vector3 | undefined) ?? new THREE.Vector3()
    r.position.copy(recenterOffset)
    r.position.y += controls.reflectorYOffset ?? 0.015
    r.updateMatrixWorld(true)

    r.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (!mesh.isMesh) return

      const refl = reflector()

      // The reflector.glb UVs are authored separately from the room GLB.
      // Keep the room PBR texture setup the same as the real table material
      // (flipY = false, channel 0), but allow UV inversion here so the normal
      // and roughness masks can be aligned to the authored reflector mesh.
      const baseUv = uv()
      const u = controls.reflectorUvFlipX ? float(1).sub(baseUv.x) : baseUv.x
      const v = controls.reflectorUvFlipY ? float(1).sub(baseUv.y) : baseUv.y
      const reflectorUv = vec2(
        u.mul(controls.reflectorUvScaleX ?? 1).add(controls.reflectorUvOffsetX ?? 0),
        v.mul(controls.reflectorUvScaleY ?? 1).add(controls.reflectorUvOffsetY ?? 0),
      )

      // Use the table/wall normal map to perturb only the reflected image.
      // Keep the default at 0 while debugging visibility. Increase slowly after
      // the test meshes are clearly visible in the reflection.
      const normalDistortion = controls.reflectorNormalDistortion ?? 0
      if (normalDistortion !== 0) {
        const uvOffset = texture(wallNormal, reflectorUv).xy.mul(2).sub(1).mul(normalDistortion)
        refl.uvNode = refl.uvNode.add(uvOffset)
      }

      // Roughness map as mask. The previous full inverse roughness mask could
      // make the reflection almost invisible if the roughness texture was bright.
      // This version keeps the table texture underneath, but only attenuates the
      // reflector by a controllable amount:
      //   mask strength 0.0 = full reflection everywhere
      //   mask strength 1.0 = strict inverse roughness mask
      const roughnessSample = texture(wallRoughness, reflectorUv).r
      const maskStrength = controls.reflectorRoughnessMaskStrength ?? 0.5
      const glossMask = float(1).sub(roughnessSample.mul(maskStrength))
      const reflectionNode = refl.mul(glossMask.mul(controls.reflectorStrength ?? 2.5))
      const debugMode = controls.reflectorDebugMode ?? 'reflection'
      const colorNode =
        debugMode === 'base color' ? texture(wallColor, reflectorUv).rgb :
        debugMode === 'normal map' ? texture(wallNormal, reflectorUv).rgb :
        debugMode === 'roughness mask' ? vec3(glossMask, glossMask, glossMask) :
        reflectionNode

      const mat = new THREE.MeshPhongNodeMaterial({ colorNode })
      mat.name = 'TSL_Reflector_GLB_UV_Debug_Fix'
      mat.transparent = true
      mat.opacity = controls.reflectionsEnabled && controls.reflectorEnabled ? (controls.mirrorOpacity ?? 1) : 0
      mat.blending = THREE.AdditiveBlending
      mat.depthWrite = false
      mat.depthTest = true
      mat.side = THREE.DoubleSide
      mat.needsUpdate = true

      mesh.material = mat
      mesh.castShadow = false
      mesh.receiveShadow = false
      mesh.frustumCulled = false
      mesh.renderOrder = 20

      // Important:
      // The GLB mesh geometry gives us the authored reflector shape and UVs,
      // but the reflector() node uses refl.target's WORLD TRANSFORM to define
      // the mirror plane. A GLB plane can be horizontally modelled in its
      // vertices while the object transform itself stays identity. In that
      // case, blindly doing mesh.add(refl.target) makes the mirror camera use
      // the wrong plane orientation.
      //
      // reflector() targets behave like a local XY mirror plane with a +Z
      // normal. For a horizontal tabletop in XZ with +Y normal, the target
      // usually needs X = -90 degrees. The Leva controls below let you correct
      // this without rebaking/exporting the GLB.
      const target = refl.target as THREE.Object3D
      target.position.set(0, 0, 0)
      target.rotation.set(
        THREE.MathUtils.degToRad(controls.reflectorTargetRotX ?? -90),
        THREE.MathUtils.degToRad(controls.reflectorTargetRotY ?? 0),
        THREE.MathUtils.degToRad(controls.reflectorTargetRotZ ?? 0),
      )
      target.updateMatrixWorld(true)
      mesh.add(target)
    })

    return r
  }, [
    reflectorGltf.scene, root, wallColor, wallNormal, wallRoughness,
    controls.reflectionsEnabled, controls.reflectorEnabled,
    controls.reflectorStrength, controls.reflectorNormalDistortion, controls.reflectorRoughnessMaskStrength, controls.reflectorYOffset,
    controls.reflectorTargetRotX, controls.reflectorTargetRotY, controls.reflectorTargetRotZ,
    controls.reflectorUvFlipX, controls.reflectorUvFlipY, controls.reflectorUvScaleX, controls.reflectorUvScaleY,
    controls.reflectorUvOffsetX, controls.reflectorUvOffsetY, controls.reflectorDebugMode,
  ])

  /* cube render target — static, captured once */
  const capControls = useControls('cube capture', {
    cubeResolution: { value: 512, options: { '256': 256, '512': 512, '1024': 1024 }, label: 'resolution' },
    recapture: button(() => { capturedRef.current = false }),
  })
  const cubeRes = (capControls as unknown as { cubeResolution: number }).cubeResolution

  const { cubeRt, cubeCam } = useMemo(() => {
    const rt = new THREE.CubeRenderTarget(cubeRes, { type: THREE.HalfFloatType, format: THREE.RGBAFormat })
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

    // Generate a spherical harmonic light probe from the captured cubemap.
    // The asynchronous helper reads pixel data back from the GPU. The probe
    // contains the averaged ambient lighting which can then be applied to
    // dynamic models. The intensity is set in Scene from controls.
    LightProbeGenerator.fromCubeRenderTarget(gl as unknown as THREE.WebGLRenderer, cubeRt).then((probe) => {
      probe.intensity = controls.lightProbeIntensity
      onLightProbe(probe)
    })

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
        // Selective lighting: room only receives roomLight, not model lights or spotlight
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

  return (
    <>
      <primitive object={root} />
      {shadowPlanes.map((plane, idx) => (
        <mesh
          key={`shadow-plane-${idx}`}
          position={[plane.position.x, plane.position.y, plane.position.z]}
          rotation={[-Math.PI / 2, 0, 0]}
          receiveShadow
        >
          <planeGeometry args={[plane.width, plane.depth]} />
          <shadowMaterial opacity={controls.shadowPlaneOpacity ?? 0.5} />
        </mesh>
      ))}
      {controls.reflectionsEnabled && controls.reflectorEnabled && (
        <primitive object={reflectorRoot} />
      )}
    </>
  )
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
  const [lightProbe,  setLightProbe]  = useState<THREE.LightProbe | null>(null)
  const [probeHelper, setProbeHelper] = useState<THREE.LightProbeHelper | null>(null)
  const { scene } = useThree()
  const exr = useLoader(EXRLoader, FOREST_EXR_URL) as THREE.Texture

  useEffect(() => {
    exr.mapping = THREE.EquirectangularReflectionMapping
    setForestExr(exr)
  }, [exr])

  // Manage the light probe and its helper
  useEffect(() => {
    if (lightProbe) {
      scene.add(lightProbe)
      // Create helper if not existing
      let helper = probeHelper
      if (!helper) {
        helper = new LightProbeHelper(lightProbe, 1)
        helper.visible = controls.showProbeHelper
        scene.add(helper)
        setProbeHelper(helper)
      }
      return () => {
        scene.remove(lightProbe)
        if (helper) {
          scene.remove(helper)
          helper.dispose()
          setProbeHelper(null)
        }
      }
    }
  }, [scene, lightProbe])

  // Update helper visibility and probe intensity when controls change
  useEffect(() => {
    if (lightProbe) {
      lightProbe.intensity = controls.lightProbeIntensity
    }
    if (probeHelper) {
      probeHelper.visible = controls.showProbeHelper
    }
  }, [controls.lightProbeIntensity, controls.showProbeHelper, lightProbe, probeHelper])

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
      <BakedRoom controls={controls} forestExr={forestExr} onReport={onReport} roomLight={roomLight} dirLight={dirLight} onLightProbe={setLightProbe} />
      <Suspense fallback={null}>
        <TestModels controls={controls} modelLight={modelLight} dirLight={dirLight} spotLight={spotLight} lightProbe={lightProbe} />
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

export default function AppWithLightProbes() {
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
      reflectorEnabled:          { value: true, label: 'GLB reflector on' },
      reflectorStrength:         { value: 2.5,  min: 0, max: 12, step: 0.05, label: 'GLB reflector strength' },
      reflectorNormalDistortion: { value: 0.03, min: -0.2, max: 0.2, step: 0.005, label: 'normal distortion' },
      reflectorRoughnessMaskStrength: { value: 0.5, min: 0, max: 1, step: 0.01, label: 'roughness mask' },
      reflectorYOffset:          { value: 0.015, min: -0.2, max: 0.2, step: 0.001, label: 'reflector Y offset' },
      reflectorTargetRotX:      { value: -90, min: -180, max: 180, step: 1, label: 'target rot X' },
      reflectorTargetRotY:      { value: 0,   min: -180, max: 180, step: 1, label: 'target rot Y' },
      reflectorTargetRotZ:      { value: 0,   min: -180, max: 180, step: 1, label: 'target rot Z' },
      reflectorUvFlipX:       { value: false, label: 'reflector UV flip X' },
      reflectorUvFlipY:       { value: true,  label: 'reflector UV flip Y' },
      reflectorUvScaleX:      { value: 1, min: -4, max: 4, step: 0.01, label: 'reflector UV scale X' },
      reflectorUvScaleY:      { value: 1, min: -4, max: 4, step: 0.01, label: 'reflector UV scale Y' },
      reflectorUvOffsetX:     { value: 0, min: -2, max: 2, step: 0.001, label: 'reflector UV offset X' },
      reflectorUvOffsetY:     { value: 0, min: -2, max: 2, step: 0.001, label: 'reflector UV offset Y' },
      reflectorDebugMode:     { value: 'reflection', options: ['reflection', 'base color', 'normal map', 'roughness mask'], label: 'reflector debug' },
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

    lightProbe: folder({
      lightProbeIntensity: { value: 1, min: 0, max: 2, step: 0.02, label: 'probe intensity' },
      showProbeHelper:     { value: false, label: 'show probe helper' },
    }),
  })

  const rawAny = raw as any
  const controls: SceneControls = {
    ...(raw as unknown as Omit<SceneControls, 'toneMapping' | 'lightProbeIntensity' | 'showProbeHelper'>),
    ...(rawAny.rendering ?? {}),
    ...(rawAny.cubemap ?? {}),
    ...(rawAny.reflections ?? {}),
    ...(rawAny.ao ?? {}),
    ...(rawAny.roughness ?? {}),
    ...(rawAny.testModels ?? {}),
    ...(rawAny.pointLights ?? {}),
    ...(rawAny.spotlight ?? {}),
    toneMapping: TONE_MAPPING[rawAny.toneMapping ?? rawAny.rendering?.toneMapping ?? 'None'],
    lightProbeIntensity: rawAny.lightProbeIntensity ?? rawAny.lightProbe?.lightProbeIntensity ?? 1,
    showProbeHelper: rawAny.showProbeHelper ?? rawAny.lightProbe?.showProbeHelper ?? false,
    reflectorEnabled: rawAny.reflectorEnabled ?? rawAny.reflections?.reflectorEnabled ?? true,
    reflectorStrength: rawAny.reflectorStrength ?? rawAny.reflections?.reflectorStrength ?? 2.5,
    reflectorNormalDistortion: rawAny.reflectorNormalDistortion ?? rawAny.reflections?.reflectorNormalDistortion ?? 0.03,
    reflectorRoughnessMaskStrength: rawAny.reflectorRoughnessMaskStrength ?? rawAny.reflections?.reflectorRoughnessMaskStrength ?? 0.5,
    reflectorYOffset: rawAny.reflectorYOffset ?? rawAny.reflections?.reflectorYOffset ?? 0.015,
    reflectorTargetRotX: rawAny.reflectorTargetRotX ?? rawAny.reflections?.reflectorTargetRotX ?? -90,
    reflectorTargetRotY: rawAny.reflectorTargetRotY ?? rawAny.reflections?.reflectorTargetRotY ?? 0,
    reflectorTargetRotZ: rawAny.reflectorTargetRotZ ?? rawAny.reflections?.reflectorTargetRotZ ?? 0,
    reflectorUvFlipX: rawAny.reflectorUvFlipX ?? rawAny.reflections?.reflectorUvFlipX ?? false,
    reflectorUvFlipY: rawAny.reflectorUvFlipY ?? rawAny.reflections?.reflectorUvFlipY ?? true,
    reflectorUvScaleX: rawAny.reflectorUvScaleX ?? rawAny.reflections?.reflectorUvScaleX ?? 1,
    reflectorUvScaleY: rawAny.reflectorUvScaleY ?? rawAny.reflections?.reflectorUvScaleY ?? 1,
    reflectorUvOffsetX: rawAny.reflectorUvOffsetX ?? rawAny.reflections?.reflectorUvOffsetX ?? 0,
    reflectorUvOffsetY: rawAny.reflectorUvOffsetY ?? rawAny.reflections?.reflectorUvOffsetY ?? 0,
    reflectorDebugMode: rawAny.reflectorDebugMode ?? rawAny.reflections?.reflectorDebugMode ?? 'reflection',
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
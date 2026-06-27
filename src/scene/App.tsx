/**
 * TEMP App.tsx
 *
 * Single-file diagnostic scene for checking:
 *   - GLB mesh names
 *   - uv1 availability
 *   - lightmap assignment
 *   - AO assignment
 *   - concrete PBR assignment
 *
 * This file does not depend on config.ts, lib.ts, Scene.tsx, or BakedRoom.tsx.
 */
import { Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import { Canvas, extend, useLoader, useThree } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import { useControls } from 'leva'
import * as THREE from 'three/webgpu'
import { float, lights, texture } from 'three/tsl'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js'

extend(THREE as unknown as Record<string, unknown>)

/* -------------------------------------------------------------------------- */
/* ASSET PATHS                                                                */
/* -------------------------------------------------------------------------- */

const MODEL_URL = '/assets/lightmaps.glb'

const LM_BG_URL = '/assets/LM_Bake_bg.png'
const LM_FLOOR_URL = '/assets/LM_Bake_floor.png'
const LM_ROOF_URL = '/assets/LM_Bake_roof.png'

const AO_BG_URL = '/assets/AO_floor.png'
const AO_FLOOR_URL = '/assets/AO_floor.png'
const AO_ROOF_URL = '/assets/AO_roof.png'

const CONCRETE_COLOR_URL = '/pbr/concrete/ConcreteClean01_Base_Color1K.jpg'
const CONCRETE_NORMAL_URL = '/pbr/concrete/ConcreteClean01_NormalGL1K.png'
const CONCRETE_ROUGHNESS_PACKED_URL = '/pbr/concrete/ConcreteClean01_PBRset1K.png'

/* -------------------------------------------------------------------------- */
/* DRACO                                                                      */
/* -------------------------------------------------------------------------- */

const dracoLoader = new DRACOLoader()
dracoLoader.setDecoderPath('/draco/')
dracoLoader.setDecoderConfig({ type: 'wasm' })

/* -------------------------------------------------------------------------- */
/* TYPES                                                                      */
/* -------------------------------------------------------------------------- */

type GroupName = 'bg' | 'floor' | 'roof' | 'unknown'

type MeshReport = {
  meshCount: number
  uv0Count: number
  uv1Count: number
  names: string[]
  unmatched: string[]
}

type MaterialMode =
  | 'PBR + baked GI'
  | 'Lightmap debug'
  | 'AO debug'
  | 'Group color debug'
  | 'UV0 checker'

/* -------------------------------------------------------------------------- */
/* CLASSIFY EXACT CURRENT MESH NAMES                                          */
/* -------------------------------------------------------------------------- */

function classify(name: string): GroupName {
  const n = name.toLowerCase()

  if (n === 'columns') return 'bg'
  if (n === 'corridors') return 'bg'

  if (n === 'coffer_slab001') return 'roof'
  if (n === 'light_well_cross001') return 'roof'
  if (n === 'roof_walls003') return 'roof'

  if (n === 'floor002') return 'floor'
  if (n === 'platform001') return 'floor'

  return 'unknown'
}

/* -------------------------------------------------------------------------- */
/* TEXTURE CONFIG                                                             */
/* -------------------------------------------------------------------------- */

function configureLightMap(t: THREE.Texture, channel: number, flipY: boolean, srgb: boolean) {
  t.flipY = flipY
  t.channel = channel
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace
  t.wrapS = THREE.ClampToEdgeWrapping
  t.wrapT = THREE.ClampToEdgeWrapping
  t.needsUpdate = true
}

function configureAoMap(t: THREE.Texture, channel: number, flipY: boolean) {
  t.flipY = flipY
  t.channel = channel
  t.colorSpace = THREE.NoColorSpace
  t.wrapS = THREE.ClampToEdgeWrapping
  t.wrapT = THREE.ClampToEdgeWrapping
  t.needsUpdate = true
}

function configurePbrTexture(t: THREE.Texture, colorSpace: THREE.ColorSpace) {
  t.flipY = false
  t.channel = 0
  t.colorSpace = colorSpace
  t.wrapS = THREE.RepeatWrapping
  t.wrapT = THREE.RepeatWrapping
  t.anisotropy = 8
  t.needsUpdate = true
}

/* -------------------------------------------------------------------------- */
/* HELPERS                                                                    */
/* -------------------------------------------------------------------------- */

function groupLightMap(group: GroupName, maps: Record<'bg' | 'floor' | 'roof', THREE.Texture>) {
  if (group === 'floor') return maps.floor
  if (group === 'roof') return maps.roof
  return maps.bg
}

function groupAoMap(group: GroupName, maps: Record<'bg' | 'floor' | 'roof', THREE.Texture>) {
  if (group === 'floor') return maps.floor
  if (group === 'roof') return maps.roof
  return maps.bg
}

function groupDebugColor(group: GroupName) {
  if (group === 'bg') return '#3b82f6'
  if (group === 'floor') return '#22c55e'
  if (group === 'roof') return '#f97316'
  return '#ff00ff'
}

function makeCheckerTexture() {
  const size = 512
  const cells = 16
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size

  const ctx = canvas.getContext('2d')!
  const cell = size / cells

  for (let y = 0; y < cells; y++) {
    for (let x = 0; x < cells; x++) {
      ctx.fillStyle = (x + y) % 2 === 0 ? '#ffffff' : '#111111'
      ctx.fillRect(x * cell, y * cell, cell, cell)
    }
  }

  ctx.fillStyle = '#ff0033'
  ctx.font = 'bold 48px monospace'
  ctx.fillText('UV0', 24, 64)

  const tex = new THREE.CanvasTexture(canvas)
  tex.flipY = false
  tex.colorSpace = THREE.SRGBColorSpace
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.RepeatWrapping
  tex.needsUpdate = true

  return tex
}

/* -------------------------------------------------------------------------- */
/* RENDERER SETTINGS                                                          */
/* -------------------------------------------------------------------------- */

function RendererSettings({ toneMapping, exposure, fov }: {
  toneMapping: string
  exposure: number
  fov: number
}) {
  const { gl, camera, scene } = useThree()

  useEffect(() => {
    const renderer = gl as unknown as THREE.WebGPURenderer

    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.toneMapping =
      toneMapping === 'ACES' ? THREE.ACESFilmicToneMapping :
      toneMapping === 'Neutral' ? THREE.NeutralToneMapping :
      toneMapping === 'AgX' ? THREE.AgXToneMapping :
      toneMapping === 'Linear' ? THREE.LinearToneMapping :
      THREE.NoToneMapping

    renderer.toneMappingExposure = exposure

    scene.environment = null
    scene.background = new THREE.Color('#000000')
  }, [gl, scene, toneMapping, exposure])

  useEffect(() => {
    const cam = camera as THREE.PerspectiveCamera
    cam.fov = fov
    cam.near = 0.5
    cam.far = 5000
    cam.updateProjectionMatrix()
  }, [camera, fov])

  return null
}

/* -------------------------------------------------------------------------- */
/* CAMERA                                                                     */
/* -------------------------------------------------------------------------- */

function CameraFrame() {
  const { camera, controls } = useThree()

  useEffect(() => {
    camera.position.set(80, 40, 120)
    camera.lookAt(0, 0, 0)

    const c = controls as unknown as {
      target?: THREE.Vector3
      update?: () => void
      enableDamping?: boolean
      dampingFactor?: number
      minDistance?: number
      maxDistance?: number
    }

    if (c?.target) {
      c.target.set(0, 0, 0)
      c.enableDamping = true
      c.dampingFactor = 0.08
      c.minDistance = 5
      c.maxDistance = 800
      c.update?.()
    }
  }, [camera, controls])

  return null
}

/* -------------------------------------------------------------------------- */
/* TEMP BAKED ROOM                                                            */
/* -------------------------------------------------------------------------- */

function TempBakedRoom({ onReport }: {
  onReport: (r: MeshReport) => void
}) {
  const controls = useControls('TEMP lightmap debug', {
    materialMode: {
      value: 'PBR + baked GI' as MaterialMode,
      options: ['PBR + baked GI', 'Lightmap debug', 'AO debug', 'Group color debug', 'UV0 checker'] as MaterialMode[],
    },

    lightMapIntensity: { value: 1, min: 0, max: 4, step: 0.05 },
    lightMapChannel: {
      value: 1,
      options: {
        'uv1 / lightmap channel 1': 1,
        'uv0 / material channel 0': 0,
      },
    },
    lightMapFlipY: { value: false },
    lightMapSRGB: { value: true },

    aoEnabled: { value: true },
    aoIntensity: { value: 1, min: 0, max: 3, step: 0.05 },

    baseColorEnabled: { value: true },
    normalEnabled: { value: true },
    roughnessEnabled: { value: true },

    concreteRepeat: { value: 1, min: 0.1, max: 20, step: 0.1 },

    floorRoughness: { value: 0.72, min: 0, max: 1, step: 0.01 },
    wallRoughness: { value: 0.78, min: 0, max: 1, step: 0.01 },
    roofRoughness: { value: 0.82, min: 0, max: 1, step: 0.01 },

    floorNormal: { value: 0.55, min: 0, max: 2, step: 0.01 },
    wallNormal: { value: 0.45, min: 0, max: 2, step: 0.01 },
    roofNormal: { value: 0.55, min: 0, max: 2, step: 0.01 },
  })

  const gltf = useLoader(GLTFLoader, MODEL_URL, (loader) => {
    loader.setDRACOLoader(dracoLoader)
  })

  const [
    lmBg,
    lmFloor,
    lmRoof,
    aoBg,
    aoFloor,
    aoRoof,
    concreteColor,
    concreteNormal,
    concreteRoughnessPacked,
  ] = useLoader(THREE.TextureLoader, [
    LM_BG_URL,
    LM_FLOOR_URL,
    LM_ROOF_URL,
    AO_BG_URL,
    AO_FLOOR_URL,
    AO_ROOF_URL,
    CONCRETE_COLOR_URL,
    CONCRETE_NORMAL_URL,
    CONCRETE_ROUGHNESS_PACKED_URL,
  ])

  const checker = useMemo(() => makeCheckerTexture(), [])

  const root = useMemo(() => {
    const r = gltf.scene.clone(true)
    r.updateMatrixWorld(true)

    const box = new THREE.Box3().setFromObject(r)
    const center = box.getCenter(new THREE.Vector3())

    r.position.sub(center)
    r.updateMatrixWorld(true)

    r.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (!mesh.isMesh) return
      mesh.castShadow = false
      mesh.receiveShadow = false
      mesh.frustumCulled = false
    })

    return r
  }, [gltf.scene])

  useEffect(() => {
    const srgb = controls.lightMapSRGB

    configureLightMap(lmBg, controls.lightMapChannel, controls.lightMapFlipY, srgb)
    configureLightMap(lmFloor, controls.lightMapChannel, controls.lightMapFlipY, srgb)
    configureLightMap(lmRoof, controls.lightMapChannel, controls.lightMapFlipY, srgb)

    configureAoMap(aoBg, controls.lightMapChannel, controls.lightMapFlipY)
    configureAoMap(aoFloor, controls.lightMapChannel, controls.lightMapFlipY)
    configureAoMap(aoRoof, controls.lightMapChannel, controls.lightMapFlipY)

    configurePbrTexture(concreteColor, THREE.SRGBColorSpace)
    configurePbrTexture(concreteNormal, THREE.NoColorSpace)
    configurePbrTexture(concreteRoughnessPacked, THREE.NoColorSpace)

    concreteColor.repeat.set(controls.concreteRepeat, controls.concreteRepeat)
    concreteNormal.repeat.set(controls.concreteRepeat, controls.concreteRepeat)
    concreteRoughnessPacked.repeat.set(controls.concreteRepeat, controls.concreteRepeat)
  }, [
    controls.lightMapChannel,
    controls.lightMapFlipY,
    controls.lightMapSRGB,
    controls.concreteRepeat,
    lmBg,
    lmFloor,
    lmRoof,
    aoBg,
    aoFloor,
    aoRoof,
    concreteColor,
    concreteNormal,
    concreteRoughnessPacked,
  ])

  useEffect(() => {
    let meshCount = 0
    let uv0Count = 0
    let uv1Count = 0
    const names: string[] = []
    const unmatched: string[] = []

    const lightMaps = {
      bg: lmBg,
      floor: lmFloor,
      roof: lmRoof,
    }

    const aoMaps = {
      bg: aoBg,
      floor: aoFloor,
      roof: aoRoof,
    }

    root.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (!mesh.isMesh) return

      meshCount++

      const name = mesh.name || '(unnamed)'
      names.push(name)

      const group = classify(name)
      if (group === 'unknown') unmatched.push(name)

      const hasUv0 = Boolean(mesh.geometry.getAttribute('uv'))
      const hasUv1 = Boolean(mesh.geometry.getAttribute('uv1'))

      if (hasUv0) uv0Count++
      if (hasUv1) uv1Count++

      const lm = groupLightMap(group, lightMaps)
      const ao = groupAoMap(group, aoMaps)

      let material: THREE.Material

      if (controls.materialMode === 'Lightmap debug') {
        material = new THREE.MeshBasicNodeMaterial({
          map: lm,
          side: THREE.DoubleSide,
        })
      } else if (controls.materialMode === 'AO debug') {
        material = new THREE.MeshBasicNodeMaterial({
          map: ao,
          side: THREE.DoubleSide,
        })
      } else if (controls.materialMode === 'Group color debug') {
        material = new THREE.MeshBasicNodeMaterial({
          color: groupDebugColor(group),
          side: THREE.DoubleSide,
        })
      } else if (controls.materialMode === 'UV0 checker') {
        material = new THREE.MeshBasicNodeMaterial({
          map: checker,
          side: THREE.DoubleSide,
        })
      } else {
        const roughness =
          group === 'floor' ? controls.floorRoughness :
          group === 'roof' ? controls.roofRoughness :
          controls.wallRoughness

        const normalScale =
          group === 'floor' ? controls.floorNormal :
          group === 'roof' ? controls.roofNormal :
          controls.wallNormal

        const mat = new THREE.MeshStandardNodeMaterial({
          color: '#ffffff',
          map: controls.baseColorEnabled ? concreteColor : null,
          normalMap: controls.normalEnabled ? concreteNormal : null,
          roughness,
          metalness: 0,
          side: THREE.DoubleSide,
        })

        // Your Blender material uses BLUE from the packed PBR texture as roughness.
        if (controls.roughnessEnabled) {
          mat.roughnessNode = texture(concreteRoughnessPacked).b.mul(float(roughness)).saturate()
        }

        mat.normalScale.set(normalScale, normalScale)

        mat.lightMap = lm
        mat.lightMapIntensity = controls.lightMapIntensity

        mat.aoMap = controls.aoEnabled ? ao : null
        mat.aoMapIntensity = controls.aoIntensity

        mat.envMap = null
        mat.envNode = null
        mat.envMapIntensity = 0

        // Room is fully baked. No realtime lights.
        mat.lightsNode = lights([])

        mat.needsUpdate = true
        material = mat
      }

      mesh.material = material
    })

    console.table(names.map((name) => {
      const group = classify(name)
      return {
        name,
        group,
        lightmap:
          group === 'floor' ? 'LM_Bake_floor.png' :
          group === 'roof' ? 'LM_Bake_roof.png' :
          group === 'bg' ? 'LM_Bake_bg.png' :
          'UNKNOWN uses BG fallback',
        uv0: Boolean((root.getObjectByName(name) as THREE.Mesh | undefined)?.geometry?.getAttribute('uv')),
        uv1: Boolean((root.getObjectByName(name) as THREE.Mesh | undefined)?.geometry?.getAttribute('uv1')),
      }
    }))

    onReport({ meshCount, uv0Count, uv1Count, names, unmatched })
  }, [
    root,
    controls.materialMode,
    controls.lightMapIntensity,
    controls.aoEnabled,
    controls.aoIntensity,
    controls.baseColorEnabled,
    controls.normalEnabled,
    controls.roughnessEnabled,
    controls.floorRoughness,
    controls.wallRoughness,
    controls.roofRoughness,
    controls.floorNormal,
    controls.wallNormal,
    controls.roofNormal,
    lmBg,
    lmFloor,
    lmRoof,
    aoBg,
    aoFloor,
    aoRoof,
    concreteColor,
    concreteNormal,
    concreteRoughnessPacked,
    checker,
    onReport,
  ])

  return <primitive object={root} />
}

/* -------------------------------------------------------------------------- */
/* DIAGNOSTICS                                                                */
/* -------------------------------------------------------------------------- */

function Diagnostics({ report }: { report: MeshReport }) {
  const ok = report.meshCount > 0 && report.uv1Count === report.meshCount

  return (
    <div style={{
      position: 'fixed',
      top: 12,
      left: 12,
      zIndex: 10,
      padding: '10px 12px',
      font: '12px/1.4 monospace',
      color: ok ? '#9be39b' : '#ffcc66',
      background: 'rgba(0,0,0,0.72)',
      borderRadius: 6,
      pointerEvents: 'none',
      maxWidth: 520,
    }}>
      <div>meshes: {report.meshCount}</div>
      <div>with uv0: {report.uv0Count}</div>
      <div>with uv1: {report.uv1Count}{ok ? '  (all good)' : '  (some missing uv1!)'}</div>

      {report.unmatched.length > 0 && (
        <div style={{ marginTop: 6, color: '#ff66cc' }}>
          unmatched: {report.unmatched.join(', ')}
        </div>
      )}

      {report.names.length > 0 && (
        <div style={{ marginTop: 6 }}>
          names: {report.names.join(', ')}
        </div>
      )}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* APP                                                                        */
/* -------------------------------------------------------------------------- */

export default function App() {
  const [report, setReport] = useState<MeshReport>({
    meshCount: 0,
    uv0Count: 0,
    uv1Count: 0,
    names: [],
    unmatched: [],
  })

  const renderControls = useControls('TEMP renderer', {
    toneMapping: {
      value: 'None',
      options: ['None', 'Linear', 'ACES', 'AgX', 'Neutral'],
    },
    exposure: { value: 1, min: 0.1, max: 3, step: 0.01 },
    fov: { value: 24, min: 10, max: 90, step: 1 },
  })

  const createRenderer = useCallback(async (props: Record<string, unknown>) => {
    const renderer = new THREE.WebGPURenderer({ ...props, antialias: true } as any)
    await renderer.init()
    return renderer as any
  }, [])

  return (
    <main style={{ width: '100vw', height: '100vh', background: '#000' }}>
      <Diagnostics report={report} />

      <Canvas
        gl={createRenderer}
        dpr={[1, 1.5]}
        camera={{ position: [80, 40, 120], fov: 24, near: 0.5, far: 5000 }}
      >
        <Suspense fallback={null}>
          <RendererSettings
            toneMapping={renderControls.toneMapping}
            exposure={renderControls.exposure}
            fov={renderControls.fov}
          />

          <TempBakedRoom onReport={setReport} />

          <CameraFrame />
          <OrbitControls makeDefault enablePan enableZoom enableDamping dampingFactor={0.08} />
        </Suspense>
      </Canvas>
    </main>
  )
}

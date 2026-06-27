/**
 * Scene.tsx
 * Assembles renderer settings, lights, room, models, light probe, camera.
 */
import { Suspense, useEffect, useState } from 'react'
import { useLoader, useThree } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import * as THREE from 'three/webgpu'
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js'
import { LightProbeHelper } from 'three/addons/helpers/LightProbeHelperGPU.js'
import { SceneLights } from './SceneLights'
import { BakedRoom } from './BakedRoom'
import { TestModels } from './TestModels'
import { Window } from './Window'
import { makeBpcemEnvNode } from '../lib'
import { FOREST_EXR_URL, SKYBOX_ROTATION_Y_RAD } from '../config'
import type { MeshReport, SceneControls } from '../config'

/* renderer + camera fov */
function RendererSettings({ toneMapping, exposure, fov }: {
  toneMapping: THREE.ToneMapping; exposure: number; fov: number
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

/* fixed camera frame + orbit pivot at origin */
function FrameOnce() {
  const { camera, controls } = useThree()
  useEffect(() => {
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
      c.enableDamping = true; c.dampingFactor = 0.08
      c.minDistance = 5; c.maxDistance = 800
      c.update?.()
    } else camera.lookAt(0, 0, 0)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera, controls])
  return null
}

export function Scene({ controls, onReport }: { controls: SceneControls; onReport: (r: MeshReport) => void }) {
  const { scene } = useThree()
  const [forestExr,   setForestExr]   = useState<THREE.Texture | null>(null)
  const [dirLight,    setDirLight]    = useState<THREE.DirectionalLight | null>(null)
  const [spotLight,   setSpotLight]   = useState<THREE.SpotLight | null>(null)
  const [lightProbe,  setLightProbe]  = useState<THREE.LightProbe | null>(null)
  const [probeHelper, setProbeHelper] = useState<LightProbeHelper | null>(null)
  const [envNode,         setEnvNode]         = useState<ReturnType<typeof makeBpcemEnvNode> | null>(null)
  const [recenterOffset,  setRecenterOffset]  = useState<THREE.Vector3 | null>(null)

  const exr = useLoader(EXRLoader, FOREST_EXR_URL) as THREE.Texture
  useEffect(() => {
    exr.mapping = THREE.EquirectangularReflectionMapping
    setForestExr(exr)
  }, [exr])

  /* forest is always the background */
  useEffect(() => {
    scene.environment = null
    scene.background  = forestExr ?? new THREE.Color('#101010')
    scene.backgroundRotation.set(0, SKYBOX_ROTATION_Y_RAD, 0)
  }, [scene, forestExr])

  /* light probe + helper lifecycle */
  useEffect(() => {
    if (!lightProbe) return
    scene.add(lightProbe)
    const helper = new LightProbeHelper(lightProbe, 1)
    helper.visible = controls.showProbeHelper
    scene.add(helper)
    setProbeHelper(helper)
    return () => {
      scene.remove(lightProbe); scene.remove(helper)
      helper.dispose(); setProbeHelper(null)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene, lightProbe])

  useEffect(() => {
    if (lightProbe) lightProbe.intensity = controls.lightProbeIntensity
    if (probeHelper) probeHelper.visible = controls.showProbeHelper
  }, [controls.lightProbeIntensity, controls.showProbeHelper, lightProbe, probeHelper])

  return (
    <>
      <RendererSettings toneMapping={controls.toneMapping} exposure={controls.exposure} fov={controls.cameraFov} />
      <SceneLights
        onDirLight={setDirLight} onSpotLight={setSpotLight} controls={controls}
      />
      <BakedRoom
        controls={controls} forestExr={forestExr} onReport={onReport}
        onLightProbe={setLightProbe} onEnvNode={setEnvNode}
        onRecenterOffset={setRecenterOffset}
      />
      <Suspense fallback={null}>
        <TestModels
          controls={controls} dirLight={dirLight}
          spotLight={spotLight} lightProbe={lightProbe}
        />
        <Window envNode={envNode} recenterOffset={recenterOffset} />
      </Suspense>
      <FrameOnce />
      <OrbitControls makeDefault enablePan enableZoom enableDamping dampingFactor={0.08} />
    </>
  )
}
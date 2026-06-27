/**
 * Scene.tsx
 * Assembles renderer settings, baked room, and camera.
 *
 * Current direction:
 *   - black-background baked scene
 *   - no EXR background
 *   - no BPCEM env node
 *   - no light probe
 *   - no window reflection layer
 *   - test models remain in the repo but are not mounted for now
 */
import { useEffect } from 'react'
import { useThree } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import * as THREE from 'three/webgpu'
import { BakedRoom } from './BakedRoom'
import type { MeshReport, SceneControls } from '../config'

/* renderer + camera fov */
function RendererSettings({ toneMapping, exposure, fov }: {
  toneMapping: THREE.ToneMapping
  exposure: number
  fov: number
}) {
  const { gl, camera } = useThree()

  useEffect(() => {
    const r = gl as unknown as THREE.WebGPURenderer
    r.outputColorSpace = THREE.SRGBColorSpace
    r.toneMapping = toneMapping
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
    camera.far = 2000
    camera.updateProjectionMatrix()

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
    } else {
      camera.lookAt(0, 0, 0)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera, controls])

  return null
}

export function Scene({ controls, onReport }: {
  controls: SceneControls
  onReport: (r: MeshReport) => void
}) {
  const { scene } = useThree()

  /* black portfolio background */
  useEffect(() => {
    scene.environment = null
    scene.background = new THREE.Color('#000000')
  }, [scene])

  return (
    <>
      <RendererSettings
        toneMapping={controls.toneMapping}
        exposure={controls.exposure}
        fov={controls.cameraFov}
      />

      <BakedRoom
        controls={controls}
        onReport={onReport}
      />

      <FrameOnce />
      <OrbitControls makeDefault enablePan enableZoom enableDamping dampingFactor={0.08} />
    </>
  )
}

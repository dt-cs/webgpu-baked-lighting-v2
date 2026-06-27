/**
 * SceneLights.tsx
 * Real-time lights: directional + spotlight only.
 * Selective lighting is enforced in the materials' lightsNode, not here —
 * both lights are added to the scene globally.
 *
 * Shadows: directional + spotlight both cast.
 */
import { useEffect, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three/webgpu'
import type { SceneControls } from '../config'

export function SceneLights({
  onDirLight, onSpotLight, controls,
}: {
  onDirLight:  (l: THREE.DirectionalLight | null) => void
  onSpotLight: (l: THREE.SpotLight | null) => void
  controls: SceneControls
}) {
  const { scene } = useThree()
  const dirRef    = useRef<THREE.DirectionalLight | null>(null)
  const spotRef   = useRef<THREE.SpotLight | null>(null)
  const helperRef = useRef<THREE.SpotLightHelper | null>(null)

  useEffect(() => {
    const dir = new THREE.DirectionalLight(controls.dirLightColor, controls.dirLightIntensity)
    dir.position.set(controls.dirLightX, controls.dirLightY, controls.dirLightZ)
    dir.castShadow = true
    dir.shadow.mapSize.width  = 4096
    dir.shadow.mapSize.height = 4096
    dir.shadow.camera.near   = 1
    dir.shadow.camera.far    = 500
    dir.shadow.camera.left   = -100
    dir.shadow.camera.right  =  100
    dir.shadow.camera.top    =  100
    dir.shadow.camera.bottom = -100
    dir.shadow.bias          = -0.0002
    dir.shadow.normalBias = 0.01

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

    scene.add(dir, spot, helper)
    dirRef.current = dir; spotRef.current = spot; helperRef.current = helper
    onDirLight(dir); onSpotLight(spot)

    return () => {
      scene.remove(dir, spot, helper)
      helper.dispose()
      onDirLight(null); onSpotLight(null)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene])

  useFrame(() => {
    const dir = dirRef.current, spot = spotRef.current, helper = helperRef.current

    if (dir) {
      dir.position.set(controls.dirLightX, controls.dirLightY, controls.dirLightZ)
      dir.color.set(controls.dirLightColor)
      dir.intensity = controls.dirLightIntensity
    }
    if (spot && helper) {
      spot.visible   = controls.spotEnabled
      spot.position.set(controls.spotX, controls.spotY, controls.spotZ)
      spot.color.set(controls.spotColor)
      spot.intensity = controls.spotIntensity
      spot.angle     = controls.spotAngle
      spot.penumbra  = controls.spotPenumbra
      spot.decay     = controls.spotDecay
      spot.distance  = controls.spotDistance
      spot.target.position.set(controls.spotTargetX, controls.spotTargetY, controls.spotTargetZ)
      spot.target.updateMatrixWorld()
      spot.shadow.camera.near = controls.shadowNear
      spot.shadow.camera.far  = controls.shadowFar
      spot.shadow.camera.updateProjectionMatrix()
      spot.shadow.focus       = controls.shadowFocus
      spot.shadow.intensity   = controls.shadowIntensity
      helper.visible = controls.showHelper && controls.spotEnabled
      helper.update()
    }
  })

  return null
}
/**
 * TestModels.tsx
 * Imported portfolio models. White PBR, selective lighting via lightsNode:
 * receives model point light + directional + spot + light probe (GI).
 * Never receives the room point light.
 */
import { useEffect, useMemo } from 'react'
import { useLoader } from '@react-three/fiber'
import * as THREE from 'three/webgpu'
import { lights } from 'three/tsl'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { TEST_MODELS_URL } from '../config'
import type { SceneControls } from '../config'
import { dracoLoader } from '../lib'

export function TestModels({ controls, dirLight, spotLight, lightProbe }: {
  controls:   SceneControls
  dirLight:   THREE.DirectionalLight | null
  spotLight:  THREE.SpotLight | null
  lightProbe: THREE.LightProbe | null
}) {
  const gltf = useLoader(GLTFLoader, TEST_MODELS_URL, (l) => l.setDRACOLoader(dracoLoader))
  const root = useMemo(() => gltf.scene.clone(true), [gltf.scene])

  useEffect(() => {
    const lightList = [
      ...(dirLight   ? [dirLight]   : []),
      ...(spotLight  ? [spotLight]  : []),
      ...(lightProbe ? [lightProbe] : []),
    ]
    root.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (!mesh.isMesh) return
      mesh.castShadow    = true
      mesh.receiveShadow = true
      const m = new THREE.MeshStandardNodeMaterial({
        color: '#f2f2f2', roughness: 0.7, metalness: 0.0, side: THREE.FrontSide,
      })
      m.lightsNode = lights(lightList)
      mesh.material = m
    })
  }, [root, dirLight, spotLight, lightProbe])

  return (
    <primitive
      object={root}
      position={[controls.modelX, controls.modelY, controls.modelZ]}
      scale={controls.modelScale}
    />
  )
}
/**
 * Window.tsx
 * Glass window pane. Reacts ONLY to the room's BPCEM environment reflection —
 * no directional light, no spotlight, no light probe. Achieved via
 * lightsNode = lights([]) (zero real-time lights) combined with envNode set
 * to the same parallax-corrected cubemap node the baked room uses.
 *
 * MeshPhysicalNodeMaterial is used (not MeshStandardNodeMaterial) because
 * glass needs transmission/ior, which only the physical material exposes.
 *
 * Frostiness: a single "frostiness" slider drives MeshPhysicalMaterial's
 * roughness with transmission=1 — this is the standard three.js frosted-glass
 * recipe (clear glass at roughness≈0, frosted/hazy at roughness≈0.4-0.8;
 * roughness=1 makes the surface scatter light completely and disappear, so
 * the slider is capped below 1).
 *
 * Position: window.glb is authored in the same un-recentred space as the
 * room GLB, so it gets the SAME recenterOffset BakedRoom computes (passed
 * down from Scene) to land in the correct spot relative to the room.
 */
import { useEffect, useMemo } from 'react'
import { useLoader } from '@react-three/fiber'
import { useControls, folder } from 'leva'
import * as THREE from 'three/webgpu'
import { lights } from 'three/tsl'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { WINDOW_URL } from '../config'
import { dracoLoader, makeBpcemEnvNode } from '../lib'

type EnvNode = ReturnType<typeof makeBpcemEnvNode>

export function Window({ envNode, recenterOffset }: {
  envNode:        EnvNode | null
  /** Same offset BakedRoom applies to centre the room at the origin. */
  recenterOffset: THREE.Vector3 | null
}) {
  const gltf = useLoader(GLTFLoader, WINDOW_URL, (l) => l.setDRACOLoader(dracoLoader))
  const root = useMemo(() => gltf.scene.clone(true), [gltf.scene])

  const glass = useControls('window glass', {
    glass: folder({
      frostiness:      { value: 0.15, min: 0, max: 0.95, step: 0.01, label: 'frostiness' },
      transmission:    { value: 1,    min: 0, max: 1,  step: 0.01, label: 'transmission' },
      ior:             { value: 1.5,  min: 1, max: 2.5, step: 0.01, label: 'IOR' },
      thickness:       { value: 0.05, min: 0, max: 5,  step: 0.01, label: 'thickness' },
      envMapIntensity: { value: 1,    min: 0, max: 3,  step: 0.01, label: 'env intensity' },
      color:           { value: '#ffffff', label: 'tint' },
    }),
  }) as {
    frostiness: number; transmission: number; ior: number
    thickness: number; envMapIntensity: number; color: string
  }

  /* apply the room's recenter offset so the window lands in the right spot */
  useEffect(() => {
    if (!recenterOffset) return
    root.position.copy(recenterOffset)
    root.updateMatrixWorld(true)
  }, [root, recenterOffset])

  useEffect(() => {
    if (!envNode) return
    root.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (!mesh.isMesh) return

      const m = new THREE.MeshPhysicalNodeMaterial({
        color: glass.color,
        // frostiness drives roughness directly — the standard frosted-glass
        // recipe is transmission=1 + raised roughness.
        roughness: glass.frostiness,
        metalness: 0,
        transmission: glass.transmission,
        ior: glass.ior,
        thickness: glass.thickness,
        side: THREE.DoubleSide,
        transparent: true,
      })

      // Same parallax-corrected cubemap the room uses — kept exact.
      m.envNode         = envNode
      m.envMapIntensity = glass.envMapIntensity

      // Zero real-time lights: glass reacts to the environment only,
      // never the directional/spotlight rig.
      m.lightsNode = lights([])

      m.needsUpdate = true
      mesh.material = m
      mesh.castShadow    = false
      mesh.receiveShadow = false
    })
  }, [
    root, envNode,
    glass.frostiness, glass.transmission, glass.ior,
    glass.thickness, glass.envMapIntensity, glass.color,
  ])

  return <primitive object={root} />
}
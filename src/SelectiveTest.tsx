/**
 * SelectiveTest.tsx
 * Minimal selective lighting test following webgpu_selective_lights.html exactly.
 * Add <SelectiveTest /> to Scene JSX to test.
 * Expected: left box unlit (dark), right box lit by directional light.
 */
import { useEffect } from 'react'
import { useThree } from '@react-three/fiber'
import * as THREE from 'three/webgpu'
import { lights, color } from 'three/tsl'

export function SelectiveTest() {
  const { scene } = useThree()

  useEffect(() => {
    // One directional light
    const light = new THREE.DirectionalLight('#ffffff', 3)
    light.position.set(5, 10, 5)
    scene.add(light)

    // Left box: lights = false — should be completely unlit
    const matLeft = new THREE.MeshStandardNodeMaterial({ color: '#ffffff' })
    matLeft.lights = false
    const boxLeft = new THREE.Mesh(new THREE.BoxGeometry(4, 4, 4), matLeft)
    boxLeft.position.set(-6, 0, 0)
    scene.add(boxLeft)

    // Right box: lightsNode = lights([light]) — should be lit only by this light
    const matRight = new THREE.MeshStandardNodeMaterial({ color: '#ffffff' })
    matRight.lightsNode = lights([light])
    const boxRight = new THREE.Mesh(new THREE.BoxGeometry(4, 4, 4), matRight)
    boxRight.position.set(6, 0, 0)
    scene.add(boxRight)

    // Ambient to show unlit box is visible
    const ambient = new THREE.AmbientLight('#333333', 1)
    scene.add(ambient)

    console.info('[SelectiveTest] Left=lights:false  Right=lightsNode=[light]')

    return () => { scene.remove(light, boxLeft, boxRight, ambient) }
  }, [scene])

  return null
}
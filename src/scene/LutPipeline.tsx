/**
 * LutPipeline.tsx
 * Post-process color grading via 3D LUTs (.cube files), following the
 * three.js webgpu_3d_luts example exactly.
 *
 * Mounted inside <Canvas frameloop="never">. Takes over rendering completely:
 * builds a THREE.RenderPipeline with a scene pass -> renderOutput -> lut3D
 * chain, and calls renderPipeline.render() every frame via useFrame instead
 * of letting R3F's default render loop run.
 *
 * LUT selection ('None' or one of the three .cube files) and intensity are
 * controlled from the 'colorGrading' leva folder (lutName, lutIntensity in
 * SceneControls). When lutName is 'None', the pipeline still runs but with
 * intensity forced to 0, so the image is visually identical to no grading.
 */
import { useEffect, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three/webgpu'
import { pass, renderOutput, texture3D, uniform } from 'three/tsl'
import { lut3D } from 'three/addons/tsl/display/Lut3DNode.js'
import { LUTCubeLoader } from 'three/addons/loaders/LUTCubeLoader.js'
import { LUT_FILES } from '../config'
import type { SceneControls } from '../config'

type Lut3DResult = { texture3D: THREE.Data3DTexture }

export function LutPipeline({ controls }: { controls: SceneControls }) {
  const { gl, scene, camera } = useThree()

  // Load every .cube file once. 'None' has no file and is skipped.
  const lutsRef = useRef<Record<string, Lut3DResult | null>>({})
  const loadedRef = useRef(false)

  useEffect(() => {
    if (loadedRef.current) return
    loadedRef.current = true

    const loader = new LUTCubeLoader()
    const entries = Object.entries(LUT_FILES).filter(([, url]) => url)

    Promise.all(entries.map(([name, url]) => loader.loadAsync(url).then((lut) => [name, lut] as const)))
      .then((results) => {
        for (const [name, lut] of results) {
          lutsRef.current[name] = lut as unknown as Lut3DResult
        }
      })
      .catch((err) => console.error('[LutPipeline] failed to load LUTs:', err))
  }, [])

  // Build the render pipeline once. outputColorTransform = false because
  // renderOutput() inside the chain takes over tone mapping + color space.
  const { renderPipeline, lutPass } = useMemo(() => {
    const renderer = gl as unknown as THREE.WebGPURenderer
    const pipeline = new THREE.RenderPipeline(renderer)
    pipeline.outputColorTransform = false

    const scenePass  = pass(scene, camera)
    const outputPass = renderOutput(scenePass)

    // Built with a 2x2x2 placeholder texture; swapped for the real LUT once
    // loaded (see useFrame below). Using lutNode/size as live uniforms means
    // we never need to rebuild the pipeline when switching LUTs.
    const placeholder = new THREE.Data3DTexture(new Uint8Array(8 * 4), 2, 2, 2)
    placeholder.needsUpdate = true

    const pass3d = lut3D(outputPass, texture3D(placeholder), 2, uniform(0))
    pipeline.outputNode = pass3d

    return { renderPipeline: pipeline, lutPass: pass3d }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gl, scene, camera])

  useEffect(() => () => {
    renderPipeline.dispose?.()
  }, [renderPipeline])

  // Drive the render loop ourselves (Canvas has frameloop="never").
  useFrame(() => {
    const lut = controls.lutName !== 'None' ? lutsRef.current[controls.lutName] : null

    if (lut) {
      ;(lutPass as unknown as { lutNode: { value: THREE.Data3DTexture } }).lutNode.value = lut.texture3D
      ;(lutPass as unknown as { size: { value: number } }).size.value = lut.texture3D.image.width
      ;(lutPass as unknown as { intensityNode: { value: number } }).intensityNode.value = controls.lutIntensity
    } else {
      ;(lutPass as unknown as { intensityNode: { value: number } }).intensityNode.value = 0
    }

    renderPipeline.render()
  }, 1) // priority 1: run after scene-graph updates, replaces default render

  return null
}
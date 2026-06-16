/* ----------------------- watercolor post (add to App.tsx) ---------------- */
/**
 * Drop this component inside <Canvas>, after <Scene/>. It disables R3F auto
 * render (renderPriority 1) and drives three renders per frame:
 *   1. scene            -> sceneTarget     (original color, scaled)
 *   2. tensor quad      -> tensorTarget     (structure tensor, scaled)
 *   3. kuwahara+final   -> screen           (reads both targets, full screen)
 *
 * Perf notes:
 *   - resolutionScale (< 1) renders the scene + effect at reduced resolution.
 *     Kuwahara output is smooth, so 0.5 is near-invisible and ~4x faster.
 *   - Pair with frameloop="demand" on <Canvas> so the GPU idles when the
 *     camera is still. That is the main fix for sustained heat.
 *
 * The watercolor texture multiply and the quantize/saturate/ACES stylize block
 * are both optional and off by default.
 */
import { useEffect, useMemo } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three/webgpu'
import { texture as tslTexture, float, uniform } from 'three/tsl'
import { tensorNode, kuwaharaFinalNode } from './watercolorEffect'

function WatercolorPost({
  radius = 10,
  enabled = true,
  stylize = false,
  resolutionScale = 0.5,
}: {
  radius?: number
  enabled?: boolean
  stylize?: boolean
  resolutionScale?: number
}) {
  const { gl, scene, camera, size } = useThree()

  const radiusUniform = useMemo(() => uniform(float(radius)), [])
  useEffect(() => { radiusUniform.value = radius }, [radius, radiusUniform])

  const tw = Math.max(1, Math.floor(size.width * resolutionScale))
  const th = Math.max(1, Math.floor(size.height * resolutionScale))

  const { sceneTarget, tensorTarget, quad, postScene, postCam } = useMemo(() => {
    const opts = { type: THREE.HalfFloatType as THREE.TextureDataType }
    const sceneTarget = new THREE.RenderTarget(tw, th, opts)
    const tensorTarget = new THREE.RenderTarget(tw, th, opts)

    const postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
    const postScene = new THREE.Scene()
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2))
    postScene.add(quad)

    return { sceneTarget, tensorTarget, quad, postScene, postCam }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // resize targets when viewport or scale changes
  useEffect(() => {
    sceneTarget.setSize(tw, th)
    tensorTarget.setSize(tw, th)
  }, [tw, th, sceneTarget, tensorTarget])

  // rebuild materials when the stylize flag changes (it is a JS-side branch)
  const { tensorMat, finalMat } = useMemo(() => {
    const sceneColorNode = tslTexture(sceneTarget.texture)
    const tensorColorNode = tslTexture(tensorTarget.texture)

    const tensorMat = new THREE.NodeMaterial()
    tensorMat.fragmentNode = tensorNode(sceneColorNode)
    tensorMat.depthTest = false
    tensorMat.depthWrite = false

    const finalMat = new THREE.NodeMaterial()
    finalMat.fragmentNode = kuwaharaFinalNode(
      tensorColorNode,
      sceneColorNode,
      radiusUniform,
      { stylize },
    )
    finalMat.depthTest = false
    finalMat.depthWrite = false

    return { tensorMat, finalMat }
  }, [sceneTarget, tensorTarget, radiusUniform, stylize])

  useEffect(() => () => {
    sceneTarget.dispose()
    tensorTarget.dispose()
    quad.geometry.dispose()
    tensorMat.dispose()
    finalMat.dispose()
  }, [sceneTarget, tensorTarget, quad, tensorMat, finalMat])

  useFrame(() => {
    const r = gl as unknown as THREE.WebGPURenderer
    if (!enabled) {
      r.setRenderTarget(null)
      r.render(scene, camera)
      return
    }

    // 1. scene -> sceneTarget (scaled)
    r.setRenderTarget(sceneTarget)
    r.render(scene, camera)

    // 2. tensor -> tensorTarget (scaled)
    quad.material = tensorMat
    r.setRenderTarget(tensorTarget)
    r.render(postScene, postCam)

    // 3. kuwahara + final -> screen (full size, upscaled sample)
    quad.material = finalMat
    r.setRenderTarget(null)
    r.render(postScene, postCam)
  }, 1) // renderPriority 1 disables R3F auto-render

  return null
}

export default WatercolorPost
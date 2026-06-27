import { useEffect, useMemo } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three/webgpu'
import { pass, renderOutput, uniform } from 'three/tsl'
import { chromaticAberration } from 'three/addons/tsl/display/ChromaticAberrationNode.js'
import type { SceneControls } from '../config'

export function ChromaticAberrationPass({ controls }: { controls: SceneControls }) {
  const { gl, scene, camera } = useThree()

  const pipelineData = useMemo(() => {
    const renderer = gl as unknown as THREE.WebGPURenderer

    const renderPipeline = new THREE.RenderPipeline(renderer)
    renderPipeline.outputColorTransform = false

    const scenePass = pass(scene, camera)
    const outputPass = renderOutput(scenePass)

    const strength = uniform(controls.chromaticAberrationStrength)
    const center = uniform(
      new THREE.Vector2(
        controls.chromaticAberrationCenterX,
        controls.chromaticAberrationCenterY,
      )
    )
    const scale = uniform(controls.chromaticAberrationScale)

    const caPass = chromaticAberration(outputPass, strength, center, scale)

    renderPipeline.outputNode = controls.chromaticAberrationEnabled
      ? caPass
      : outputPass

    return {
      renderPipeline,
      outputPass,
      caPass,
      strength,
      center,
      scale,
    }
  }, [gl, scene, camera])

  useEffect(() => {
    pipelineData.strength.value = controls.chromaticAberrationStrength
    pipelineData.center.value.set(
      controls.chromaticAberrationCenterX,
      controls.chromaticAberrationCenterY,
    )
    pipelineData.scale.value = controls.chromaticAberrationScale
  }, [
    pipelineData,
    controls.chromaticAberrationStrength,
    controls.chromaticAberrationCenterX,
    controls.chromaticAberrationCenterY,
    controls.chromaticAberrationScale,
  ])

  useEffect(() => {
    pipelineData.renderPipeline.outputNode = controls.chromaticAberrationEnabled
      ? pipelineData.caPass
      : pipelineData.outputPass

    pipelineData.renderPipeline.needsUpdate = true
  }, [pipelineData, controls.chromaticAberrationEnabled])

  // Positive priority takes over R3F's automatic render loop.
  useFrame(() => {
    pipelineData.renderPipeline.render()
  }, 1)

  return null
}
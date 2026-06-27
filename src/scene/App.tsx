/**
 * App.tsx
 * Parallax-corrected cubemap room (WebGPU) with baked GI, GLB reflector mirror,
 * selective lighting, shadows, light-probe GI on imported models, and 3D LUT
 * color grading as a post-process.
 *
 * Render loop: Canvas uses frameloop="never" because LutPipeline takes over
 * rendering entirely (THREE.RenderPipeline + lut3D post-process). R3F still
 * drives the scene graph / animation updates each frame via useFrame inside
 * LutPipeline, which calls renderPipeline.render() itself instead of letting
 * R3F call renderer.render() automatically.
 *
 * This file is the thin entry point. Logic lives in:
 *   config.ts         constants, types, leva schema + flattening
 *   lib.ts             classify, texture helpers, draco loader, bpcem node
 *   scene/SceneLights.tsx   all real-time lights
 *   scene/BakedRoom.tsx     room materials, reflector, cubemap capture, probe
 *   scene/TestModels.tsx    imported models with selective lighting
 *   scene/Scene.tsx         assembly + renderer/camera/probe lifecycle
 *   scene/LutPipeline.tsx   post-process color grading (3D LUTs)
 */
import { Suspense, useCallback, useState } from 'react'
import { Canvas, extend } from '@react-three/fiber'
import { useControls } from 'leva'
import * as THREE from 'three/webgpu'
import { Scene } from './Scene'
import { LutPipeline } from './LutPipeline'
import { flattenControls, levaSchema } from '../config'
import type { MeshReport, SceneControls } from '../config'

extend(THREE as unknown as Record<string, unknown>)

function Diagnostics({ report }: { report: MeshReport }) {
  const ok = report.meshCount > 0 && report.uv1Count === report.meshCount
  return (
    <div style={{
      position: 'fixed', top: 12, left: 12, zIndex: 10, padding: '10px 12px',
      font: '12px/1.4 monospace', color: ok ? '#9be39b' : '#ffcc66',
      background: 'rgba(0,0,0,0.6)', borderRadius: 6, pointerEvents: 'none',
    }}>
      <div>meshes: {report.meshCount}</div>
      <div>with uv1: {report.uv1Count}{ok ? '  (all good)' : '  (some missing uv1!)'}</div>
      {report.unmatched.length > 0 && <div>unmatched: {report.unmatched.slice(0, 6).join(', ')}</div>}
    </div>
  )
}

export default function App() {
  const [report, setReport] = useState<MeshReport>({ meshCount: 0, uv1Count: 0, unmatched: [] })
  const raw = useControls('scene', levaSchema)
  const controls: SceneControls = flattenControls(raw as Record<string, unknown>)

  const createRenderer = useCallback(async (props: Record<string, unknown>) => {
    const r = new THREE.WebGPURenderer({ ...props, antialias: true } as any)
    await r.init()
    return r as any
  }, [])

  return (
    <main style={{ width: '100vw', height: '100vh' }}>
      <Diagnostics report={report} />
      {/* frameloop stays default ("always") — LutPipeline's useFrame uses a
          numeric render-priority (1) which alone disables R3F's automatic
          gl.render() call, per R3F docs. The scene graph still updates every
          tick; only the final render() call is replaced by renderPipeline.render(). */}
      <Canvas
        gl={createRenderer}
        shadows
        dpr={[1, 1.5]}
        camera={{ position: [5, 3, 6], fov: 42, near: 0.1, far: 50000 }}
      >
        <Suspense fallback={null}>
          <Scene controls={controls} onReport={setReport} />
          <LutPipeline controls={controls} />
        </Suspense>
      </Canvas>
    </main>
  )
}
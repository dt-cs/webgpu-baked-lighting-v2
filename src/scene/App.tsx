/**
 * App.tsx
 * Thin WebGPU/R3F entry point for the current baked black-background scene.
 *
 * Current direction:
 *   - baked GI + AO room
 *   - no BPCEM / reflector / window reflection
 *   - no LUT post-process pipeline for now
 *   - test models may remain in the repo, but are not part of the active scene
 */
import { Suspense, useCallback, useState } from 'react'
import { Canvas, extend } from '@react-three/fiber'
import { useControls } from 'leva'
import * as THREE from 'three/webgpu'
import { Scene } from './Scene'
import { flattenControls, levaSchema } from '../config'
import type { MeshReport, SceneControls } from '../config'

extend(THREE as unknown as Record<string, unknown>)

function Diagnostics({ report }: { report: MeshReport }) {
  const ok = report.meshCount > 0 && report.uv1Count === report.meshCount

  return (
    <div style={{
      position: 'fixed',
      top: 12,
      left: 12,
      zIndex: 10,
      padding: '10px 12px',
      font: '12px/1.4 monospace',
      color: ok ? '#9be39b' : '#ffcc66',
      background: 'rgba(0,0,0,0.6)',
      borderRadius: 6,
      pointerEvents: 'none',
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
    const renderer = new THREE.WebGPURenderer({ ...props, antialias: true } as any)
    await renderer.init()
    return renderer as any
  }, [])

  return (
    <main style={{ width: '100vw', height: '100vh', background: '#000' }}>
      <Diagnostics report={report} />
      <Canvas
        gl={createRenderer}
        dpr={[1, 1.5]}
        camera={{ position: [80, 40, 120], fov: 24, near: 0.5, far: 2000 }}
      >
        <Suspense fallback={null}>
          <Scene controls={controls} onReport={setReport} />
        </Suspense>
      </Canvas>
    </main>
  )
}

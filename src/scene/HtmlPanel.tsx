/**
 * HtmlPanel.tsx
 * Loads html.glb (a screen/panel mesh in the room) and projects an HTML
 * element onto its surface via THREE.HTMLTexture (WebGPU-only feature).
 *
 * Static display — no InteractionManager, no click handling. The HTML is
 * rendered once into a texture; CSS animations inside the element still run,
 * but the texture is only re-rasterized when the renderer detects a change
 * (HTMLTexture handles this internally via the canvas/HTML-in-canvas API).
 *
 * To change what's displayed: edit buildPanelHtml() below — it returns the
 * innerHTML string used for the panel content.
 */
import { useEffect, useMemo } from 'react'
import { useLoader } from '@react-three/fiber'
import * as THREE from 'three/webgpu'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { dracoLoader } from '../lib'
import { HTML_PANEL_URL } from '../config'

/** The HTML content shown on the in-scene panel. Edit freely. */
function buildPanelHtml(): string {
  return `
    <div style="
      width: 100%; height: 100%;
      display: flex; flex-direction: column; justify-content: center; align-items: center;
      background: #0c0c0c; color: #f2f2f2;
      font-family: sans-serif; text-align: center; padding: 24px;
    ">
      <div style="font-size: 28px; font-weight: 600; letter-spacing: 0.02em;">
        Portfolio
      </div>
      <div style="font-size: 16px; opacity: 0.7; margin-top: 8px;">
        WebGPU baked room — Deebak Tamilmani
      </div>
    </div>
  `
}

export function HtmlPanel() {
  const gltf = useLoader(GLTFLoader, HTML_PANEL_URL, (l) => l.setDRACOLoader(dracoLoader))

  const root = useMemo(() => gltf.scene.clone(true), [gltf.scene])

  useEffect(() => {
    // Build the offscreen HTML element once. HTMLTexture owns rasterization.
    const el = document.createElement('div')
    el.style.width  = '1024px'
    el.style.height = '640px'
    el.innerHTML = buildPanelHtml()

    const htmlTexture = new (THREE as unknown as {
      HTMLTexture: new (element: HTMLElement) => THREE.Texture
    }).HTMLTexture(el)
    htmlTexture.colorSpace = THREE.SRGBColorSpace

    root.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (!mesh.isMesh) return
      const mat = new THREE.MeshStandardNodeMaterial({
        map: htmlTexture,
        roughness: 0.4,
        metalness: 0.0,
        side: THREE.FrontSide,
      })
      // Static panel — fully baked-style, no real-time light contribution.
      mat.needsUpdate = true
      mesh.material = mat
      mesh.castShadow    = false
      mesh.receiveShadow = false
    })

    return () => {
      htmlTexture.dispose()
    }
  }, [root])

  return <primitive object={root} />
}
/**
 * lib.ts
 * Leaf utilities with no React: DRACO loader, mesh classification, texture
 * configuration, and the BPCEM env node. Pure helpers, safe to import anywhere.
 */
import * as THREE from 'three/webgpu'
import { Fn, float, min as tslMin, positionWorld, pmremTexture, reflectVector, vec3 } from 'three/tsl'
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js'
import { CUBEMAP_SIZE, CUBEMAP_POS } from './config'
import type { Group, Atlas } from './config'

/* ---------------------------- draco loader ------------------------------ */
export const dracoLoader = new DRACOLoader()
dracoLoader.setDecoderPath('/draco/')
dracoLoader.setDecoderConfig({ type: 'wasm' })

/* --------------------------- mesh classify ------------------------------ */
export function classify(name: string): { group: Group; lightmap: Atlas } {
  const n = name.toLowerCase()

  // New grouped bake naming from lightmaps.glb:
  //   background_objects: columns, corridors, walls / background elements
  //   roof: coffer slab, light wells, roof walls
  //   floor: floor slabs and platforms
  // Keep lightmap as 'tile' for now so this compiles with the current config.ts.
  // After config.ts is updated, BakedRoom.tsx will route these groups to the new
  // LM_Bake_bg / LM_Bake_floor / LM_Bake_roof textures.
  if (
    n.includes('column') ||
    n.includes('corridor') ||
    n.includes('background') ||
    n.includes('wall')
  ) {
    return { group: 'wall', lightmap: 'tile' }
  }

  if (
    n.includes('roof') ||
    n.includes('ceiling') ||
    n.includes('coffer') ||
    n.includes('light_well') ||
    n.includes('lightwell')
  ) {
    return { group: 'roof', lightmap: 'tile' }
  }

  if (
    n.includes('floor') ||
    n.includes('platform') ||
    n.includes('slab')
  ) {
    return { group: 'floor', lightmap: 'tile' }
  }

  // Legacy / fallback names from the previous room.
  if (n.includes('beading') || n.includes('wood'))        return { group: 'wood',  lightmap: 'wood' }
  if (n.includes('metal'))                                return { group: 'metal', lightmap: 'wood' }
  if (n.startsWith('shelf'))                              return { group: 'wood',  lightmap: 'wood' }
  if (n.includes('table') && n.includes('tile'))          return { group: 'wall',  lightmap: 'tile' }
  if (n.startsWith('new_floor'))                          return { group: 'floor', lightmap: 'tile' }
  if (n.startsWith('new_roof'))                           return { group: 'roof',  lightmap: 'tile' }
  if (n.startsWith('new_wall'))                           return { group: 'wall',  lightmap: 'tile' }

  return { group: 'unknown', lightmap: 'tile' }
}

/* --------------------------- texture helpers ---------------------------- */
export function configurePbrTexture(t: THREE.Texture, cs: THREE.ColorSpace) {
  t.flipY = false
  t.channel = 0
  t.colorSpace = cs
  t.wrapS = THREE.RepeatWrapping
  t.wrapT = THREE.RepeatWrapping
  t.anisotropy = 8
  t.needsUpdate = true
}

export function configureLightMap(t: THREE.Texture, channel: number, flipY: boolean, cs: THREE.ColorSpace) {
  t.flipY = flipY
  t.channel = channel
  t.colorSpace = cs
  t.wrapS = THREE.ClampToEdgeWrapping
  t.wrapT = THREE.ClampToEdgeWrapping
  t.needsUpdate = true
}

export function configureAoMap(t: THREE.Texture, channel: number, flipY: boolean) {
  // AO is data, not color. It must not be sRGB-decoded.
  t.flipY = flipY
  t.channel = channel
  t.colorSpace = THREE.NoColorSpace
  t.wrapS = THREE.ClampToEdgeWrapping
  t.wrapT = THREE.ClampToEdgeWrapping
  t.needsUpdate = true
}

export function copyPbr(src: THREE.Material, dst: THREE.MeshStandardNodeMaterial) {
  const s = src as THREE.MeshStandardMaterial
  if (s.color)       dst.color.copy(s.color)
  if (s.normalScale) dst.normalScale.copy(s.normalScale)
  dst.map          = s.map          ?? null
  dst.normalMap    = s.normalMap    ?? null
  dst.roughness    = s.roughness    ?? 1
  dst.roughnessMap = s.roughnessMap ?? null
  dst.metalness    = s.metalness    ?? 0
  dst.metalnessMap = s.metalnessMap ?? null
  dst.side         = s.side         ?? THREE.FrontSide
  dst.name         = s.name         ?? ''
  return dst
}

/* ----------------------------- bpcem node ------------------------------- */
export function makeBpcemEnvNode(cubeRt: THREE.CubeRenderTarget) {
  const bpcemLookup = Fn(() => {
    const cubeSize = vec3(CUBEMAP_SIZE.x, CUBEMAP_SIZE.y, CUBEMAP_SIZE.z)
    const cubePos  = vec3(CUBEMAP_POS.x, CUBEMAP_POS.y, CUBEMAP_POS.z)
    const pos = positionWorld
    const R   = reflectVector
    const half    = cubeSize.sub(cubePos).mul(0.5)
    const rbmax   = half.sub(pos).div(R)
    const rbmin   = half.negate().sub(pos).div(R)
    const rbminmax = vec3(
      R.x.greaterThan(float(0)).select(rbmax.x, rbmin.x),
      R.y.greaterThan(float(0)).select(rbmax.y, rbmin.y),
      R.z.greaterThan(float(0)).select(rbmax.z, rbmin.z),
    )
    const correction      = tslMin(tslMin(rbminmax.x, rbminmax.y), rbminmax.z)
    const boxIntersection = pos.add(R.mul(correction))
    return boxIntersection.sub(cubePos)
  })()

  return pmremTexture(cubeRt.texture, bpcemLookup)
}

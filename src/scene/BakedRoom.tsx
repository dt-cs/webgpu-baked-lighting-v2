/**
 * BakedRoom.tsx
 *
 * Current baked room direction:
 *   - black-background, fully baked architectural scene
 *   - grouped Blender export: background / floor / roof
 *   - grouped lightmaps + AO maps
 *   - one concrete PBR set reused across all architectural surfaces
 *   - no BPCEM, no cubemap capture, no reflector, no light-probe extraction
 */
import { useEffect, useMemo } from 'react'
import { useLoader } from '@react-three/fiber'
import * as THREE from 'three/webgpu'
import { float, lights, texture } from 'three/tsl'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import {
  BG_AO_URL,
  BG_LIGHTMAP_URL,
  CONCRETE_COLOR_URL,
  CONCRETE_NORMAL_URL,
  CONCRETE_ROUGHNESS_URL,
  FLOOR_AO_URL,
  FLOOR_LIGHTMAP_URL,
  MODEL_URL,
  ROOF_AO_URL,
  ROOF_LIGHTMAP_URL,
} from '../config'
import type { Group, MeshReport, PbrSet, SceneControls } from '../config'
import {
  classify,
  configureAoMap,
  configureLightMap,
  configurePbrTexture,
  copyPbr,
  dracoLoader,
} from '../lib'

/** Synced roughness lookup per group. */
function groupRoughness(group: Group, c: SceneControls): number {
  if (group === 'floor') return c.floorRoughness
  if (group === 'roof') return c.roofRoughness
  return c.wallRoughness
}

/** Synced normal-scale lookup per group. */
function groupNormalScale(group: Group, c: SceneControls): number {
  if (group === 'floor') return c.floorNormalScale
  if (group === 'roof') return c.roofNormalScale
  return c.wallNormalScale
}

function groupLightMap(group: Group, maps: {
  bg: THREE.Texture
  floor: THREE.Texture
  roof: THREE.Texture
}) {
  if (group === 'floor') return maps.floor
  if (group === 'roof') return maps.roof
  return maps.bg
}

function groupAoMap(group: Group, maps: {
  bg: THREE.Texture
  floor: THREE.Texture
  roof: THREE.Texture
}) {
  if (group === 'floor') return maps.floor
  if (group === 'roof') return maps.roof
  return maps.bg
}

export function BakedRoom({ controls, onReport, onRecenterOffset }: {
  controls: SceneControls
  forestExr?: THREE.Texture | null
  onReport: (r: MeshReport) => void
  onLightProbe?: (lp: THREE.LightProbe) => void
  onEnvNode?: (node: unknown) => void
  /** Exposes the room's recenter offset so other GLBs authored in the same
      un-recentred space, for example window.glb, can apply the same translation. */
  onRecenterOffset?: (offset: THREE.Vector3) => void
}) {
  const gltf = useLoader(GLTFLoader, MODEL_URL, (l) => l.setDRACOLoader(dracoLoader))

  const [bgLightMap, floorLightMap, roofLightMap, bgAo, floorAo, roofAo] = useLoader(THREE.TextureLoader, [
    BG_LIGHTMAP_URL,
    FLOOR_LIGHTMAP_URL,
    ROOF_LIGHTMAP_URL,
    BG_AO_URL,
    FLOOR_AO_URL,
    ROOF_AO_URL,
  ])

  const [concreteColor, concreteNormal, concreteRoughness] = useLoader(THREE.TextureLoader, [
    CONCRETE_COLOR_URL,
    CONCRETE_NORMAL_URL,
    CONCRETE_ROUGHNESS_URL,
  ])

  /* Recentre room to origin. */
  const root = useMemo(() => {
    const r = gltf.scene.clone(true)
    r.updateMatrixWorld(true)

    const box = new THREE.Box3().setFromObject(r)
    const centre = box.getCenter(new THREE.Vector3())
    const recenterOffset = centre.clone().multiplyScalar(-1)

    r.position.copy(recenterOffset)
    r.userData.recenterOffset = recenterOffset
    r.updateMatrixWorld(true)

    r.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (!mesh.isMesh) return

      // This room is baked. Real-time lights should not cast or receive on it.
      mesh.castShadow = false
      mesh.receiveShadow = false
      mesh.frustumCulled = false
    })

    return r
  }, [gltf.scene])

  useEffect(() => {
    const offset = root.userData.recenterOffset as THREE.Vector3 | undefined
    if (offset) onRecenterOffset?.(offset)
  }, [root, onRecenterOffset])

  /* Texture config. */
  useEffect(() => {
    const lightMapColorSpace = controls.lightMapSRGB ? THREE.SRGBColorSpace : THREE.NoColorSpace

    configureLightMap(bgLightMap, controls.lightMapChannel, controls.lightMapFlipY, lightMapColorSpace)
    configureLightMap(floorLightMap, controls.lightMapChannel, controls.lightMapFlipY, lightMapColorSpace)
    configureLightMap(roofLightMap, controls.lightMapChannel, controls.lightMapFlipY, lightMapColorSpace)

    configureAoMap(bgAo, controls.lightMapChannel, controls.lightMapFlipY)
    configureAoMap(floorAo, controls.lightMapChannel, controls.lightMapFlipY)
    configureAoMap(roofAo, controls.lightMapChannel, controls.lightMapFlipY)
  }, [
    bgLightMap,
    floorLightMap,
    roofLightMap,
    bgAo,
    floorAo,
    roofAo,
    controls.lightMapChannel,
    controls.lightMapFlipY,
    controls.lightMapSRGB,
  ])

  useEffect(() => {
    configurePbrTexture(concreteColor, THREE.SRGBColorSpace)
    configurePbrTexture(concreteNormal, THREE.NoColorSpace)
    configurePbrTexture(concreteRoughness, THREE.NoColorSpace)
  }, [concreteColor, concreteNormal, concreteRoughness])

  const concreteSet = useMemo<PbrSet>(() => ({
    color: concreteColor,
    normal: concreteNormal,
    roughness: concreteRoughness,
  }), [concreteColor, concreteNormal, concreteRoughness])

  /* Material build. */
  useEffect(() => {
    let meshCount = 0
    let uv1Count = 0
    const unmatched: string[] = []
    const pbrMode = controls.materialMode === 'PBR + baked GI'

    const lightMaps = {
      bg: bgLightMap,
      floor: floorLightMap,
      roof: roofLightMap,
    }

    const aoMaps = {
      bg: bgAo,
      floor: floorAo,
      roof: roofAo,
    }

    const applyLm = (m: THREE.MeshStandardNodeMaterial, lm: THREE.Texture, ao: THREE.Texture) => {
      m.lightMap = controls.bakedGiEnabled ? lm : null
      m.lightMapIntensity = controls.bakedGiEnabled ? controls.lightMapIntensity : 0
      m.aoMap = controls.aoEnabled ? ao : null
      m.aoMapIntensity = controls.aoEnabled ? 1 : 0

      // Fully baked room: no direct/spot/probe lights, no env reflections.
      m.envNode = null
      m.envMap = null
      m.envMapIntensity = 0
      m.lightsNode = lights([])
      m.needsUpdate = true
      return m
    }

    const makeGiOnly = (lm: THREE.Texture, ao: THREE.Texture) => {
      const m = new THREE.MeshStandardNodeMaterial({
        color: '#fff',
        roughness: 1,
        metalness: 0,
        side: THREE.FrontSide,
      })
      return applyLm(m, lm, ao)
    }

    const makePbr = (set: PbrSet, group: Group, lm: THREE.Texture, ao: THREE.Texture) => {
      const roughnessValue = groupRoughness(group, controls)
      const normalValue = groupNormalScale(group, controls)

      const m = new THREE.MeshStandardNodeMaterial({
        color: '#fff',
        map: set.color,
        normalMap: set.normal,
        roughness: roughnessValue,
        metalness: 0,
        side: THREE.FrontSide,
      })

      // The current concrete PBR packed map uses the BLUE channel for roughness.
      // Do not assign it as roughnessMap because three.js standard roughnessMap
      // expects the green channel. Use a roughnessNode instead.
      if (set.roughness) {
        m.roughnessNode = texture(set.roughness).b.mul(float(roughnessValue)).saturate()
      }

      m.normalScale.set(normalValue, normalValue)
      return applyLm(m, lm, ao)
    }

    const fromGlb = (orig: THREE.Material, group: Group, lm: THREE.Texture, ao: THREE.Texture) => {
      const m = copyPbr(Array.isArray(orig) ? orig[0] : orig, new THREE.MeshStandardNodeMaterial())
      m.roughness = groupRoughness(group, controls)
      m.normalScale.set(groupNormalScale(group, controls), groupNormalScale(group, controls))
      return applyLm(m, lm, ao)
    }

    const makeUvDebug = (lm: THREE.Texture) =>
      new THREE.MeshBasicNodeMaterial({ map: lm, side: THREE.FrontSide })

    root.traverse((child) => {
      const mesh = child as THREE.Mesh
      if (!mesh.isMesh) return

      meshCount++
      if (mesh.geometry.getAttribute('uv1')) uv1Count++
      if (!mesh.userData.bakeOriginal) mesh.userData.bakeOriginal = mesh.material

      const original = mesh.userData.bakeOriginal as THREE.Material
      const { group } = classify(mesh.name || '')
      const lm = groupLightMap(group, lightMaps)
      const ao = groupAoMap(group, aoMaps)
      let material: THREE.Material

      if (controls.materialMode === 'UV debug') {
        material = makeUvDebug(lm)
      } else if (controls.materialMode === 'GI only') {
        material = makeGiOnly(lm, ao)
      } else if (controls.allFromGlb) {
        material = fromGlb(original, group, lm, ao)
      } else if (group === 'floor' || group === 'wall' || group === 'roof') {
        material = makePbr(concreteSet, group, lm, ao)
      } else {
        unmatched.push(mesh.name || '(unnamed)')
        material = makeGiOnly(lm, ao)
      }

      mesh.material = material
    })

    onReport({ meshCount, uv1Count, unmatched })
  }, [
    root,
    bgLightMap,
    floorLightMap,
    roofLightMap,
    bgAo,
    floorAo,
    roofAo,
    concreteSet,
    onReport,
    controls.materialMode,
    controls.bakedGiEnabled,
    controls.lightMapIntensity,
    controls.aoEnabled,
    controls.floorRoughness,
    controls.wallRoughness,
    controls.roofRoughness,
    controls.floorNormalScale,
    controls.wallNormalScale,
    controls.roofNormalScale,
    controls.allFromGlb,
  ])

  return <primitive object={root} />
}

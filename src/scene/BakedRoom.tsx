/**
 * BakedRoom.tsx
 * The baked room: lightmapped + AO materials, BPCEM cubemap reflections,
 * GLB reflector mirror on the table, one-time cubemap capture, light-probe
 * extraction for GI on models.
 *
 * Reflection design (synced):
 *   ONE roughness slider per group drives the PBR material roughness AND the
 *   reflector gloss mask/blur. ONE normal-scale slider drives material
 *   normalScale AND reflector normal distortion. No separate reflector
 *   tuning controls.
 *
 *   The reflector itself uses textureBicubic() to blur the reflection by
 *   roughness — rougher table surface = blurrier mirror, sharper = clearer.
 *   Output is unlit (MeshBasicNodeMaterial), additive-blended over the table.
 *
 * Hardcoded (previously controls, now fixed):
 *   - env reflection intensity = 1 for all groups (no per-group, no global)
 *   - cubemap capture origin = room centre (0,0,0), no offsets
 *   - AO intensity = 1 (AO on/off still available)
 *   - reflector UV editing removed (texture mapping is correct)
 */
import { useEffect, useMemo, useRef } from 'react'
import { useFrame, useLoader, useThree } from '@react-three/fiber'
import { useControls, button } from 'leva'
import * as THREE from 'three/webgpu'
import { Fn, float, lights, reflector, texture, textureBicubic, uv, vec4 } from 'three/tsl'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { LightProbeGenerator } from 'three/addons/lights/LightProbeGenerator.js'
import {
  CUBEMAP_POS, FLOOR_COLOR_URL, FLOOR_NORMAL_URL, MODEL_URL, REFLECTOR_URL,
  ROOF_COLOR_URL, ROOF_NORMAL_URL, ROOF_ROUGHNESS_URL, SKYBOX_ROTATION_Y_RAD,
  TILE_AO_URL, TILE_LIGHTMAP_URL, WALL_COLOR_URL, WALL_NORMAL_URL,
  WALL_ROUGHNESS_URL, WOOD_AO_URL, WOOD_LIGHTMAP_URL,
} from '../config'
import type { Group, MeshReport, PbrSet, SceneControls } from '../config'
import { classify, configureAoMap, configureLightMap, configurePbrTexture, copyPbr, dracoLoader, makeBpcemEnvNode } from '../lib'

/** Synced roughness lookup per group. */
function groupRoughness(group: Group, c: SceneControls): number {
  if (group === 'floor') return c.floorRoughness
  if (group === 'roof')  return c.roofRoughness
  return c.wallRoughness   // wall, wood, metal, unknown
}

/** Synced normal-scale lookup per group. */
function groupNormalScale(group: Group, c: SceneControls): number {
  if (group === 'floor') return c.floorNormalScale
  if (group === 'roof')  return c.roofNormalScale
  return c.wallNormalScale
}

export function BakedRoom({ controls, forestExr, onReport, onLightProbe, onEnvNode, onRecenterOffset }: {
  controls:     SceneControls
  forestExr:    THREE.Texture | null
  onReport:     (r: MeshReport) => void
  onLightProbe: (lp: THREE.LightProbe) => void
  /** Exposes the room's BPCEM env node so other meshes (e.g. window glass)
      can sample the exact same parallax-corrected reflection. */
  onEnvNode?:   (node: ReturnType<typeof makeBpcemEnvNode>) => void
  /** Exposes the room's recenter offset so other GLBs authored in the same
      un-recentred space (e.g. window.glb) can apply the same translation. */
  onRecenterOffset?: (offset: THREE.Vector3) => void
}) {
  const { gl, scene } = useThree()

  const gltf          = useLoader(GLTFLoader, MODEL_URL,     (l) => l.setDRACOLoader(dracoLoader))
  const reflectorGltf = useLoader(GLTFLoader, REFLECTOR_URL, (l) => l.setDRACOLoader(dracoLoader))

  const [tileLightMap, woodLightMap, tileAo, woodAo] = useLoader(THREE.TextureLoader, [
    TILE_LIGHTMAP_URL, WOOD_LIGHTMAP_URL, TILE_AO_URL, WOOD_AO_URL,
  ])

  const [
    floorColor, floorNormal,
    roofColor, roofNormal, roofRoughnessTex,
    wallColor, wallNormal, wallRoughnessTex,
  ] = useLoader(THREE.TextureLoader, [
    FLOOR_COLOR_URL, FLOOR_NORMAL_URL,
    ROOF_COLOR_URL,  ROOF_NORMAL_URL,  ROOF_ROUGHNESS_URL,
    WALL_COLOR_URL,  WALL_NORMAL_URL,  WALL_ROUGHNESS_URL,
  ])

  /* recentre room to origin */
  const root = useMemo(() => {
    const r = gltf.scene.clone(true)
    r.updateMatrixWorld(true)
    const box    = new THREE.Box3().setFromObject(r)
    const centre = box.getCenter(new THREE.Vector3())
    r.position.sub(centre)
    r.userData.recenterOffset = centre.clone().multiplyScalar(-1)
    r.updateMatrixWorld(true)
    onRecenterOffset?.(r.userData.recenterOffset as THREE.Vector3)
    r.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (!mesh.isMesh) return
      mesh.receiveShadow = true
      const n = (mesh.name || '').toLowerCase()
      const isTable = n.includes('table')
      mesh.castShadow = isTable
      if (isTable && mesh.material) {
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
        mats.forEach((m: THREE.Material) => { m.side = THREE.DoubleSide })
      }
    })
    return r
  }, [gltf.scene])

  /* shadow-catcher planes on the table top */
  const shadowPlanes = useMemo(() => {
    const planes: { width: number; depth: number; position: THREE.Vector3 }[] = []
    root.traverse((child) => {
      const mesh = child as THREE.Mesh
      if (!mesh.isMesh) return
      if ((mesh.name || '').toLowerCase().includes('table')) {
        const box = new THREE.Box3().setFromObject(mesh)
        const size = box.getSize(new THREE.Vector3())
        const center = box.getCenter(new THREE.Vector3())
        planes.push({ width: size.x, depth: size.z, position: new THREE.Vector3(center.x, box.max.y + 0.01, center.z) })
      }
    })
    return planes
  }, [root])

  /* cube capture target */
  const capControls = useControls('cube capture', {
    cubeResolution: { value: 512, options: { '256': 256, '512': 512, '1024': 1024 }, label: 'resolution' },
    recapture: button(() => { capturedRef.current = false }),
  })
  const cubeRes = (capControls as unknown as { cubeResolution: number }).cubeResolution

  const { cubeRt, cubeCam } = useMemo(() => {
    const rt = new THREE.CubeRenderTarget(cubeRes, { type: THREE.HalfFloatType, format: THREE.RGBAFormat })
    rt.texture.minFilter       = THREE.LinearMipmapLinearFilter
    rt.texture.magFilter       = THREE.LinearFilter
    rt.texture.generateMipmaps = true
    rt.texture.mapping         = THREE.CubeReflectionMapping
    const cam = new THREE.CubeCamera(0.05, 10000, rt)
    return { cubeRt: rt, cubeCam: cam }
  }, [cubeRes])

  useEffect(() => () => cubeRt.dispose(), [cubeRt])

  /* BPCEM env node — fixed room-centre origin */
  const bpcemEnvNode = useMemo(() => makeBpcemEnvNode(cubeRt), [cubeRt])

  useEffect(() => {
    onEnvNode?.(bpcemEnvNode)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bpcemEnvNode])

  /* GLB reflector — table mirror. Roughness mask + normal distortion are
     driven by the SAME wall roughness/normal controls as the table material.
     Reflection blur comes from textureBicubic() keyed by the roughness map,
     so a rougher table looks like a duller, blurrier mirror. */
  const reflectorRoot = useMemo(() => {
    const r = reflectorGltf.scene.clone(true)
    const recenterOffset = (root.userData.recenterOffset as THREE.Vector3 | undefined) ?? new THREE.Vector3()
    r.position.copy(recenterOffset)
    r.position.y += controls.reflectorYOffset
    r.updateMatrixWorld(true)

    r.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (!mesh.isMesh) return

      const refl = reflector({
        resolutionScale: 0.5,
        bounces: false,
        generateMipmaps: true,
      })

      const reflectorUv = uv()

      // Normal distortion from the same wall/table normal scale.
      const normalDistortion = controls.wallNormalScale * 0.025
      if (normalDistortion !== 0) {
        const uvOffset = texture(wallNormal, reflectorUv).xy.mul(2).sub(1).mul(normalDistortion)
        refl.uvNode = refl.uvNode.add(uvOffset)
      }

      // Same roughness texture as the table material.
      const roughnessSample = texture(wallRoughnessTex, reflectorUv).r

      // Combine roughness texture with the wall roughness slider:
      // lower wallRoughness -> sharper reflection, higher -> blurrier/duller.
      const roughnessNode = roughnessSample
        .mul(float(controls.wallRoughness))
        .mul(1.35)
        .saturate()

      // textureBicubic blurs the reflection based on roughness.
      const roughReflection = textureBicubic(refl, roughnessNode.mul(0.85))

      // Reflection visibility floor so it never fully disappears;
      // textureBicubic already handles the blur/roughness response.
      const glossAmount = float(1).sub(roughnessNode.mul(0.75)).max(float(0.25))

      const reflectionNode = Fn(() => {
        return vec4(
          roughReflection.rgb.mul(glossAmount).mul(0.45),
          glossAmount.mul(0.65),
        )
      })()

      const mat = new THREE.MeshBasicNodeMaterial()
      mat.name = 'TSL_Rough_Table_Reflector_Unlit'
      mat.transparent = true
      mat.colorNode = reflectionNode
      mat.opacity = controls.reflectionsEnabled && controls.reflectorEnabled ? 1 : 0
      mat.blending = THREE.AdditiveBlending
      mat.depthWrite = false
      mat.depthTest = true
      mat.side = THREE.DoubleSide
      mat.needsUpdate = true

      mesh.material = mat
      mesh.castShadow = false
      mesh.receiveShadow = false
      mesh.frustumCulled = false
      mesh.renderOrder = 20

      const target = refl.target as THREE.Object3D
      target.position.set(0, 0, 0)
      target.rotation.set(
        THREE.MathUtils.degToRad(controls.reflectorTargetRotX),
        THREE.MathUtils.degToRad(controls.reflectorTargetRotY),
        THREE.MathUtils.degToRad(controls.reflectorTargetRotZ),
      )
      target.updateMatrixWorld(true)
      mesh.add(target)
    })
    return r
  }, [
    reflectorGltf.scene, root, wallNormal, wallRoughnessTex,
    controls.reflectionsEnabled, controls.reflectorEnabled, controls.reflectorYOffset,
    controls.wallRoughness, controls.wallNormalScale,
    controls.reflectorTargetRotX, controls.reflectorTargetRotY, controls.reflectorTargetRotZ,
  ])

  /* one-time cubemap capture + light-probe extraction */
  const capturedRef = useRef(false)

  useFrame(() => {
    if (capturedRef.current || !forestExr) return
    capturedRef.current = true

    const cs = controls.lightMapSRGB ? THREE.SRGBColorSpace : THREE.NoColorSpace

    root.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (!mesh.isMesh) return
      const { lightmap } = classify(mesh.name || '')
      const lm = lightmap === 'wood' ? woodLightMap : tileLightMap
      configureLightMap(lm, controls.lightMapChannel, controls.lightMapFlipY, cs)
      mesh.material = new THREE.MeshBasicNodeMaterial({ map: lm, side: THREE.FrontSide })
    })

    cubeCam.position.set(CUBEMAP_POS.x, CUBEMAP_POS.y, CUBEMAP_POS.z)
    cubeCam.updateMatrixWorld(true)

    const prevBg  = scene.background
    const prevEnv = scene.environment
    scene.background = forestExr
    scene.backgroundRotation.set(0, SKYBOX_ROTATION_Y_RAD, 0)
    scene.environment = null

    cubeCam.update(gl as unknown as THREE.WebGLRenderer, scene)

    scene.background  = prevBg
    scene.environment = prevEnv

    LightProbeGenerator.fromCubeRenderTarget(gl as unknown as THREE.WebGLRenderer, cubeRt).then((probe) => {
      probe.intensity = controls.lightProbeIntensity
      onLightProbe(probe)
    })

    buildMaterials()
  })

  /* texture config */
  useEffect(() => {
    const cs = controls.lightMapSRGB ? THREE.SRGBColorSpace : THREE.NoColorSpace
    configureLightMap(tileLightMap, controls.lightMapChannel, controls.lightMapFlipY, cs)
    configureLightMap(woodLightMap, controls.lightMapChannel, controls.lightMapFlipY, cs)
    configureAoMap(tileAo, controls.lightMapChannel, controls.lightMapFlipY)
    configureAoMap(woodAo, controls.lightMapChannel, controls.lightMapFlipY)
  }, [tileLightMap, woodLightMap, tileAo, woodAo, controls.lightMapChannel, controls.lightMapFlipY, controls.lightMapSRGB])

  useEffect(() => {
    configurePbrTexture(floorColor, THREE.SRGBColorSpace); configurePbrTexture(floorNormal, THREE.NoColorSpace)
    configurePbrTexture(roofColor,  THREE.SRGBColorSpace); configurePbrTexture(roofNormal,  THREE.NoColorSpace)
    configurePbrTexture(roofRoughnessTex, THREE.NoColorSpace)
    configurePbrTexture(wallColor,  THREE.SRGBColorSpace); configurePbrTexture(wallNormal,  THREE.NoColorSpace)
    configurePbrTexture(wallRoughnessTex, THREE.NoColorSpace)
  }, [floorColor, floorNormal, roofColor, roofNormal, roofRoughnessTex, wallColor, wallNormal, wallRoughnessTex])

  const floorSet = useMemo<PbrSet>(() => ({ color: floorColor, normal: floorNormal }), [floorColor, floorNormal])
  const roofSet  = useMemo<PbrSet>(() => ({ color: roofColor, normal: roofNormal, roughness: roofRoughnessTex }), [roofColor, roofNormal, roofRoughnessTex])
  const wallSet  = useMemo<PbrSet>(() => ({ color: wallColor, normal: wallNormal, roughness: wallRoughnessTex }), [wallColor, wallNormal, wallRoughnessTex])

  /* material build */
  const buildMaterialsRef = useRef<(() => void) | null>(null)
  const buildMaterials = () => buildMaterialsRef.current?.()

  useEffect(() => {
    buildMaterialsRef.current = () => {
      let meshCount = 0, uv1Count = 0
      const unmatched: string[] = []
      const pbrMode = controls.materialMode === 'PBR + baked GI'

      const applyLm = (m: THREE.MeshStandardNodeMaterial, lm: THREE.Texture, ao: THREE.Texture) => {
        m.lightMap          = controls.bakedGiEnabled ? lm : null
        m.lightMapIntensity = controls.bakedGiEnabled ? controls.lightMapIntensity : 0
        m.aoMap             = controls.aoEnabled ? ao : null
        m.aoMapIntensity    = controls.aoEnabled ? 1 : 0
        m.envNode           = pbrMode && controls.reflectionsEnabled ? bpcemEnvNode : null
        m.envMap            = null
        m.envMapIntensity   = pbrMode && controls.reflectionsEnabled ? 1 : 0
        m.lightsNode        = lights([])
        m.needsUpdate       = true
        return m
      }

      const makeGiOnly = (lm: THREE.Texture, ao: THREE.Texture) =>
        applyLm(new THREE.MeshStandardNodeMaterial({ color: '#fff', roughness: 1, metalness: 0, side: THREE.FrontSide }), lm, ao)

      const makePbr = (set: PbrSet, group: Group, lm: THREE.Texture, ao: THREE.Texture) => {
        const m = new THREE.MeshStandardNodeMaterial({
          color: '#fff', map: set.color, normalMap: set.normal,
          roughnessMap: set.roughness ?? null, roughness: groupRoughness(group, controls),
          metalness: 0, side: THREE.FrontSide,
        })
        const ns = groupNormalScale(group, controls)
        m.normalScale.set(ns, ns)
        return applyLm(m, lm, ao)
      }

      const fromGlb = (orig: THREE.Material, group: Group, lm: THREE.Texture, ao: THREE.Texture) => {
        const m = copyPbr(Array.isArray(orig) ? orig[0] : orig, new THREE.MeshStandardNodeMaterial())
        m.roughness = groupRoughness(group, controls)
        const ns = groupNormalScale(group, controls)
        m.normalScale.set(ns, ns)
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
        const { group, lightmap } = classify(mesh.name || '')
        const lm = lightmap === 'wood' ? woodLightMap : tileLightMap
        const ao = lightmap === 'wood' ? woodAo       : tileAo
        let material: THREE.Material

        if      (controls.materialMode === 'UV debug') material = makeUvDebug(lm)
        else if (controls.materialMode === 'GI only')  material = makeGiOnly(lm, ao)
        else if (controls.allFromGlb)                  material = fromGlb(original, group, lm, ao)
        else if (group === 'floor') material = makePbr(floorSet, group, lm, ao)
        else if (group === 'wall')  material = makePbr(wallSet,  group, lm, ao)
        else if (group === 'roof')  material = makePbr(roofSet,  group, lm, ao)
        else {
          if (group === 'unknown') unmatched.push(mesh.name || '(unnamed)')
          material = fromGlb(original, group, lm, ao)
        }
        mesh.material = material
      })

      onReport({ meshCount, uv1Count, unmatched })
    }
    buildMaterialsRef.current()
  }, [
    root, bpcemEnvNode, tileLightMap, woodLightMap, tileAo, woodAo,
    floorSet, roofSet, wallSet, onReport,
    controls.materialMode, controls.bakedGiEnabled, controls.lightMapIntensity,
    controls.reflectionsEnabled, controls.aoEnabled,
    controls.floorRoughness, controls.wallRoughness, controls.roofRoughness,
    controls.floorNormalScale, controls.wallNormalScale, controls.roofNormalScale,
    controls.allFromGlb,
  ])

  return (
    <>
      <primitive object={root} />
      {shadowPlanes.map((plane, idx) => (
        <mesh
          key={`shadow-plane-${idx}`}
          position={[plane.position.x, plane.position.y, plane.position.z]}
          rotation={[-Math.PI / 2, 0, 0]}
          receiveShadow
        >
          <planeGeometry args={[plane.width, plane.depth]} />
          <shadowMaterial opacity={controls.shadowPlaneOpacity} />
        </mesh>
      ))}
      {controls.reflectionsEnabled && controls.reflectorEnabled && (
        <primitive object={reflectorRoot} />
      )}
    </>
  )
}
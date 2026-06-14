/**
 * App.tsx
 * ---------------------------------------------------------------------------
 * Indirect-lightmap + shadow-casting SpotLight test harness.
 *
 * Intended workflow:
 *
 * Blender / Cycles
 *   HDRI + nearby Area Light
 *          ↓
 *   Bake DIFFUSE INDIRECT ONLY
 *
 * Three.js
 *   baked indirect lightmap
 *   +
 *   real-time SpotLight near the window
 *
 * The SpotLight provides:
 *   - direct diffuse illumination
 *   - normal-map response
 *   - roughness response
 *   - PBR highlights
 *   - real-time shadows
 *
 * The indirect lightmap provides:
 *   - HDRI color mood
 *   - bounced lighting
 *   - color bleeding
 *   - static indirect occlusion
 *
 * Keep environment intensity at 0 while testing this workflow.
 * ---------------------------------------------------------------------------
 */

import {
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

import {
  Canvas,
  useLoader,
  useThree,
} from '@react-three/fiber'

import {
  Environment,
  OrbitControls,
} from '@react-three/drei'

import {
  folder,
  useControls,
} from 'leva'

import * as THREE from 'three'

import {
  GLTFLoader,
} from 'three/addons/loaders/GLTFLoader.js'

import {
  DRACOLoader,
} from 'three/addons/loaders/DRACOLoader.js'

/* ------------------------------ asset paths ------------------------------ */

const MODEL_URL =
  '/assets/simple_bake_01.glb'

/**
 * Replace these with your DIFFUSE INDIRECT ONLY lightmaps.
 */
const TILE_LIGHTMAP_URL =
  '/assets/bake_black_tile.png'

const WOOD_LIGHTMAP_URL =
  '/assets/wood_lm.png'

const TILE_AO_URL =
  '/assets/ao_tile.png'

const WOOD_AO_URL =
  '/assets/ao_wood.png'

const HDR_URL =
  '/hdr/fall-forest-dirt-road_2K_e53f34e1-5505-4646-adfa-a7d03f4259eb.exr'

const FLOOR_COLOR_URL =
  '/pbr/floor/tiles-11_diffuse.jpg'

const FLOOR_NORMAL_URL =
  '/pbr/floor/tiles-11_normal.jpg'

const ROOF_COLOR_URL =
  '/pbr/roof/concrete_04_color.jpg'

const ROOF_NORMAL_URL =
  '/pbr/roof/concrete_04_normal.jpg'

const ROOF_ROUGHNESS_URL =
  '/pbr/roof/concrete_04_roughness.jpg'

const WALL_COLOR_URL =
  '/pbr/wall/tiles10_diffuse.jpg'

const WALL_NORMAL_URL =
  '/pbr/wall/tiles10_normal_opengl.jpg'

const WALL_ROUGHNESS_URL =
  '/pbr/wall/tiles10_roughness.jpg'

/* --------------------------- mesh-name routing --------------------------- */

type Group =
  | 'floor'
  | 'wall'
  | 'roof'
  | 'wood'
  | 'metal'
  | 'unknown'

type Atlas =
  | 'tile'
  | 'wood'

function classify(
  name: string,
): {
  group: Group
  lightmap: Atlas
} {
  const normalizedName =
    name.toLowerCase()

  if (
    normalizedName.includes('beading') ||
    normalizedName.includes('wood')
  ) {
    return {
      group: 'wood',
      lightmap: 'wood',
    }
  }

  if (
    normalizedName.includes('metal')
  ) {
    return {
      group: 'metal',
      lightmap: 'wood',
    }
  }

  if (
    normalizedName.startsWith('shelf')
  ) {
    return {
      group: 'wood',
      lightmap: 'wood',
    }
  }

  if (
    normalizedName.includes('table') &&
    normalizedName.includes('tile')
  ) {
    return {
      group: 'wall',
      lightmap: 'tile',
    }
  }

  if (
    normalizedName.startsWith('new_floor') ||
    normalizedName.startsWith('floor')
  ) {
    return {
      group: 'floor',
      lightmap: 'tile',
    }
  }

  if (
    normalizedName.startsWith('new_roof') ||
    normalizedName.startsWith('roof') ||
    normalizedName.includes('ceiling')
  ) {
    return {
      group: 'roof',
      lightmap: 'tile',
    }
  }

  if (
    normalizedName.startsWith('new_wall') ||
    normalizedName.startsWith('wall')
  ) {
    return {
      group: 'wall',
      lightmap: 'tile',
    }
  }

  return {
    group: 'unknown',
    lightmap: 'tile',
  }
}

/* -------------------------------- draco ---------------------------------- */

const dracoLoader =
  new DRACOLoader()

dracoLoader.setDecoderPath(
  '/draco/',
)

dracoLoader.setDecoderConfig({
  type: 'wasm',
})

/* ------------------------------ tone mapping ----------------------------- */

const TONE_MAPPING: Record<
  string,
  THREE.ToneMapping
> = {
  None: THREE.NoToneMapping,
  AgX: THREE.AgXToneMapping,
  Neutral: THREE.NeutralToneMapping,
  ACES: THREE.ACESFilmicToneMapping,
}

/* ------------------------------- renderer -------------------------------- */

function RendererSettings({
  toneMapping,
  exposure,
}: {
  toneMapping: THREE.ToneMapping
  exposure: number
}) {
  const {
    gl,
  } = useThree()

  useEffect(() => {
    gl.outputColorSpace =
      THREE.SRGBColorSpace

    gl.toneMapping =
      toneMapping

    gl.toneMappingExposure =
      exposure

    gl.shadowMap.enabled =
      true

    gl.shadowMap.type =
      THREE.PCFSoftShadowMap
  }, [
    gl,
    toneMapping,
    exposure,
  ])

  return null
}

/* ---------------------------- texture helpers ---------------------------- */

function configurePbrTexture(
  texture: THREE.Texture,
  colorSpace: THREE.ColorSpace,
) {
  texture.flipY =
    false

  texture.channel =
    0

  texture.colorSpace =
    colorSpace

  texture.wrapS =
    THREE.RepeatWrapping

  texture.wrapT =
    THREE.RepeatWrapping

  texture.anisotropy =
    8

  texture.needsUpdate =
    true
}

function configureLightMap(
  lightMap: THREE.Texture,
  channel: number,
  flipY: boolean,
  colorSpace: THREE.ColorSpace,
) {
  lightMap.flipY =
    flipY

  lightMap.channel =
    channel

  lightMap.colorSpace =
    colorSpace

  lightMap.wrapS =
    THREE.ClampToEdgeWrapping

  lightMap.wrapT =
    THREE.ClampToEdgeWrapping

  lightMap.needsUpdate =
    true
}

/* --------------------------------- types --------------------------------- */

type MaterialMode =
  | 'GI only'
  | 'PBR + baked GI'
  | 'UV debug'
  | 'plain white'

type SceneControls = {
  materialMode: MaterialMode

  bakedGiEnabled: boolean
  lightMapIntensity: number
  lightMapChannel: number
  lightMapFlipY: boolean
  lightMapSRGB: boolean

  toneMapping: THREE.ToneMapping
  exposure: number
  background: string

  envEnabled: boolean
  envAsBackground: boolean
  envIntensity: number
  envRotation: number

  spotLightEnabled: boolean
  spotLightColor: string
  spotLightIntensity: number
  spotLightDistance: number
  spotLightAngleDegrees: number
  spotLightPenumbra: number
  spotLightDecay: number

  spotLightX: number
  spotLightY: number
  spotLightZ: number

  spotTargetX: number
  spotTargetY: number
  spotTargetZ: number

  spotCastShadow: boolean
  spotShadowMapSize: number
  spotShadowNear: number
  spotShadowFar: number
  spotShadowBias: number
  spotShadowNormalBias: number
  spotShadowRadius: number
  spotShadowFocus: number

  showSpotHelper: boolean
  showSpotTarget: boolean
  spotTargetSize: number
  showSpotShadowCameraHelper: boolean

  floorRoughness: number
  wallRoughness: number
  roofRoughness: number
  allFromGlb: boolean

  aoEnabled: boolean
  aoMapIntensity: number

  metalColor: string
  metalRoughness: number
  metalness: number

  normalStrength: number
}

type PbrSet = {
  color: THREE.Texture
  normal: THREE.Texture
  roughness?: THREE.Texture
}

type MeshReport = {
  meshCount: number
  uv1Count: number
  unmatched: string[]
}

/* ---------------------------- window spotlight --------------------------- */

function WindowSpotLight({
  controls,
}: {
  controls: SceneControls
}) {
  const {
    scene,
  } = useThree()

  const lightRef =
    useRef<THREE.SpotLight>(null)

  const targetRef =
    useRef<THREE.Object3D>(
      new THREE.Object3D(),
    )

  const spotHelperRef =
    useRef<THREE.SpotLightHelper | null>(
      null,
    )

  const shadowCameraHelperRef =
    useRef<THREE.CameraHelper | null>(
      null,
    )

  useEffect(() => {
    const light =
      lightRef.current

    const target =
      targetRef.current

    if (!light) return

    /**
     * The spotlight target must be added to the scene.
     */
    target.userData.excludeFromCameraFrame =
      true

    scene.add(
      target,
    )

    light.target =
      target

    const spotHelper =
      new THREE.SpotLightHelper(
        light,
        '#ffcc00',
      )

    spotHelper.userData.excludeFromCameraFrame =
      true

    spotHelper.traverse((child) => {
      child.userData.excludeFromCameraFrame =
        true
    })

    scene.add(
      spotHelper,
    )

    spotHelperRef.current =
      spotHelper

    const shadowCameraHelper =
      new THREE.CameraHelper(
        light.shadow.camera,
      )

    shadowCameraHelper.userData.excludeFromCameraFrame =
      true

    shadowCameraHelper.traverse((child) => {
      child.userData.excludeFromCameraFrame =
        true
    })

    scene.add(
      shadowCameraHelper,
    )

    shadowCameraHelperRef.current =
      shadowCameraHelper

    return () => {
      scene.remove(
        target,
      )

      scene.remove(
        spotHelper,
      )

      spotHelper.dispose()

      spotHelperRef.current =
        null

      scene.remove(
        shadowCameraHelper,
      )

      shadowCameraHelper.dispose()

      shadowCameraHelperRef.current =
        null
    }
  }, [
    scene,
  ])

  useEffect(() => {
    const light =
      lightRef.current

    const target =
      targetRef.current

    if (!light) return

    light.visible =
      controls.spotLightEnabled

    light.color.set(
      controls.spotLightColor,
    )

    light.intensity =
      controls.spotLightIntensity

    light.distance =
      controls.spotLightDistance

    light.angle =
      THREE.MathUtils.degToRad(
        controls.spotLightAngleDegrees,
      )

    light.penumbra =
      controls.spotLightPenumbra

    light.decay =
      controls.spotLightDecay

    light.position.set(
      controls.spotLightX,
      controls.spotLightY,
      controls.spotLightZ,
    )

    target.position.set(
      controls.spotTargetX,
      controls.spotTargetY,
      controls.spotTargetZ,
    )

    light.castShadow =
      controls.spotCastShadow

    if (
      light.shadow.mapSize.x !==
        controls.spotShadowMapSize ||
      light.shadow.mapSize.y !==
        controls.spotShadowMapSize
    ) {
      light.shadow.mapSize.set(
        controls.spotShadowMapSize,
        controls.spotShadowMapSize,
      )

      /**
       * Force reallocation after changing shadow-map resolution.
       */
      light.shadow.map?.dispose()

      light.shadow.map =
        null
    }

    light.shadow.camera.near =
      controls.spotShadowNear

    light.shadow.camera.far =
      controls.spotShadowFar

    light.shadow.bias =
      controls.spotShadowBias

    light.shadow.normalBias =
      controls.spotShadowNormalBias

    light.shadow.radius =
      controls.spotShadowRadius

    light.shadow.focus =
      controls.spotShadowFocus

    target.updateMatrixWorld(
      true,
    )

    light.updateMatrixWorld(
      true,
    )

    /**
     * Update the spotlight shadow camera before updating its helper.
     */
    light.shadow.updateMatrices(
      light,
    )

    if (
      spotHelperRef.current
    ) {
      spotHelperRef.current.visible =
        controls.spotLightEnabled &&
        controls.showSpotHelper

      spotHelperRef.current.update()
    }

    if (
      shadowCameraHelperRef.current
    ) {
      shadowCameraHelperRef.current.visible =
        controls.spotLightEnabled &&
        controls.spotCastShadow &&
        controls.showSpotShadowCameraHelper

      shadowCameraHelperRef.current.update()
    }
  }, [
    controls.spotLightEnabled,
    controls.spotLightColor,
    controls.spotLightIntensity,
    controls.spotLightDistance,
    controls.spotLightAngleDegrees,
    controls.spotLightPenumbra,
    controls.spotLightDecay,

    controls.spotLightX,
    controls.spotLightY,
    controls.spotLightZ,

    controls.spotTargetX,
    controls.spotTargetY,
    controls.spotTargetZ,

    controls.spotCastShadow,
    controls.spotShadowMapSize,
    controls.spotShadowNear,
    controls.spotShadowFar,
    controls.spotShadowBias,
    controls.spotShadowNormalBias,
    controls.spotShadowRadius,
    controls.spotShadowFocus,

    controls.showSpotHelper,
    controls.showSpotShadowCameraHelper,
  ])

  return (
    <>
      <spotLight
        ref={lightRef}
        visible={
          controls.spotLightEnabled
        }
        color={
          controls.spotLightColor
        }
        intensity={
          controls.spotLightIntensity
        }
        distance={
          controls.spotLightDistance
        }
        angle={
          THREE.MathUtils.degToRad(
            controls.spotLightAngleDegrees,
          )
        }
        penumbra={
          controls.spotLightPenumbra
        }
        decay={
          controls.spotLightDecay
        }
        castShadow={
          controls.spotCastShadow
        }
        position={[
          controls.spotLightX,
          controls.spotLightY,
          controls.spotLightZ,
        ]}
      />

      {controls.showSpotTarget ? (
        <mesh
          userData={{
            excludeFromCameraFrame:
              true,
          }}
          position={[
            controls.spotTargetX,
            controls.spotTargetY,
            controls.spotTargetZ,
          ]}
        >
          <sphereGeometry
            args={[
              controls.spotTargetSize,
              16,
              16,
            ]}
          />

          <meshBasicMaterial
            color="#ff00ff"
          />
        </mesh>
      ) : null}
    </>
  )
}

/* --------------------------------- room ---------------------------------- */

function BakedRoom({
  controls,
  onReport,
}: {
  controls: SceneControls
  onReport: (
    report: MeshReport,
  ) => void
}) {
  const gltf =
    useLoader(
      GLTFLoader,
      MODEL_URL,
      (loader) => {
        loader.setDRACOLoader(
          dracoLoader,
        )
      },
    )

  const [
    tileLightMap,
    woodLightMap,
    tileAo,
    woodAo,
  ] = useLoader(
    THREE.TextureLoader,
    [
      TILE_LIGHTMAP_URL,
      WOOD_LIGHTMAP_URL,
      TILE_AO_URL,
      WOOD_AO_URL,
    ],
  )

  const [
    floorColor,
    floorNormal,

    roofColor,
    roofNormal,
    roofRoughness,

    wallColor,
    wallNormal,
    wallRoughness,
  ] = useLoader(
    THREE.TextureLoader,
    [
      FLOOR_COLOR_URL,
      FLOOR_NORMAL_URL,

      ROOF_COLOR_URL,
      ROOF_NORMAL_URL,
      ROOF_ROUGHNESS_URL,

      WALL_COLOR_URL,
      WALL_NORMAL_URL,
      WALL_ROUGHNESS_URL,
    ],
  )

  const root =
    useMemo(
      () =>
        gltf.scene.clone(
          true,
        ),
      [
        gltf.scene,
      ],
    )

  const floorSet =
    useMemo<PbrSet>(
      () => ({
        color: floorColor,
        normal: floorNormal,
      }),
      [
        floorColor,
        floorNormal,
      ],
    )

  const roofSet =
    useMemo<PbrSet>(
      () => ({
        color: roofColor,
        normal: roofNormal,
        roughness: roofRoughness,
      }),
      [
        roofColor,
        roofNormal,
        roofRoughness,
      ],
    )

  const wallSet =
    useMemo<PbrSet>(
      () => ({
        color: wallColor,
        normal: wallNormal,
        roughness: wallRoughness,
      }),
      [
        wallColor,
        wallNormal,
        wallRoughness,
      ],
    )

  useEffect(() => {
    const lightMapColorSpace =
      controls.lightMapSRGB
        ? THREE.SRGBColorSpace
        : THREE.NoColorSpace

    configureLightMap(
      tileLightMap,
      controls.lightMapChannel,
      controls.lightMapFlipY,
      lightMapColorSpace,
    )

    configureLightMap(
      woodLightMap,
      controls.lightMapChannel,
      controls.lightMapFlipY,
      lightMapColorSpace,
    )

    for (
      const aoMap of [
        tileAo,
        woodAo,
      ]
    ) {
      aoMap.flipY =
        controls.lightMapFlipY

      aoMap.channel =
        controls.lightMapChannel

      aoMap.colorSpace =
        THREE.NoColorSpace

      aoMap.wrapS =
        THREE.ClampToEdgeWrapping

      aoMap.wrapT =
        THREE.ClampToEdgeWrapping

      aoMap.needsUpdate =
        true
    }
  }, [
    tileLightMap,
    woodLightMap,
    tileAo,
    woodAo,

    controls.lightMapChannel,
    controls.lightMapFlipY,
    controls.lightMapSRGB,
  ])

  useEffect(() => {
    configurePbrTexture(
      floorColor,
      THREE.SRGBColorSpace,
    )

    configurePbrTexture(
      floorNormal,
      THREE.NoColorSpace,
    )

    configurePbrTexture(
      roofColor,
      THREE.SRGBColorSpace,
    )

    configurePbrTexture(
      roofNormal,
      THREE.NoColorSpace,
    )

    configurePbrTexture(
      roofRoughness,
      THREE.NoColorSpace,
    )

    configurePbrTexture(
      wallColor,
      THREE.SRGBColorSpace,
    )

    configurePbrTexture(
      wallNormal,
      THREE.NoColorSpace,
    )

    configurePbrTexture(
      wallRoughness,
      THREE.NoColorSpace,
    )
  }, [
    floorColor,
    floorNormal,

    roofColor,
    roofNormal,
    roofRoughness,

    wallColor,
    wallNormal,
    wallRoughness,
  ])

  useEffect(() => {
    const createdMaterials:
      THREE.Material[] =
        []

    let meshCount =
      0

    let uv1Count =
      0

    const unmatched:
      string[] =
        []

    const giEnabled =
      controls.bakedGiEnabled

    const lightMapIntensity =
      controls.lightMapIntensity

    const applyLightMap = (
      material:
        THREE.MeshStandardMaterial,
      lightMap:
        THREE.Texture,
    ) => {
      material.lightMap =
        giEnabled
          ? lightMap
          : null

      material.lightMapIntensity =
        giEnabled
          ? lightMapIntensity
          : 0

      material.needsUpdate =
        true

      return material
    }

    const makeGiOnly = (
      lightMap:
        THREE.Texture,
    ) =>
      applyLightMap(
        new THREE.MeshStandardMaterial({
          color: '#ffffff',
          roughness: 1,
          metalness: 0,
          side: THREE.FrontSide,
        }),
        lightMap,
      )

    const makePbr = (
      textureSet:
        PbrSet,
      roughness:
        number,
      lightMap:
        THREE.Texture,
    ) => {
      const material =
        new THREE.MeshStandardMaterial({
          color: '#ffffff',
          map: textureSet.color,
          normalMap:
            textureSet.normal,
          roughnessMap:
            textureSet.roughness ??
            null,
          roughness,
          metalness: 0,
          side: THREE.FrontSide,
        })

      material.normalScale.set(
        controls.normalStrength,
        controls.normalStrength,
      )

      return applyLightMap(
        material,
        lightMap,
      )
    }

    const fromGlb = (
      original:
        THREE.Material,
      lightMap:
        THREE.Texture,
    ) => {
      const base =
        (
          Array.isArray(
            original,
          )
            ? original[0]
            : original
        ) as THREE.Material

      const cloned =
        base.clone()

      if (
        (
          cloned as THREE.MeshStandardMaterial
        ).isMeshStandardMaterial
      ) {
        return applyLightMap(
          cloned as THREE.MeshStandardMaterial,
          lightMap,
        )
      }

      return cloned
    }

    const makeMetal = (
      lightMap:
        THREE.Texture,
    ) =>
      applyLightMap(
        new THREE.MeshStandardMaterial({
          color:
            controls.metalColor,
          roughness:
            controls.metalRoughness,
          metalness:
            controls.metalness,
          side:
            THREE.FrontSide,
        }),
        lightMap,
      )

    const makeUvDebug = (
      lightMap:
        THREE.Texture,
    ) =>
      new THREE.MeshBasicMaterial({
        map:
          lightMap,
        side:
          THREE.FrontSide,
      })

    const makeWhite =
      () =>
        new THREE.MeshStandardMaterial({
          color:
            '#ffffff',
          roughness:
            0.9,
          metalness:
            0,
          side:
            THREE.FrontSide,
        })

    root.traverse(
      (
        child,
      ) => {
        const mesh =
          child as THREE.Mesh

        if (
          !mesh.isMesh
        ) {
          return
        }

        /**
         * Required for spotlight shadows.
         */
        mesh.castShadow =
          true

        mesh.receiveShadow =
          true

        meshCount +=
          1

        if (
          mesh.geometry.getAttribute(
            'uv1',
          )
        ) {
          uv1Count +=
            1
        }

        if (
          !mesh.userData.bakeOriginal
        ) {
          mesh.userData.bakeOriginal =
            mesh.material
        }

        const original =
          mesh.userData.bakeOriginal as THREE.Material

        const {
          group,
          lightmap,
        } = classify(
          mesh.name ||
            '',
        )

        const selectedLightMap =
          lightmap ===
          'wood'
            ? woodLightMap
            : tileLightMap

        let material:
          THREE.Material

        if (
          controls.materialMode ===
          'UV debug'
        ) {
          material =
            makeUvDebug(
              selectedLightMap,
            )
        } else if (
          controls.materialMode ===
          'plain white'
        ) {
          material =
            makeWhite()
        } else if (
          controls.materialMode ===
          'GI only'
        ) {
          material =
            makeGiOnly(
              selectedLightMap,
            )
        } else if (
          controls.allFromGlb
        ) {
          material =
            fromGlb(
              original,
              selectedLightMap,
            )
        } else if (
          group ===
          'floor'
        ) {
          material =
            makePbr(
              floorSet,
              controls.floorRoughness,
              selectedLightMap,
            )
        } else if (
          group ===
          'wall'
        ) {
          material =
            makePbr(
              wallSet,
              controls.wallRoughness,
              selectedLightMap,
            )
        } else if (
          group ===
          'roof'
        ) {
          material =
            makePbr(
              roofSet,
              controls.roofRoughness,
              selectedLightMap,
            )
        } else if (
          group ===
          'metal'
        ) {
          material =
            makeMetal(
              selectedLightMap,
            )
        } else {
          if (
            group ===
            'unknown'
          ) {
            unmatched.push(
              mesh.name ||
                '(unnamed)',
            )
          }

          material =
            fromGlb(
              original,
              selectedLightMap,
            )
        }

        const selectedAo =
          lightmap ===
          'wood'
            ? woodAo
            : tileAo

        const standardMaterial =
          material as THREE.MeshStandardMaterial

        if (
          standardMaterial.isMeshStandardMaterial &&
          controls.aoEnabled
        ) {
          standardMaterial.aoMap =
            selectedAo

          standardMaterial.aoMapIntensity =
            controls.aoMapIntensity

          standardMaterial.needsUpdate =
            true
        }

        mesh.material =
          material

        createdMaterials.push(
          material,
        )
      },
    )

    onReport({
      meshCount,
      uv1Count,
      unmatched,
    })

    return () => {
      createdMaterials.forEach(
        (
          material,
        ) => {
          material.dispose()
        },
      )
    }
  }, [
    root,

    tileLightMap,
    woodLightMap,

    floorSet,
    roofSet,
    wallSet,

    onReport,

    controls.materialMode,
    controls.bakedGiEnabled,
    controls.lightMapIntensity,

    controls.normalStrength,

    controls.floorRoughness,
    controls.roofRoughness,
    controls.wallRoughness,

    controls.allFromGlb,

    controls.metalColor,
    controls.metalRoughness,
    controls.metalness,

    tileAo,
    woodAo,

    controls.aoEnabled,
    controls.aoMapIntensity,
  ])

  return (
    <primitive
      object={
        root
      }
    />
  )
}

/* ------------------------------ camera frame ----------------------------- */

function FrameOnce() {
  const {
    camera,
    scene,
    controls,
  } = useThree()

  const done =
    useRef(
      false,
    )

  useEffect(() => {
    if (
      done.current
    ) {
      return
    }

    scene.updateMatrixWorld(
      true,
    )

    const bounds =
      new THREE.Box3()

    const hasExcludedParent = (
      object:
        THREE.Object3D,
    ) => {
      let current:
        THREE.Object3D | null =
          object

      while (
        current
      ) {
        if (
          current.userData
            .excludeFromCameraFrame
        ) {
          return true
        }

        current =
          current.parent
      }

      return false
    }

    scene.traverse(
      (
        object,
      ) => {
        if (
          hasExcludedParent(
            object,
          )
        ) {
          return
        }

        const mesh =
          object as THREE.Mesh

        if (
          !mesh.isMesh ||
          !mesh.geometry
        ) {
          return
        }

        if (
          !mesh.geometry.boundingBox
        ) {
          mesh.geometry.computeBoundingBox()
        }

        const localBounds =
          mesh.geometry.boundingBox

        if (
          !localBounds
        ) {
          return
        }

        const worldBounds =
          localBounds
            .clone()
            .applyMatrix4(
              mesh.matrixWorld,
            )

        bounds.union(
          worldBounds,
        )
      },
    )

    if (
      bounds.isEmpty()
    ) {
      return
    }

    const size =
      bounds.getSize(
        new THREE.Vector3(),
      )

    const center =
      bounds.getCenter(
        new THREE.Vector3(),
      )

    const maxDimension =
      Math.max(
        size.x,
        size.y,
        size.z,
      ) || 1

    const distance =
      maxDimension *
      1.4

    camera.position.set(
      center.x +
        distance *
          0.7,
      center.y +
        distance *
          0.5,
      center.z +
        distance,
    )

    camera.near =
      Math.max(
        maxDimension /
          1000,
        0.01,
      )

    camera.far =
      maxDimension *
      100

    camera.updateProjectionMatrix()

    const orbitControls =
      controls as unknown as {
        target?: THREE.Vector3
        update?: () => void
      }

    if (
      orbitControls?.target
    ) {
      orbitControls.target.copy(
        center,
      )

      orbitControls.update?.()

      done.current =
        true
    } else {
      camera.lookAt(
        center,
      )
    }
  }, [
    camera,
    scene,
    controls,
  ])

  return null
}

/* -------------------------------- scene ---------------------------------- */

function Scene({
  controls,
  onReport,
}: {
  controls: SceneControls
  onReport: (
    report: MeshReport,
  ) => void
}) {
  return (
    <>
      <color
        attach="background"
        args={[
          controls.background,
        ]}
      />

      <RendererSettings
        toneMapping={
          controls.toneMapping
        }
        exposure={
          controls.exposure
        }
      />

      {/**
       * Diagnostic only:
       * set env intensity to 0 for the indirect-bake workflow.
       */}
      {controls.envEnabled ? (
        <Environment
          files={
            HDR_URL
          }
          environmentIntensity={
            controls.envIntensity
          }
          background={
            controls.envAsBackground
          }
          environmentRotation={[
            0,
            THREE.MathUtils.degToRad(
              controls.envRotation,
            ),
            0,
          ]}
          backgroundRotation={[
            0,
            THREE.MathUtils.degToRad(
              controls.envRotation,
            ),
            0,
          ]}
        />
      ) : null}

      <WindowSpotLight
        controls={
          controls
        }
      />

      <BakedRoom
        controls={
          controls
        }
        onReport={
          onReport
        }
      />

      <FrameOnce />

      <OrbitControls
        makeDefault
        enablePan
        enableZoom
        enableDamping
      />
    </>
  )
}

/* ------------------------------ diagnostics ------------------------------ */

function Diagnostics({
  report,
}: {
  report: MeshReport
}) {
  const uv1Ok =
    report.meshCount >
      0 &&
    report.uv1Count ===
      report.meshCount

  return (
    <div
      style={{
        position:
          'fixed',
        top:
          12,
        left:
          12,
        zIndex:
          10,
        padding:
          '10px 12px',
        font:
          '12px/1.4 monospace',
        color:
          uv1Ok
            ? '#9be39b'
            : '#ffcc66',
        background:
          'rgba(0,0,0,0.6)',
        borderRadius:
          6,
        pointerEvents:
          'none',
      }}
    >
      <div>
        meshes:{' '}
        {
          report.meshCount
        }
      </div>

      <div>
        with uv1:{' '}
        {
          report.uv1Count
        }

        {uv1Ok
          ? '  (all good)'
          : '  (some missing uv1!)'}
      </div>

      {report.unmatched.length >
      0 ? (
        <div>
          unmatched:{' '}
          {report.unmatched
            .slice(
              0,
              6,
            )
            .join(
              ', ',
            )}
        </div>
      ) : null}
    </div>
  )
}

/* ---------------------------------- app ---------------------------------- */

export default function App() {
  const [
    report,
    setReport,
  ] = useState<MeshReport>({
    meshCount:
      0,
    uv1Count:
      0,
    unmatched:
      [],
  })

  const raw =
    useControls(
      'bake check',
      {
        materialMode: {
          value:
            'PBR + baked GI',

          options: [
            'GI only',
            'PBR + baked GI',
            'UV debug',
            'plain white',
          ],

          label:
            'material mode',
        },

        bakedGiEnabled: {
          value:
            true,

          label:
            'baked indirect GI on',
        },

        lightMapIntensity: {
          value:
            1,

          min:
            0,

          max:
            5,

          step:
            0.05,

          label:
            'lightmap intensity',
        },

        lightMapChannel: {
          value:
            1,

          options: {
            'uv1 / channel 1':
              1,

            'uv / channel 0':
              0,
          },

          label:
            'lightmap channel',
        },

        lightMapFlipY: {
          value:
            false,

          label:
            'lightmap flipY',
        },

        lightMapSRGB: {
          value:
            true,

          label:
            'lightmap sRGB',
        },

        rendering:
          folder({
            toneMapping: {
              value:
                'None',

              options:
                Object.keys(
                  TONE_MAPPING,
                ),

              label:
                'tone mapping',
            },

            exposure: {
              value:
                1,

              min:
                0.1,

              max:
                2,

              step:
                0.01,
            },

            background:
              '#101010',
          }),

        /**
         * Keep this at 0 intensity while testing.
         * It is retained only to display the HDR background.
         */
        environmentDiagnostic:
          folder(
            {
              envEnabled: {
                value:
                  true,

                label:
                  'environment on',
              },

              envAsBackground: {
                value:
                  true,

                label:
                  'show env background',
              },

              envIntensity: {
                value:
                  0,

                min:
                  0,

                max:
                  3,

                step:
                  0.01,

                label:
                  'env intensity',
              },

              envRotation: {
                value:
                  132,

                min:
                  0,

                max:
                  360,

                step:
                  1,

                label:
                  'env rotation',
              },
            },
            {
              collapsed:
                true,
            },
          ),

        windowSpotLight:
          folder({
            spotLightEnabled: {
              value:
                true,

              label:
                'spot light on',
            },

            spotLightColor: {
              value:
                '#dbdbd6',

              label:
                'spot color',
            },

            /**
             * SpotLight intensity is measured differently from RectAreaLight.
             * Start here and tune visually.
             */
            spotLightIntensity: {
              value:
                12000,

              min:
                0,

              max:
                100000,

              step:
                100,

              label:
                'spot intensity',
            },

            spotLightDistance: {
              value:
                0,

              min:
                0,

              max:
                2000,

              step:
                1,

              label:
                'distance limit',
            },

            spotLightAngleDegrees: {
              value:
                42,

              min:
                1,

              max:
                89,

              step:
                0.1,

              label:
                'cone angle deg',
            },

            spotLightPenumbra: {
              value:
                0.8,

              min:
                0,

              max:
                1,

              step:
                0.01,

              label:
                'penumbra',
            },

            /**
             * Keep decay at 2 for physically sensible falloff.
             */
            spotLightDecay: {
              value:
                2,

              min:
                0,

              max:
                4,

              step:
                0.01,

              label:
                'decay',
            },

            /**
             * Initial placement copied from the tuned RectAreaLight.
             */
            spotLightX: {
              value:
                -200,

              min:
                -1000,

              max:
                1000,

              step:
                1,

              label:
                'light x',
            },

            spotLightY: {
              value:
                60,

              min:
                -1000,

              max:
                1000,

              step:
                1,

              label:
                'light y',
            },

            spotLightZ: {
              value:
                0,

              min:
                -1000,

              max:
                1000,

              step:
                1,

              label:
                'light z',
            },

            spotTargetX: {
              value:
                -50,

              min:
                -1000,

              max:
                1000,

              step:
                1,

              label:
                'target x',
            },

            spotTargetY: {
              value:
                0,

              min:
                -1000,

              max:
                1000,

              step:
                1,

              label:
                'target y',
            },

            spotTargetZ: {
              value:
                0,

              min:
                -1000,

              max:
                1000,

              step:
                1,

              label:
                'target z',
            },

            spotCastShadow: {
              value:
                true,

              label:
                'cast shadow',
            },

            spotShadowMapSize: {
              value:
                2048,

              options: {
                '1024':
                  1024,

                '2048':
                  2048,

                '4096':
                  4096,
              },

              label:
                'shadow resolution',
            },

            spotShadowNear: {
              value:
                0.1,

              min:
                0.01,

              max:
                100,

              step:
                0.01,

              label:
                'shadow near',
            },

            spotShadowFar: {
              value:
                1000,

              min:
                1,

              max:
                5000,

              step:
                1,

              label:
                'shadow far',
            },

            spotShadowBias: {
              value:
                -0.0001,

              min:
                -0.01,

              max:
                0.01,

              step:
                0.00001,

              label:
                'shadow bias',
            },

            spotShadowNormalBias: {
              value:
                0.02,

              min:
                0,

              max:
                2,

              step:
                0.001,

              label:
                'shadow normal bias',
            },

            spotShadowRadius: {
              value:
                2,

              min:
                1,

              max:
                20,

              step:
                0.1,

              label:
                'shadow softness',
            },

            spotShadowFocus: {
              value:
                1,

              min:
                0.01,

              max:
                1,

              step:
                0.01,

              label:
                'shadow focus',
            },

            showSpotHelper: {
              value:
                true,

              label:
                'show cone helper',
            },

            showSpotTarget: {
              value:
                false,

              label:
                'show target sphere',
            },

            spotTargetSize: {
              value:
                2,

              min:
                0.1,

              max:
                50,

              step:
                0.1,

              label:
                'target sphere size',
            },

            showSpotShadowCameraHelper: {
              value:
                false,

              label:
                'show shadow camera',
            },
          }),

        pbrMaterials:
          folder({
            floorRoughness: {
              value:
                0.44,

              min:
                0,

              max:
                1,

              step:
                0.01,

              label:
                'floor roughness',
            },

            wallRoughness: {
              value:
                0.79,

              min:
                0,

              max:
                1,

              step:
                0.01,

              label:
                'wall roughness',
            },

            roofRoughness: {
              value:
                0.77,

              min:
                0,

              max:
                1,

              step:
                0.01,

              label:
                'roof roughness',
            },

            normalStrength: {
              value:
                1.23,

              min:
                0,

              max:
                2,

              step:
                0.01,

              label:
                'normal strength',
            },

            allFromGlb: {
              value:
                false,

              label:
                'all materials from GLB',
            },
          }),

        aoDiagnostic:
          folder(
            {
              aoEnabled: {
                value:
                  false,

                label:
                  'AO map on',
              },

              aoMapIntensity: {
                value:
                  0.5,

                min:
                  0,

                max:
                  1,

                step:
                  0.05,

                label:
                  'AO intensity',
              },
            },
            {
              collapsed:
                true,
            },
          ),

        metalPlaceholder:
          folder(
            {
              metalColor: {
                value:
                  '#8a8a8a',

                label:
                  'metal color',
              },

              metalRoughness: {
                value:
                  0.35,

                min:
                  0,

                max:
                  1,

                step:
                  0.01,

                label:
                  'metal roughness',
              },

              metalness: {
                value:
                  0.8,

                min:
                  0,

                max:
                  1,

                step:
                  0.01,

                label:
                  'metalness',
              },
            },
            {
              collapsed:
                true,
            },
          ),
      },
    )

  const controls:
    SceneControls = {
      ...(
        raw as unknown as Omit<
          SceneControls,
          'toneMapping'
        >
      ),

      toneMapping:
        TONE_MAPPING[
          (
            raw as unknown as {
              toneMapping:
                string
            }
          ).toneMapping
        ],
    }

  return (
    <main
      style={{
        width:
          '100vw',

        height:
          '100vh',
      }}
    >
      <Diagnostics
        report={
          report
        }
      />

      <Canvas
        shadows={{
          type:
            THREE.PCFSoftShadowMap,
        }}
        dpr={[
          1,
          1.5,
        ]}
        camera={{
          position: [
            5,
            3,
            6,
          ],
          fov:
            42,
          near:
            0.1,
          far:
            50000,
        }}
      >
        <Suspense
          fallback={
            null
          }
        >
          <Scene
            controls={
              controls
            }
            onReport={
              setReport
            }
          />
        </Suspense>
      </Canvas>
    </main>
  )
}
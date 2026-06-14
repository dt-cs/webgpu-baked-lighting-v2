/**
 * App.tsx
 * ---------------------------------------------------------------------------
 * Three.js r184 baked-lighting workflow.
 *
 * LIGHTING MODEL
 *
 * Blender / Cycles:
 *   diffuse direct
 *   +
 *   diffuse indirect
 *   +
 *   shadows
 *   +
 *   occlusion
 *   +
 *   color bleeding
 *       ↓
 * baked lightmaps
 *
 * Three.js:
 *   baked lightmaps
 *   +
 *   /assets/room_env.exr as scene.environment
 *   +
 *   r184 ShaderChunk patch:
 *      disable diffuse environment irradiance
 *      preserve specular reflections
 *
 * WHY THIS PATCH EXISTS
 *
 * scene.environment normally contributes:
 *
 *   diffuse environment irradiance
 *   +
 *   specular reflections
 *
 * The baked lightmap already contains the diffuse lighting.
 * Adding environment diffuse again washes out the lightmap.
 *
 * In Three.js r184, ShaderChunk.lights_fragment_maps contains:
 *
 *   iblIrradiance += getIBLIrradiance( geometryNormal );
 *
 * We replace it globally with:
 *
 *   iblIrradiance += getIBLIrradiance( geometryNormal ) * 0.0;
 *
 * The separate specular-radiance path remains untouched.
 *
 * RESULT
 *
 * lightMap:
 *   owns diffuse lighting, shadows, bounce and occlusion
 *
 * room_env.exr:
 *   owns reflections, roughness response and reflection-driven normal detail
 *
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

/* ---------------------- r184 diffuse-IBL shader patch -------------------- */

/**
 * Patch the shared shader chunk before any material compiles.
 *
 * HMR-safe:
 * Vite may reload this module while developing. The custom flag prevents the
 * same source line from being patched repeatedly.
 */
const DIFFUSE_IBL_PATCH_FLAG =
  '__r184DiffuseEnvironmentDisabled'

function disableDiffuseEnvironmentLightingR184() {
  const shaderChunks =
    THREE.ShaderChunk as unknown as Record<
      string,
      string | boolean
    >

  if (
    shaderChunks[
      DIFFUSE_IBL_PATCH_FLAG
    ] === true
  ) {
    return
  }

  const chunkName =
    'lights_fragment_maps'

  const originalChunk =
    shaderChunks[
      chunkName
    ]

  if (
    typeof originalChunk !==
    'string'
  ) {
    throw new Error(
      '[r184 diffuse IBL patch] ShaderChunk.lights_fragment_maps was not found.',
    )
  }

  const target =
    'iblIrradiance += getIBLIrradiance( geometryNormal );'

  const replacement =
    'iblIrradiance += getIBLIrradiance( geometryNormal ) * 0.0;'

  if (
    !originalChunk.includes(
      target,
    )
  ) {
    console.error(
      '[r184 diffuse IBL patch] Exact target line was not found.',
    )

    console.log(
      '[r184 diffuse IBL patch] Installed shader chunk:',
      originalChunk,
    )

    throw new Error(
      '[r184 diffuse IBL patch] Patch failed. Inspect the browser console.',
    )
  }

  shaderChunks[
    chunkName
  ] =
    originalChunk.replace(
      target,
      replacement,
    )

  shaderChunks[
    DIFFUSE_IBL_PATCH_FLAG
  ] =
    true

  console.info(
    '[r184 diffuse IBL patch] Success: diffuse environment irradiance disabled; specular reflections preserved.',
  )
}

console.info(
  '[three revision]',
  THREE.REVISION,
)

disableDiffuseEnvironmentLightingR184()

/* ------------------------------ asset paths ------------------------------ */

const MODEL_URL =
  '/assets/simple_bake_01.glb'

const TILE_LIGHTMAP_URL =
  '/assets/bake_black_tile.png'

const WOOD_LIGHTMAP_URL =
  '/assets/wood_lm.png'

const TILE_AO_URL =
  '/assets/ao_tile.png'

const WOOD_AO_URL =
  '/assets/ao_wood.png'

/**
 * Blender-rendered 2:1 equirectangular EXR panorama captured inside the room.
 */
const ROOM_ENV_URL =
  '/assets/room_env.exr'

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
  name:
    string,
): {
  group:
    Group

  lightmap:
    Atlas
} {
  const normalized =
    name.toLowerCase()

  if (
    normalized.includes(
      'beading',
    ) ||
    normalized.includes(
      'wood',
    )
  ) {
    return {
      group:
        'wood',

      lightmap:
        'wood',
    }
  }

  if (
    normalized.includes(
      'metal',
    )
  ) {
    return {
      group:
        'metal',

      lightmap:
        'wood',
    }
  }

  if (
    normalized.startsWith(
      'shelf',
    )
  ) {
    return {
      group:
        'wood',

      lightmap:
        'wood',
    }
  }

  if (
    normalized.includes(
      'table',
    ) &&
    normalized.includes(
      'tile',
    )
  ) {
    return {
      group:
        'wall',

      lightmap:
        'tile',
    }
  }

  if (
    normalized.startsWith(
      'new_floor',
    ) ||
    normalized.startsWith(
      'floor',
    )
  ) {
    return {
      group:
        'floor',

      lightmap:
        'tile',
    }
  }

  if (
    normalized.startsWith(
      'new_roof',
    ) ||
    normalized.startsWith(
      'roof',
    ) ||
    normalized.includes(
      'ceiling',
    )
  ) {
    return {
      group:
        'roof',

      lightmap:
        'tile',
    }
  }

  if (
    normalized.startsWith(
      'new_wall',
    ) ||
    normalized.startsWith(
      'wall',
    )
  ) {
    return {
      group:
        'wall',

      lightmap:
        'tile',
    }
  }

  return {
    group:
      'unknown',

    lightmap:
      'tile',
  }
}

/* -------------------------------- draco ---------------------------------- */

const dracoLoader =
  new DRACOLoader()

dracoLoader.setDecoderPath(
  '/draco/',
)

dracoLoader.setDecoderConfig({
  type:
    'wasm',
})

/* ------------------------------ tone mapping ----------------------------- */

const TONE_MAPPING: Record<
  string,
  THREE.ToneMapping
> = {
  None:
    THREE.NoToneMapping,

  AgX:
    THREE.AgXToneMapping,

  Neutral:
    THREE.NeutralToneMapping,

  ACES:
    THREE.ACESFilmicToneMapping,
}

/* --------------------------------- types --------------------------------- */

type MaterialMode =
  | 'GI only'
  | 'PBR + baked GI'
  | 'UV debug'
  | 'plain white'

type SceneControls = {
  materialMode:
    MaterialMode

  bakedGiEnabled:
    boolean

  lightMapIntensity:
    number

  lightMapChannel:
    number

  lightMapFlipY:
    boolean

  lightMapSRGB:
    boolean

  toneMapping:
    THREE.ToneMapping

  exposure:
    number

  background:
    string

  environmentEnabled:
    boolean

  environmentAsBackground:
    boolean

  environmentIntensity:
    number

  environmentRotation:
    number

  backgroundRotation:
    number

  backgroundIntensity:
    number

  floorEnvIntensity:
    number

  wallEnvIntensity:
    number

  roofEnvIntensity:
    number

  woodEnvIntensity:
    number

  metalEnvIntensity:
    number

  floorRoughness:
    number

  wallRoughness:
    number

  roofRoughness:
    number

  tileNormalStrength:
    number

  woodRoughness:
    number

  woodMetalness:
    number

  woodNormalStrength:
    number

  allFromGlb:
    boolean

  aoEnabled:
    boolean

  aoMapIntensity:
    number

  metalColor:
    string

  metalRoughness:
    number

  metalness:
    number
}

type PbrSet = {
  color:
    THREE.Texture

  normal:
    THREE.Texture

  roughness?:
    THREE.Texture
}

type MeshReport = {
  meshCount:
    number

  uv1Count:
    number

  unmatched:
    string[]
}

/* ------------------------------- renderer -------------------------------- */

function RendererSettings({
  toneMapping,
  exposure,
}: {
  toneMapping:
    THREE.ToneMapping

  exposure:
    number
}) {
  const {
    gl,
  } =
    useThree()

  useEffect(() => {
    gl.outputColorSpace =
      THREE.SRGBColorSpace

    gl.toneMapping =
      toneMapping

    gl.toneMappingExposure =
      exposure
  }, [
    gl,
    toneMapping,
    exposure,
  ])

  return null
}

/* ------------------------ environment scene settings --------------------- */

/**
 * Drei <Environment /> assigns room_env.exr to scene.environment.
 *
 * Writing these settings directly to Scene keeps Leva reflection rotation
 * responsive and independent from the visible background rotation.
 */
function EnvironmentSceneSettings({
  controls,
}: {
  controls:
    SceneControls
}) {
  const {
    scene,
  } =
    useThree()

  useEffect(() => {
    scene.environmentIntensity =
      controls.environmentIntensity

    scene.environmentRotation.set(
      0,
      THREE.MathUtils.degToRad(
        controls.environmentRotation,
      ),
      0,
    )

    scene.backgroundIntensity =
      controls.backgroundIntensity

    scene.backgroundRotation.set(
      0,
      THREE.MathUtils.degToRad(
        controls.backgroundRotation,
      ),
      0,
    )
  }, [
    scene,

    controls.environmentIntensity,
    controls.environmentRotation,

    controls.backgroundIntensity,
    controls.backgroundRotation,
  ])

  return null
}

/* ---------------------------- texture helpers ---------------------------- */

function configurePbrTexture(
  texture:
    THREE.Texture,

  colorSpace:
    THREE.ColorSpace,
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
  texture:
    THREE.Texture,

  channel:
    number,

  flipY:
    boolean,

  colorSpace:
    THREE.ColorSpace,
) {
  texture.flipY =
    flipY

  texture.channel =
    channel

  texture.colorSpace =
    colorSpace

  texture.wrapS =
    THREE.ClampToEdgeWrapping

  texture.wrapT =
    THREE.ClampToEdgeWrapping

  texture.needsUpdate =
    true
}

function reflectionIntensityForGroup(
  group:
    Group,

  controls:
    SceneControls,
) {
  switch (
    group
  ) {
    case 'floor':
      return controls
        .floorEnvIntensity

    case 'wall':
      return controls
        .wallEnvIntensity

    case 'roof':
      return controls
        .roofEnvIntensity

    case 'wood':
      return controls
        .woodEnvIntensity

    case 'metal':
      return controls
        .metalEnvIntensity

    default:
      return controls
        .wallEnvIntensity
  }
}

/* --------------------------------- room ---------------------------------- */

function BakedRoom({
  controls,
  onReport,
}: {
  controls:
    SceneControls

  onReport: (
    report:
      MeshReport,
  ) => void
}) {
  const gltf =
    useLoader(
      GLTFLoader,
      MODEL_URL,
      (
        loader,
      ) => {
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
  ] =
    useLoader(
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
  ] =
    useLoader(
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
        color:
          floorColor,

        normal:
          floorNormal,
      }),
      [
        floorColor,
        floorNormal,
      ],
    )

  const roofSet =
    useMemo<PbrSet>(
      () => ({
        color:
          roofColor,

        normal:
          roofNormal,

        roughness:
          roofRoughness,
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
        color:
          wallColor,

        normal:
          wallNormal,

        roughness:
          wallRoughness,
      }),
      [
        wallColor,
        wallNormal,
        wallRoughness,
      ],
    )

  /* configure lightmaps and AO maps */
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

  /* configure PBR textures */
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

  /* build and attach materials */
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

    const pbrMode =
      controls.materialMode ===
      'PBR + baked GI'

    const applyLightMapAndReflection =
      (
        material:
          THREE.MeshStandardMaterial,

        group:
          Group,

        lightMap:
          THREE.Texture,
      ) => {
        material.lightMap =
          controls.bakedGiEnabled
            ? lightMap
            : null

        material.lightMapIntensity =
          controls.bakedGiEnabled
            ? controls.lightMapIntensity
            : 0

        /**
         * scene.environment supplies the room probe.
         * This value is a per-material reflection multiplier.
         */
        material.envMapIntensity =
          pbrMode
            ? reflectionIntensityForGroup(
                group,
                controls,
              )
            : 0

        material.needsUpdate =
          true

        return material
      }

    /**
     * Preserve imported BlenderKit wood textures while exposing the most useful
     * material properties in Leva.
     */
    const applyWoodOverrides =
      (
        material:
          THREE.MeshStandardMaterial,
      ) => {
        material.roughness =
          controls.woodRoughness

        material.metalness =
          controls.woodMetalness

        if (
          material.normalMap
        ) {
          material.normalScale.set(
            controls.woodNormalStrength,
            controls.woodNormalStrength,
          )
        }

        material.needsUpdate =
          true

        return material
      }

    const makeGiOnly =
      (
        lightMap:
          THREE.Texture,
      ) =>
        applyLightMapAndReflection(
          new THREE.MeshStandardMaterial({
            color:
              '#ffffff',

            roughness:
              1,

            metalness:
              0,

            side:
              THREE.FrontSide,
          }),

          'unknown',

          lightMap,
        )

    const makePbr =
      (
        textureSet:
          PbrSet,

        roughness:
          number,

        group:
          Group,

        lightMap:
          THREE.Texture,
      ) => {
        const material =
          new THREE.MeshStandardMaterial({
            color:
              '#ffffff',

            map:
              textureSet.color,

            normalMap:
              textureSet.normal,

            roughnessMap:
              textureSet.roughness ??
              null,

            roughness,

            metalness:
              0,

            side:
              THREE.FrontSide,
          })

        material.normalScale.set(
          controls.tileNormalStrength,
          controls.tileNormalStrength,
        )

        return applyLightMapAndReflection(
          material,
          group,
          lightMap,
        )
      }

    const fromGlb =
      (
        original:
          THREE.Material,

        group:
          Group,

        lightMap:
          THREE.Texture,
      ) => {
        const baseMaterial =
          Array.isArray(
            original,
          )
            ? original[0]
            : original

        const clone =
          baseMaterial.clone()

        const standardClone =
          clone as THREE.MeshStandardMaterial

        if (
          standardClone.isMeshStandardMaterial
        ) {
          applyLightMapAndReflection(
            standardClone,
            group,
            lightMap,
          )

          if (
            group ===
            'wood'
          ) {
            applyWoodOverrides(
              standardClone,
            )
          }
        }

        return clone
      }

    const makeMetal =
      (
        lightMap:
          THREE.Texture,
      ) =>
        applyLightMapAndReflection(
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

          'metal',

          lightMap,
        )

    const makeUvDebug =
      (
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

          envMapIntensity:
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

        /**
         * Remember the original GLB material once before replacing it.
         */
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
        } =
          classify(
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
              group,
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
              group,
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
              group,
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
              group,
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
              group,
              selectedLightMap,
            )
        }

        /**
         * AO remains optional and disabled by default.
         */
        const standardMaterial =
          material as THREE.MeshStandardMaterial

        if (
          standardMaterial.isMeshStandardMaterial &&
          controls.aoEnabled
        ) {
          standardMaterial.aoMap =
            lightmap ===
            'wood'
              ? woodAo
              : tileAo

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

    tileAo,
    woodAo,

    floorSet,
    roofSet,
    wallSet,

    onReport,

    controls.materialMode,

    controls.bakedGiEnabled,
    controls.lightMapIntensity,

    controls.floorEnvIntensity,
    controls.wallEnvIntensity,
    controls.roofEnvIntensity,
    controls.woodEnvIntensity,
    controls.metalEnvIntensity,

    controls.tileNormalStrength,

    controls.floorRoughness,
    controls.wallRoughness,
    controls.roofRoughness,

    controls.woodRoughness,
    controls.woodMetalness,
    controls.woodNormalStrength,

    controls.allFromGlb,

    controls.aoEnabled,
    controls.aoMapIntensity,

    controls.metalColor,
    controls.metalRoughness,
    controls.metalness,
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

/**
 * Frames only actual mesh geometry once after loading.
 * Environment textures do not affect camera bounds.
 */
function FrameOnce() {
  const {
    camera,
    scene,
    controls,
  } =
    useThree()

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

    scene.traverse(
      (
        object,
      ) => {
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
      ) ||
      1

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
        target?:
          THREE.Vector3

        update?:
          () => void
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
  controls:
    SceneControls

  onReport: (
    report:
      MeshReport,
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

      {controls.environmentEnabled ? (
        <>
          <Environment
            files={
              ROOM_ENV_URL
            }

            background={
              controls.environmentAsBackground
            }

            environmentIntensity={
              controls.environmentIntensity
            }

            backgroundIntensity={
              controls.backgroundIntensity
            }

            environmentRotation={[
              0,
              THREE.MathUtils.degToRad(
                controls.environmentRotation,
              ),
              0,
            ]}

            backgroundRotation={[
              0,
              THREE.MathUtils.degToRad(
                controls.backgroundRotation,
              ),
              0,
            ]}
          />

          <EnvironmentSceneSettings
            controls={
              controls
            }
          />
        </>
      ) : null}

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
  report:
    MeshReport
}) {
  const uv1Okay =
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
          uv1Okay
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

        {uv1Okay
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
  ] =
    useState<MeshReport>({
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
            'baked GI on',
        },

        lightMapIntensity: {
          value:
            1,

          min:
            0,

          max:
            3,

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

        roomEnvironment:
          folder({
            environmentEnabled: {
              value:
                true,

              label:
                'room environment on',
            },

            environmentAsBackground: {
              value:
                false,

              label:
                'show room panorama',
            },

            /**
             * The global multiplier affects reflections.
             *
             * Diffuse environment irradiance has been removed globally.
             */
            environmentIntensity: {
              value:
                1,

              min:
                0,

              max:
                5,

              step:
                0.01,

              label:
                'global reflection intensity',
            },

            environmentRotation: {
              value:
                0,

              min:
                0,

              max:
                360,

              step:
                1,

              label:
                'reflection rotation',
            },

            backgroundRotation: {
              value:
                0,

              min:
                0,

              max:
                360,

              step:
                1,

              label:
                'background rotation',
            },

            backgroundIntensity: {
              value:
                1,

              min:
                0,

              max:
                3,

              step:
                0.01,

              label:
                'background intensity',
            },
          }),

        reflectionByMaterial:
          folder({
            floorEnvIntensity: {
              value:
                1,

              min:
                0,

              max:
                3,

              step:
                0.01,

              label:
                'floor reflection',
            },

            wallEnvIntensity: {
              value:
                0.15,

              min:
                0,

              max:
                3,

              step:
                0.01,

              label:
                'wall reflection',
            },

            roofEnvIntensity: {
              value:
                0.1,

              min:
                0,

              max:
                3,

              step:
                0.01,

              label:
                'roof reflection',
            },

            woodEnvIntensity: {
              value:
                0.5,

              min:
                0,

              max:
                3,

              step:
                0.01,

              label:
                'wood reflection',
            },

            metalEnvIntensity: {
              value:
                1.2,

              min:
                0,

              max:
                5,

              step:
                0.01,

              label:
                'metal reflection',
            },
          }),

        tileMaterials:
          folder({
            floorRoughness: {
              value:
                0.25,

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
                0.65,

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
                0.75,

              min:
                0,

              max:
                1,

              step:
                0.01,

              label:
                'roof roughness',
            },

            tileNormalStrength: {
              value:
                1,

              min:
                0,

              max:
                2,

              step:
                0.01,

              label:
                'tile normal strength',
            },

            allFromGlb: {
              value:
                false,

              label:
                'all materials from GLB',
            },
          }),

        woodMaterial:
          folder({
            woodRoughness: {
              value:
                0.45,

              min:
                0,

              max:
                1,

              step:
                0.01,

              label:
                'wood roughness',
            },

            /**
             * Real wood is dielectric. Keep this at zero unless intentionally
             * testing an unusual material.
             */
            woodMetalness: {
              value:
                0,

              min:
                0,

              max:
                1,

              step:
                0.01,

              label:
                'wood metalness',
            },

            woodNormalStrength: {
              value:
                1,

              min:
                0,

              max:
                2,

              step:
                0.01,

              label:
                'wood normal strength',
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
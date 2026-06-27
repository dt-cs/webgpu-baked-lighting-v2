/**
 * config.ts
 * Constants, shared types, and the Leva control schema.
 *
 * Current direction:
 *   - baked black-background scene
 *   - no reflector / BPCEM / DOF controls
 *   - one concrete PBR set reused across floor, wall/background, and roof
 *   - grouped lightmaps: background, floor, roof
 */
import * as THREE from 'three/webgpu'
import { folder } from 'leva'

/* ======================================================================
 * 1. CONSTANTS
 * =================================================================== */
export const MODEL_URL       = '/assets/lightmaps.glb'
export const TEST_MODELS_URL = '/assets/test_models.glb'
export const WINDOW_URL      = '/assets/window.glb'

// Kept only so older imports do not break while BakedRoom is being cleaned.
// The reflector path is not used in the new no-reflection direction.
export const REFLECTOR_URL = '/assets/reflector.glb'

// Grouped baked GI textures from the new Blender export.
export const BG_LIGHTMAP_URL    = '/assets/LM_Bake_bg.png'
export const FLOOR_LIGHTMAP_URL = '/assets/LM_Bake_floor.png'
export const ROOF_LIGHTMAP_URL  = '/assets/LM_Bake_roof.png'

// Grouped AO textures. There is no separate bg AO yet, so background/wall uses floor AO for now.
export const BG_AO_URL    = '/assets/AO_floor.png'
export const FLOOR_AO_URL = '/assets/AO_floor.png'
export const ROOF_AO_URL  = '/assets/AO_roof.png'

// Compatibility aliases for the existing BakedRoom import names.
// These will be removed after BakedRoom is patched to the grouped names above.
export const TILE_LIGHTMAP_URL = BG_LIGHTMAP_URL
export const WOOD_LIGHTMAP_URL = BG_LIGHTMAP_URL
export const TILE_AO_URL       = BG_AO_URL
export const WOOD_AO_URL       = BG_AO_URL

// This EXR is no longer part of the final black-background look, but Scene may still import it.
export const FOREST_EXR_URL = '/hdr/fall-forest-dirt-road_2K_e53f34e1-5505-4646-adfa-a7d03f4259eb.exr'

// One concrete PBR set for all architectural surfaces.
export const CONCRETE_COLOR_URL     = '/pbr/concrete/ConcreteClean01_Base_Color1K.jpg'
export const CONCRETE_NORMAL_URL    = '/pbr/concrete/ConcreteClean01_NormalGL1K.png'
export const CONCRETE_ROUGHNESS_URL = '/pbr/concrete/ConcreteClean01_PBRset1K.png'

// Compatibility aliases for existing BakedRoom names.
export const FLOOR_COLOR_URL     = CONCRETE_COLOR_URL
export const FLOOR_NORMAL_URL    = CONCRETE_NORMAL_URL
export const ROOF_COLOR_URL      = CONCRETE_COLOR_URL
export const ROOF_NORMAL_URL     = CONCRETE_NORMAL_URL
export const ROOF_ROUGHNESS_URL  = CONCRETE_ROUGHNESS_URL
export const WALL_COLOR_URL      = CONCRETE_COLOR_URL
export const WALL_NORMAL_URL     = CONCRETE_NORMAL_URL
export const WALL_ROUGHNESS_URL  = CONCRETE_ROUGHNESS_URL

/** Black-background scene. Skybox rotation is kept only for compatibility. */
export const SKYBOX_ROTATION_Y_RAD = THREE.MathUtils.degToRad(277)

/** Room AABB placeholder. Recalculate after the new GLB is framed if BPCEM returns later. */
export const CUBEMAP_SIZE = new THREE.Vector3(168.687, 68.251, 100.167)
export const CUBEMAP_POS  = new THREE.Vector3(0, 0, 0)

export const TONE_MAPPING: Record<string, THREE.ToneMapping> = {
  None:     THREE.NoToneMapping,
  Linear:   THREE.LinearToneMapping,
  Reinhard: THREE.ReinhardToneMapping,
  Cineon:   THREE.CineonToneMapping,
  ACES:     THREE.ACESFilmicToneMapping,
  AgX:      THREE.AgXToneMapping,
  Neutral:  THREE.NeutralToneMapping,
}

/** LUT .cube files for color grading. Disabled by default for the clean Figma look. */
export const LUT_FILES: Record<string, string> = {
  'None':                          '',
  'Fujifilm 3510 D65':             '/cube/Rec709_Fujifilm_3510_D65.cube',
  'Kodak 2383 D65':                '/cube/Rec709_Kodak_2383_D65.cube',
  'Kodak 2393 D65':                '/cube/Rec709_Kodak_2393_D65.cube',
}

/* ======================================================================
 * 2. TYPES
 * =================================================================== */
export type Group = 'floor' | 'wall' | 'roof' | 'unknown'

// Kept as-is until BakedRoom is patched away from the old tile/wood branching.
export type Atlas = 'tile' | 'wood'

export type MaterialMode = 'GI only' | 'PBR + baked GI' | 'UV debug'

export type PbrSet = { color: THREE.Texture; normal: THREE.Texture; roughness?: THREE.Texture }
export type MeshReport = { meshCount: number; uv1Count: number; unmatched: string[] }

export type SceneControls = {
  // material / lightmap
  materialMode:      MaterialMode
  bakedGiEnabled:    boolean
  lightMapIntensity: number
  lightMapChannel:   number
  lightMapFlipY:     boolean
  lightMapSRGB:      boolean

  // rendering
  toneMapping: THREE.ToneMapping
  exposure:    number
  cameraFov:   number

  // reflections kept for compatibility, hard-disabled by flattenControls.
  reflectionsEnabled: boolean
  reflectorEnabled:   boolean
  reflectorYOffset:   number
  reflectorTargetRotX: number
  reflectorTargetRotY: number
  reflectorTargetRotZ: number

  // synced surface controls
  floorRoughness: number
  wallRoughness:  number
  roofRoughness:  number
  floorNormalScale: number
  wallNormalScale:  number
  roofNormalScale:  number

  aoEnabled: boolean
  allFromGlb: boolean

  // test models
  modelX: number
  modelY: number
  modelZ: number
  modelScale: number

  // directional
  dirLightX: number; dirLightY: number; dirLightZ: number
  dirLightColor: string; dirLightIntensity: number

  // spotlight
  spotEnabled: boolean
  spotX: number; spotY: number; spotZ: number
  spotTargetX: number; spotTargetY: number; spotTargetZ: number
  spotColor: string; spotIntensity: number
  spotAngle: number; spotPenumbra: number; spotDecay: number; spotDistance: number
  shadowNear: number; shadowFar: number; shadowFocus: number; shadowIntensity: number
  showHelper: boolean

  // light probe kept for compatibility, hard-disabled by flattenControls.
  lightProbeIntensity: number
  showProbeHelper: boolean

  // shadow catcher
  shadowPlaneOpacity: number

  // color grading LUT kept for compatibility, disabled by default.
  lutName: string
  lutIntensity: number

  // depth of field kept for compatibility, hard-disabled by flattenControls.
  dofEnabled: boolean
  dofFocusDistance: number
  dofFocalLength: number
  dofBokehScale: number
}

/* ======================================================================
 * 3. LEVA SCHEMA + FLATTEN
 * =================================================================== */
export const levaSchema = {
  materialMode: { value: 'PBR + baked GI', options: ['GI only', 'PBR + baked GI', 'UV debug'], label: 'material mode' },
  bakedGiEnabled:    { value: true,  label: 'baked GI on' },
  lightMapIntensity: { value: 1, min: 0, max: 3, step: 0.05, label: 'lightmap intensity' },
  lightMapChannel:   { value: 1, options: { 'uv1 / channel 1': 1, 'uv / channel 0': 0 }, label: 'lightmap channel' },
  lightMapFlipY:     { value: false, label: 'lightmap flipY' },
  lightMapSRGB:      { value: true,  label: 'lightmap sRGB' },

  rendering: folder({
    toneMapping: { value: 'None', options: Object.keys(TONE_MAPPING), label: 'tone mapping' },
    exposure:    { value: 1, min: 0.1, max: 2, step: 0.01 },
    cameraFov:   { value: 24, min: 10, max: 90, step: 1, label: 'camera FOV' },
  }),

  ao: folder({
    aoEnabled: { value: true, label: 'AO on' },
  }),

  surface: folder({
    floorRoughness:   { value: 0.72, min: 0, max: 1, step: 0.01, label: 'floor roughness' },
    floorNormalScale: { value: 0.55, min: 0, max: 2, step: 0.01, label: 'floor normal' },
    wallRoughness:    { value: 0.78, min: 0, max: 1, step: 0.01, label: 'wall roughness' },
    wallNormalScale:  { value: 0.45, min: 0, max: 2, step: 0.01, label: 'wall normal' },
    roofRoughness:    { value: 0.82, min: 0, max: 1, step: 0.01, label: 'roof roughness' },
    roofNormalScale:  { value: 0.55, min: 0, max: 2, step: 0.01, label: 'roof normal' },
    allFromGlb:       { value: false, label: 'all from GLB' },
  }),

  testModels: folder({
    modelX:     { value: 16.5,  min: -200, max: 200, step: 0.5,  label: 'model X' },
    modelY:     { value: -36.3, min: -100, max: 100, step: 0.1,  label: 'model Y' },
    modelZ:     { value: -13.0, min: -200, max: 200, step: 0.5,  label: 'model Z' },
    modelScale: { value: 1,     min: 0.01, max: 10,  step: 0.01, label: 'model scale' },
  }),

  directional: folder({
    dirLightX: { value: -80, min: -300, max: 300, step: 1, label: 'dir light X' },
    dirLightY: { value: 40, min: -100, max: 300, step: 1, label: 'dir light Y' },
    dirLightZ: { value: 120, min: -300, max: 300, step: 1, label: 'dir light Z' },
    dirLightColor: { value: '#fff8f0', label: 'dir light color' },
    dirLightIntensity: { value: 0, min: 0, max: 20, step: 0.1, label: 'dir light intensity' },
  }),

  spotlight: folder({
    spotEnabled: { value: true, label: 'spotlight on' },
    spotX: { value: 16.5, min: -200, max: 200, step: 1, label: 'light X' },
    spotY: { value: 20, min: -100, max: 200, step: 1, label: 'light Y' },
    spotZ: { value: -13.0, min: -200, max: 200, step: 1, label: 'light Z' },
    spotTargetX: { value: 16.5, min: -200, max: 200, step: 1, label: 'target X' },
    spotTargetY: { value: -36.0, min: -100, max: 50, step: 1, label: 'target Y' },
    spotTargetZ: { value: -13.0, min: -200, max: 200, step: 1, label: 'target Z' },
    spotColor: { value: '#ffffff', label: 'color' },
    spotIntensity: { value: 1000, min: 0, max: 50000, step: 10, label: 'intensity' },
    spotAngle: { value: 0.4, min: 0.01, max: 1.05, step: 0.01, label: 'angle (rad)' },
    spotPenumbra: { value: 0.5, min: 0, max: 1, step: 0.01, label: 'penumbra' },
    spotDecay: { value: 2, min: 0, max: 2, step: 0.1, label: 'decay' },
    spotDistance: { value: 0, min: 0, max: 500, step: 1, label: 'distance (0=inf)' },
    shadowNear: { value: 10, min: 0.1, max: 100, step: 0.5, label: 'shadow near' },
    shadowFar: { value: 80, min: 10, max: 500, step: 1, label: 'shadow far' },
    shadowFocus: { value: 1, min: 0, max: 1, step: 0.01, label: 'shadow focus' },
    shadowIntensity: { value: 1, min: 0, max: 1, step: 0.01, label: 'shadow intensity' },
    showHelper: { value: false, label: 'show helper' },
    shadowPlaneOpacity: { value: 0.5, min: 0, max: 1, step: 0.01, label: 'shadow plane opacity' },
  }),
}

/** Flatten Leva's nested folder output into a typed SceneControls. */
export function flattenControls(raw: Record<string, unknown>): SceneControls {
  const r = raw as any
  const pick = (k: string) => r[k] ?? r.rendering?.[k] ?? r.ao?.[k]
    ?? r.surface?.[k] ?? r.testModels?.[k] ?? r.directional?.[k] ?? r.spotlight?.[k]

  return {
    materialMode:      r.materialMode,
    bakedGiEnabled:    r.bakedGiEnabled,
    lightMapIntensity: r.lightMapIntensity,
    lightMapChannel:   r.lightMapChannel,
    lightMapFlipY:     r.lightMapFlipY,
    lightMapSRGB:      r.lightMapSRGB,
    toneMapping:       TONE_MAPPING[pick('toneMapping') ?? 'None'],
    exposure:          pick('exposure'),
    cameraFov:         pick('cameraFov'),

    // Disabled direction: no reflector, no BPCEM, no DOF.
    reflectionsEnabled: false,
    reflectorEnabled:   false,
    reflectorYOffset:   0,
    reflectorTargetRotX: -90,
    reflectorTargetRotY: 0,
    reflectorTargetRotZ: 0,

    floorRoughness:   pick('floorRoughness'),
    wallRoughness:    pick('wallRoughness'),
    roofRoughness:    pick('roofRoughness'),
    floorNormalScale: pick('floorNormalScale'),
    wallNormalScale:  pick('wallNormalScale'),
    roofNormalScale:  pick('roofNormalScale'),
    aoEnabled:        pick('aoEnabled'),
    allFromGlb:       pick('allFromGlb'),

    modelX: pick('modelX'), modelY: pick('modelY'), modelZ: pick('modelZ'), modelScale: pick('modelScale'),

    dirLightX: pick('dirLightX'), dirLightY: pick('dirLightY'), dirLightZ: pick('dirLightZ'),
    dirLightColor: pick('dirLightColor'), dirLightIntensity: pick('dirLightIntensity'),

    spotEnabled: pick('spotEnabled'),
    spotX: pick('spotX'), spotY: pick('spotY'), spotZ: pick('spotZ'),
    spotTargetX: pick('spotTargetX'), spotTargetY: pick('spotTargetY'), spotTargetZ: pick('spotTargetZ'),
    spotColor: pick('spotColor'), spotIntensity: pick('spotIntensity'),
    spotAngle: pick('spotAngle'), spotPenumbra: pick('spotPenumbra'),
    spotDecay: pick('spotDecay'), spotDistance: pick('spotDistance'),
    shadowNear: pick('shadowNear'), shadowFar: pick('shadowFar'),
    shadowFocus: pick('shadowFocus'), shadowIntensity: pick('shadowIntensity'),
    showHelper: pick('showHelper'),

    lightProbeIntensity: 0,
    showProbeHelper: false,
    shadowPlaneOpacity: pick('shadowPlaneOpacity'),

    lutName: 'None',
    lutIntensity: 0,

    dofEnabled: false,
    dofFocusDistance: 120,
    dofFocalLength: 50,
    dofBokehScale: 3,
  }
}

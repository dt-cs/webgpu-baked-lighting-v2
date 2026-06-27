/**
 * config.ts
 * Constants, shared types, and the Leva control schema — all in one file
 * because they change together: add a control -> add a type field -> maybe add
 * a constant. Sections: (1) constants (2) types (3) leva schema + flatten.
 */
import * as THREE from 'three/webgpu'
import { folder } from 'leva'

/* ======================================================================
 * 1. CONSTANTS
 * =================================================================== */
export const MODEL_URL         = '/assets/simple_bake_01.glb'
export const TEST_MODELS_URL   = '/assets/test_models.glb'
//export const HTML_URL          = '/assets/html.glb'
export const REFLECTOR_URL     = '/assets/reflector.glb'
export const WINDOW_URL         = '/assets/window.glb'
export const TILE_LIGHTMAP_URL = '/assets/bake_black_tile.png'
export const WOOD_LIGHTMAP_URL = '/assets/wood_lm.png'
export const TILE_AO_URL       = '/assets/ao_tile.png'
export const WOOD_AO_URL       = '/assets/ao_wood.png'
export const FOREST_EXR_URL    = '/hdr/fall-forest-dirt-road_2K_e53f34e1-5505-4646-adfa-a7d03f4259eb.exr'

export const FLOOR_COLOR_URL    = '/pbr/floor/tiles-11_diffuse.jpg'
export const FLOOR_NORMAL_URL   = '/pbr/floor/tiles-11_normal.jpg'
export const ROOF_COLOR_URL     = '/pbr/roof/concrete_04_color.jpg'
export const ROOF_NORMAL_URL    = '/pbr/roof/concrete_04_normal.jpg'
export const ROOF_ROUGHNESS_URL = '/pbr/roof/concrete_04_roughness.jpg'
export const WALL_COLOR_URL     = '/pbr/wall/tiles10_diffuse.jpg'
export const WALL_NORMAL_URL    = '/pbr/wall/tiles10_normal_opengl.jpg'
export const WALL_ROUGHNESS_URL = '/pbr/wall/tiles10_roughness.jpg'

/** Blender world mapping Z = 277° — matches the bake orientation. */
export const SKYBOX_ROTATION_Y_RAD = THREE.MathUtils.degToRad(277)

/** Room interior AABB from new_floor.001 (metres). Room recentred at origin. */
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

/** LUT .cube files for color grading (post-process, applied after tone mapping). */
export const LUT_FILES: Record<string, string> = {
  'None':                          '',
  'Fujifilm 3510 D65':             '/cube/Rec709_Fujifilm_3510_D65.cube',
  'Kodak 2383 D65':                '/cube/Rec709_Kodak_2383_D65.cube',
  'Kodak 2393 D65':                '/cube/Rec709_Kodak_2393_D65.cube',
}

/* ======================================================================
 * 2. TYPES
 * =================================================================== */
export type Group = 'floor' | 'wall' | 'roof' | 'wood' | 'metal' | 'unknown'
export type Atlas = 'tile' | 'wood'
export type MaterialMode = 'GI only' | 'PBR + baked GI' | 'UV debug'

export type PbrSet = { color: THREE.Texture; normal: THREE.Texture; roughness?: THREE.Texture }
export type MeshReport = { meshCount: number; uv1Count: number; unmatched: string[] }

/**
 * SceneControls — the flattened control object passed to all scene components.
 * Trimmed: no per-group env intensity, no global reflection, no cubemap offsets,
 * no background colour, no reflector UV editing, no AO intensity, no debug modes.
 * Roughness and normal-scale per group now drive BOTH the PBR material and the
 * reflector mask/distortion (single source of truth).
 */
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

  // reflections
  reflectionsEnabled: boolean
  reflectorEnabled:   boolean
  reflectorYOffset:   number
  reflectorTargetRotX: number
  reflectorTargetRotY: number
  reflectorTargetRotZ: number

  // synced roughness (drives material roughness + reflector gloss mask)
  floorRoughness: number
  wallRoughness:  number
  roofRoughness:  number

  // synced normal scale (drives material normalScale + reflector distortion)
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

  // light probe
  lightProbeIntensity: number
  showProbeHelper: boolean

  // shadow catcher
  shadowPlaneOpacity: number

  // color grading LUT
  lutName: string
  lutIntensity: number

  // depth of field
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

  colorGrading: folder({
    lutName:      { value: 'None', options: Object.keys(LUT_FILES), label: 'LUT' },
    lutIntensity: { value: 1, min: 0, max: 1, step: 0.01, label: 'LUT intensity' },
  }),

  depthOfField: folder({
    dofEnabled:       { value: false, label: 'DOF on' },
    dofFocusDistance: { value: 120,  min: 1,   max: 1000, step: 1,   label: 'focus distance' },
    dofFocalLength:   { value: 50,   min: 5,   max: 400,  step: 1,   label: 'focal length' },
    dofBokehScale:    { value: 3,    min: 0,   max: 20,   step: 0.1, label: 'bokeh scale' },
  }),

  reflections: folder({
    reflectionsEnabled: { value: true, label: 'reflections on' },
    reflectorEnabled:   { value: true, label: 'GLB reflector on' },
    reflectorYOffset:   { value: 0.015, min: -0.2, max: 0.2, step: 0.001, label: 'reflector Y offset' },
    reflectorTargetRotX: { value: -90, min: -180, max: 180, step: 1, label: 'target rot X' },
    reflectorTargetRotY: { value: 0,   min: -180, max: 180, step: 1, label: 'target rot Y' },
    reflectorTargetRotZ: { value: 0,   min: -180, max: 180, step: 1, label: 'target rot Z' },
  }),

  ao: folder({
    aoEnabled: { value: true, label: 'AO on' },
  }),

  surface: folder({
    floorRoughness:   { value: 0.2,  min: 0, max: 1, step: 0.01, label: 'floor roughness' },
    floorNormalScale: { value: 1,    min: 0, max: 2, step: 0.01, label: 'floor normal' },
    wallRoughness:    { value: 0.5,  min: 0, max: 1, step: 0.01, label: 'wall roughness' },
    wallNormalScale:  { value: 1,    min: 0, max: 2, step: 0.01, label: 'wall normal' },
    roofRoughness:    { value: 0.85, min: 0, max: 1, step: 0.01, label: 'roof roughness' },
    roofNormalScale:  { value: 1,    min: 0, max: 2, step: 0.01, label: 'roof normal' },
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
    dirLightIntensity: { value: 3.0, min: 0, max: 20, step: 0.1, label: 'dir light intensity' },
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

  lightProbe: folder({
    lightProbeIntensity: { value: 1, min: 0, max: 2, step: 0.02, label: 'probe intensity' },
    showProbeHelper:     { value: false, label: 'show probe helper' },
  }),
}

/** Flatten leva's nested folder output into a typed SceneControls. */
export function flattenControls(raw: Record<string, unknown>): SceneControls {
  const r = raw as any
  const pick = (k: string) => r[k] ?? r.rendering?.[k] ?? r.colorGrading?.[k] ?? r.reflections?.[k] ?? r.ao?.[k]
    ?? r.surface?.[k] ?? r.testModels?.[k] ?? r.directional?.[k] ?? r.spotlight?.[k]
    ?? r.lightProbe?.[k] ?? r.depthOfField?.[k]

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
    reflectionsEnabled: pick('reflectionsEnabled'),
    reflectorEnabled:   pick('reflectorEnabled'),
    reflectorYOffset:   pick('reflectorYOffset'),
    reflectorTargetRotX: pick('reflectorTargetRotX'),
    reflectorTargetRotY: pick('reflectorTargetRotY'),
    reflectorTargetRotZ: pick('reflectorTargetRotZ'),
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
    lightProbeIntensity: pick('lightProbeIntensity'),
    showProbeHelper: pick('showProbeHelper'),
    shadowPlaneOpacity: pick('shadowPlaneOpacity'),
    lutName:      pick('lutName'),
    lutIntensity: pick('lutIntensity'),
    dofEnabled:       pick('dofEnabled'),
    dofFocusDistance: pick('dofFocusDistance'),
    dofFocalLength:   pick('dofFocalLength'),
    dofBokehScale:    pick('dofBokehScale'),
  }
}
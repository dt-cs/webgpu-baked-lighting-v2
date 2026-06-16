/**
 * watercolorEffect.ts
 * TSL port of a four-stage anisotropic Kuwahara "watercolor" post chain.
 *
 * Original WebGL/postprocessing passes ported 1:1:
 *   1. tensor    Sobel -> structure tensor (Jxx, Jyy, Jxy)
 *   2. kuwahara  anisotropic Kuwahara, reads tensor + ORIGINAL scene color
 *   3. final     quantize + saturate + ACES + watercolor texture multiply
 *
 * Notes on the port:
 *   - The GLSL used gl_FragCoord + resolution.xy for pixel stepping. Here the
 *     step is screenSize-derived and offsets are applied in UV space.
 *   - The kuwahara pass samples the original scene color (originalTexture in
 *     the GLSL), NOT the tensor. The tensor only drives orientation.
 *   - The GLSL emitted fromLinear() at the end of the kuwahara pass to undo a
 *     linear->sRGB step. In the TSL/WebGPU pipeline the output transform is
 *     handled by the renderer, so that manual sRGB encode is dropped here and
 *     the final-stage output is left linear for the pipeline to encode.
 */
import {
  Fn,
  vec2,
  vec3,
  vec4,
  float,
  int,
  mat2,
  uv,
  screenSize,
  dot,
  abs,
  sqrt,
  max,
  normalize,
  mix,
  clamp,
  floor,
  cos,
  sin,
  Loop,
} from 'three/tsl'
import type { TextureNode } from 'three/tsl'

const LUMA = vec3(0.299, 0.587, 0.114)

/* ---------------------- stage 1: structure tensor ------------------------ */
/**
 * Sobel-based structure tensor of `colorNode`.
 * Returns vec4(dot(Sx,Sx), dot(Sy,Sy), dot(Sx,Sy), 1.0).
 */
export const tensorNode = (colorNode: TextureNode) =>
  Fn(() => {
    const px = vec2(1.0).div(screenSize)
    // render-target sample is Y-flipped relative to screen; flip V once here
    // so all neighbor offsets inherit the corrected base.
    const vUv = vec2(uv().x, uv().y.oneMinus())

    const s = (dx: number, dy: number) =>
      colorNode.sample(vUv.add(vec2(float(dx), float(dy)).mul(px))).rgb

    const tx0y0 = s(-1, -1)
    const tx0y1 = s(-1, 0)
    const tx0y2 = s(-1, 1)
    const tx1y0 = s(0, -1)
    const tx1y2 = s(0, 1)
    const tx2y0 = s(1, -1)
    const tx2y1 = s(1, 0)
    const tx2y2 = s(1, 1)

    // Gx = [-1 0 1; -2 0 2; -1 0 1]  (column-major in original, equivalent here)
    const Sx = tx2y0
      .add(tx2y1.mul(2.0))
      .add(tx2y2)
      .sub(tx0y0)
      .sub(tx0y1.mul(2.0))
      .sub(tx0y2)

    // Gy = [-1 -2 -1; 0 0 0; 1 2 1]
    const Sy = tx0y2
      .add(tx1y2.mul(2.0))
      .add(tx2y2)
      .sub(tx0y0)
      .sub(tx1y0.mul(2.0))
      .sub(tx2y0)

    return vec4(dot(Sx, Sx), dot(Sy, Sy), dot(Sx, Sy), 1.0)
  })()

/* ----------------- stage 2: anisotropic Kuwahara ------------------------- */
/**
 * @param tensorTex  texture node holding the stage-1 structure tensor
 * @param originalTex texture node holding the original scene color
 * @param radius     kuwahara sampling radius (float node or number)
 */
export const kuwaharaNode = (
  tensorTex: TextureNode,
  originalTex: TextureNode,
  radius: ReturnType<typeof float>,
) =>
  Fn(() => {
    const SECTOR_COUNT = 8
    const px = vec2(1.0).div(screenSize)
    // flip V to match the render-target orientation (see tensorNode note).
    const vUv = vec2(uv().x, uv().y.oneMinus())

    const structureTensor = tensorTex.sample(vUv)

    // --- dominant orientation (eigen-decomposition of 2x2 tensor) ---
    const Jxx = structureTensor.r
    const Jyy = structureTensor.g
    const Jxy = structureTensor.b
    const trace = Jxx.add(Jyy)
    const determinant = Jxx.mul(Jyy).sub(Jxy.mul(Jxy))
    const disc = sqrt(trace.mul(trace).mul(0.25).sub(determinant))
    const lambda1 = trace.mul(0.5).add(disc)
    const lambda2 = trace.mul(0.5).sub(disc)

    const jxyStrength = abs(Jxy).div(
      abs(Jxx).add(abs(Jyy)).add(abs(Jxy)).add(1e-6),
    )

    const orientation = jxyStrength.greaterThan(0.0).select(
      normalize(vec2(Jxy.negate(), Jxx.sub(lambda1))),
      vec2(0.0, 1.0),
    ).toVar()

    const anisotropy = lambda1.sub(lambda2).div(lambda1.add(lambda2).add(1e-6))
    const alpha = float(25.0)
    const scaleX = alpha.div(anisotropy.add(alpha))
    const scaleY = anisotropy.add(alpha).div(alpha)

    // mat2(o.x,-o.y,o.y,o.x) * mat2(scaleX,0,0,scaleY)
    const ox = orientation.x
    const oy = orientation.y
    const anisotropyMat = mat2(
      ox.mul(scaleX),
      oy.negate().mul(scaleY),
      oy.mul(scaleX),
      ox.mul(scaleY),
    )

    const eta = float(0.1)
    const lambda = float(0.5)

    const minVariance = float(1e20).toVar()
    const finalColor = vec3(0.0).toVar()

    // Sector loop. Index exposed as `i`; counters that need a non-1 step or a
    // negative start use explicit .toVar() counters with the condition form,
    // since the named-index form only provides i/j/k and integer-ish stepping.
    Loop({ start: int(0), end: int(SECTOR_COUNT), type: 'int' }, ({ i }) => {
      const angle = float(i).mul(6.28318).div(float(SECTOR_COUNT))

      const weightedColorSum = vec3(0.0).toVar()
      const weightedSquaredColorSum = vec3(0.0).toVar()
      const totalWeight = float(0.0).toVar()

      const r = float(1.0).toVar()
      Loop(r.lessThanEqual(radius), () => {
        // inner angular sweep: -0.392699 .. 0.392699 step 0.196349 (5 taps)
        const a = float(-0.392699).toVar()
        Loop(a.lessThanEqual(0.392699), () => {
          const dir = vec2(cos(angle.add(a)), sin(angle.add(a)))
          const off0 = dir.mul(r)
          const sampleOffset = anisotropyMat.mul(off0)

          const sampleUv = vUv.add(sampleOffset.mul(px))
          const color = originalTex.sample(sampleUv).rgb

          // polynomialWeight(x, y, eta, lambda)
          const polyValue = sampleOffset.x.add(eta).sub(lambda.mul(sampleOffset.y.mul(sampleOffset.y)))
          const weight = max(0.0, polyValue.mul(polyValue))

          weightedColorSum.addAssign(color.mul(weight))
          weightedSquaredColorSum.addAssign(color.mul(color).mul(weight))
          totalWeight.addAssign(weight)

          a.addAssign(0.196349)
        })
        r.addAssign(1.0)
      })

      const avgColor = weightedColorSum.div(totalWeight)
      const varianceRes = weightedSquaredColorSum.div(totalWeight).sub(avgColor.mul(avgColor))
      const variance = dot(varianceRes, LUMA)

      // keep the sector with the lowest luminance variance
      const isLower = variance.lessThan(minVariance)
      minVariance.assign(isLower.select(variance, minVariance))
      finalColor.assign(isLower.select(avgColor, finalColor))
    })

    return vec4(finalColor, 1.0)
  })()

/* --------------------- stage 3: final composite -------------------------- */

const ACESFilm = Fn(([x]: [ReturnType<typeof vec3>]) => {
  const a = float(2.51)
  const b = float(0.03)
  const c = float(2.43)
  const d = float(0.59)
  const e = float(0.14)
  return clamp(
    x.mul(a.mul(x).add(b)).div(x.mul(c.mul(x).add(d)).add(e)),
    0.0,
    1.0,
  )
})

const sat = Fn(([rgb, adjustment]: [ReturnType<typeof vec3>, ReturnType<typeof float>]) => {
  const W = vec3(0.2125, 0.7154, 0.0721)
  const intensity = vec3(dot(rgb, W))
  return mix(intensity, rgb, adjustment)
})

/* ------------- fused stage 2+3: kuwahara then final composite ------------ */
/**
 * Fuses kuwahara and final into one fragment graph. Final reads kuwahara's
 * per-pixel value directly (no extra texture sample / render target needed),
 * which is valid because final only ever used the same pixel.
 *
 * @param tensorTex   structure tensor texture (stage 1 output)
 * @param originalTex original scene color texture
 * @param radius      kuwahara sampling radius
 * @param opts.stylize    apply quantize + saturate + ACES block (default false)
 * @param opts.watercolor optional watercolor texture; multiplied in if supplied
 */
export const kuwaharaFinalNode = (
  tensorTex: TextureNode,
  originalTex: TextureNode,
  radius: ReturnType<typeof float>,
  opts: { stylize?: boolean; watercolor?: TextureNode } = {},
) =>
  Fn(() => {
    const { stylize = false, watercolor } = opts
    const vUv = vec2(uv().x, uv().y.oneMinus())
    const kuwa = kuwaharaNode(tensorTex, originalTex, radius)
    const color = kuwa.rgb.toVar()

    // The quantize -> saturate -> ACES block flattens tonal range and double
    // tone-maps on top of the renderer. Off by default; the painterly look
    // comes from the Kuwahara filter alone.
    if (stylize) {
      const grayscale = dot(color, vec3(0.299, 0.587, 0.114))
      const n = float(16.0)
      const qn0 = floor(grayscale.mul(n.sub(1.0)).add(0.5)).div(n.sub(1.0))
      const qn = clamp(qn0, 0.2, 0.7)
      const lowBranch = mix(vec3(0.1), color, qn.mul(2.0))
      const highBranch = mix(color, vec3(1.0), qn.sub(0.5).mul(2.0))
      color.assign(qn.lessThan(0.5).select(lowBranch, highBranch))
      color.assign(sat(color, float(1.5)))
      color.assign(ACESFilm(color))
    }

    const out = vec4(color, 1.0)
    if (watercolor) {
      return out.mul(watercolor.sample(vUv))
    }
    return out
  })()
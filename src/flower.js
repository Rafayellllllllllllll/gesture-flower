/**
 * 粒子花朵的几何生成。
 *
 * 花瓣用显式参数化，保证边界清晰、花瓣之间有缝：
 *   每颗粒子分到一片花瓣 p ∈ [0, P)，再取两个参数：
 *     u ∈ [0,1]  沿花瓣：0 = 花心，1 = 花瓣尖端
 *     v ∈ [-1,1] 横向：±1 是花瓣两侧边缘
 *   halfW(u) = W · sin(π·u^0.75)^0.70 · (1 − 0.16·u)
 *   θ = p·2π/P + tilt[p] + v · halfW(u)
 *   r = R · len[p] · (0.10 + 0.90·u)
 *
 * 花苞形态不是另生成一团球，而是用同一套 (θ, u) 参数做两件事：
 *   1) 径向压缩到 0.20 倍 —— 花瓣收拢
 *   2) 沿垂直方向按 u 拉长 —— 形成竖直的水滴形花苞
 *   3) 绕垂直轴按高度扭转 —— 花瓣层层包裹
 * 这样 spread 在中间值时，看到的是"花瓣向外翻开"，而不是"球膨胀"。
 */
import * as THREE from 'three'
import { flowerVertexShader, flowerFragmentShader } from './shaders.js'

const TAU = Math.PI * 2

function mulberry32(a) {
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)

/**
 * @param {object} opt
 * @param {number} opt.count    粒子数量 5000~20000
 * @param {number} opt.petals   花瓣数量
 * @param {number} opt.radius   绽放半径
 * @param {number} opt.seed     随机种子（同种子生成同一朵花）
 */
export function createFlower({ count = 16000, petals = 6, radius = 1.95, seed = 20261023 } = {}) {
  const rand = mulberry32(seed)

  const bud = new Float32Array(count * 3)
  const bloom = new Float32Array(count * 3)
  const rho = new Float32Array(count)
  const edge = new Float32Array(count)
  const seeds = new Float32Array(count)
  const sizes = new Float32Array(count)

  const stamenCount = Math.floor(count * 0.12) // 约 12% 粒子做花蕊（太多会把中心叠爆）

  // 每片花瓣的长度 / 角度略有差异，避免"完美对称的假花"
  const petalLen = Array.from({ length: petals }, () => 1 + (rand() - 0.5) * 0.12)
  const petalTilt = Array.from({ length: petals }, () => (rand() - 0.5) * 0.10)

  for (let i = 0; i < count; i++) {
    const i3 = i * 3

    let x, y, z, t, budX, budY, budZ
    let edgeVal = 0

    if (i < stamenCount) {
      // ── 花蕊：中心的小圆盘 ───────────────────────────────
      const a = rand() * TAU
      const rr = radius * 0.21 * Math.sqrt(rand()) * (0.35 + 0.65 * rand())
      x = Math.cos(a) * rr
      y = Math.sin(a) * rr
      z = 0.20 + Math.cos((rr / (radius * 0.21)) * Math.PI * 0.5) * 0.13 + (rand() - 0.5) * 0.04
      t = 0.02 + rand() * 0.14

      budX = x * 0.22
      budY = y * 0.22 + 0.10
      budZ = z * 0.25
    } else {
      // ── 花瓣：绽放形态 ───────────────────────────────────
      const p = Math.floor(rand() * petals)
      const u = Math.pow(rand(), 0.74)
      const v = rand() * 2 - 1

      const halfW = 0.52 * Math.pow(Math.sin(Math.PI * Math.pow(u, 0.75)), 0.70) * (1 - 0.16 * u)
      const theta = (p / petals) * TAU + petalTilt[p] + v * halfW
      const r = radius * petalLen[p] * (0.10 + 0.90 * u)

      x = Math.cos(theta) * r
      y = Math.sin(theta) * r

      z = 0.62 * Math.pow(u, 1.75)                        // 边缘向上卷
      z += 0.055 * Math.sin(v * Math.PI * 2.2 + u * 3.2) * Math.min(1, u * 2.2)
      z += (rand() - 0.5) * 0.05
      z += 0.05

      t = clamp01(0.14 + 0.86 * u + (rand() - 0.5) * 0.06)
      edgeVal = Math.abs(v)   // 花瓣侧缘 = 1，中线 = 0，用于勾发光轮廓

      // ── 花瓣：花苞形态（同一套 θ/u 参数，收进一个竖立的水滴）──
      // 轮廓：上下两端收敛、中段最宽 → 闭合的花苞，而不是张口的锥
      const prof = Math.pow(Math.sin(Math.PI * Math.pow(u, 0.80)), 0.85)
      const budRad = radius * 0.26 * prof
      const bx0 = Math.cos(theta) * budRad
      const bz0 = Math.sin(theta) * budRad * 0.85
      const by0 = (u - 0.5) * radius * 1.15
      const twist = by0 * 2.6                              // 绕垂直轴扭转 → 包裹感
      budX = bx0 * Math.cos(twist) - bz0 * Math.sin(twist)
      budZ = bx0 * Math.sin(twist) + bz0 * Math.cos(twist)
      budY = by0
    }

    bloom[i3] = x
    bloom[i3 + 1] = y
    bloom[i3 + 2] = z

    bud[i3] = budX
    bud[i3 + 1] = budY
    bud[i3 + 2] = budZ

    rho[i] = t
    edge[i] = edgeVal
    seeds[i] = rand()
    // 花心颗粒更小，避免中心叠成一团白；外缘略大，轮廓更柔和
    sizes[i] = (0.55 + rand() * 1.05) * (0.92 + 0.38 * t)
  }

  const geometry = new THREE.BufferGeometry()
  // position 只是占位（真实位置在顶点着色器里插值），但 three 需要它确定绘制范围
  geometry.setAttribute('position', new THREE.BufferAttribute(bloom.slice(), 3))
  geometry.setAttribute('aBloom', new THREE.BufferAttribute(bloom, 3))
  geometry.setAttribute('aBud', new THREE.BufferAttribute(bud, 3))
  geometry.setAttribute('aRho', new THREE.BufferAttribute(rho, 1))
  geometry.setAttribute('aEdge', new THREE.BufferAttribute(edge, 1))
  geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1))
  geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1))
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), radius * 1.6)

  const material = new THREE.ShaderMaterial({
    vertexShader: flowerVertexShader,
    fragmentShader: flowerFragmentShader,
    uniforms: {
      uTime: { value: 0 },
      uSpread: { value: 0.35 },
      uPixelRatio: { value: 1 },
      uPointScale: { value: 1 },
      uHand: { value: new THREE.Vector2(0, 0) },
      uHandActive: { value: 0 },
      uAlphaMul: { value: 1 },
    },
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
  })

  const points = new THREE.Points(geometry, material)
  points.frustumCulled = false

  // 第二层光晕：复用同一份几何和着色器，只是点更大更淡 → 体积光感
  // 共享 uTime / uSpread / uHand 等 uniform 对象，颜色与动画天然同步
  const glowMaterial = new THREE.ShaderMaterial({
    vertexShader: flowerVertexShader,
    fragmentShader: flowerFragmentShader,
    uniforms: {
      ...material.uniforms,
      uPointScale: { value: 1 },
      uAlphaMul: { value: 0.13 },
    },
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
  })
  const glow = new THREE.Points(geometry, glowMaterial)
  glow.frustumCulled = false

  return { points, glow, material, glowMaterial, geometry }
}

/** 背景星尘 */
export function createDust({ count = 700, spread = 8.5, seed = 77 } = {}) {
  const rand = mulberry32(seed)
  const pos = new Float32Array(count * 3)
  const seeds = new Float32Array(count)
  const sizes = new Float32Array(count)
  for (let i = 0; i < count; i++) {
    const i3 = i * 3
    pos[i3] = (rand() - 0.5) * spread * 2
    pos[i3 + 1] = (rand() - 0.5) * spread * 1.6
    pos[i3 + 2] = -2 - rand() * spread
    seeds[i] = rand()
    // 星尘要非常小，否则会盖过花朵本体
    sizes[i] = 0.05 + rand() * 0.13
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  g.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1))
  g.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1))
  return { geometry: g, seeds, sizes }
}

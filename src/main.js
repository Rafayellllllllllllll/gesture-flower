import * as THREE from 'three'
import { createFlower, createDust } from './flower.js'
import { dustVertexShader, dustFragmentShader } from './shaders.js'
import { HandTracker, describeCameraError, HAND_CONNECTIONS } from './hands.js'

/* ── 配置 ──────────────────────────────────────────────────── */
const params = new URLSearchParams(location.search)
const isCoarse = matchMedia('(pointer: coarse)').matches
const int = (v, d) => (Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : d)
const clamp = (v, a, b) => Math.min(b, Math.max(a, v))

const CONFIG = {
  count: clamp(int(params.get('count'), isCoarse ? 10000 : 16000), 5000, 20000),
  petals: clamp(int(params.get('petals'), 6), 3, 12),
  radius: Number.parseFloat(params.get('radius')) || 1.95,
  seed: int(params.get('seed'), 20261023),
  debug: params.get('debug') === '1',
  // ?spread=0.85 固定绽放程度（截图 / 调参 / 无手臂环境演示用）
  lockedSpread: params.has('spread') ? clamp(Number.parseFloat(params.get('spread')) || 0, 0, 1) : null,
}

/* ── DOM ───────────────────────────────────────────────────── */
const canvas = document.getElementById('scene')
const overlay = document.getElementById('skeleton')
const ctx2d = overlay.getContext('2d')
const video = document.getElementById('cam')
const stateEl = document.getElementById('state')
const barEl = document.getElementById('bar')
const valueEl = document.getElementById('value')
const gate = document.getElementById('gate')
const gateTitle = document.getElementById('gateTitle')
const gateMsg = document.getElementById('gateMsg')
const retryBtn = document.getElementById('retry')

/* ── Three.js 基础 ─────────────────────────────────────────── */
let renderer
try {
  renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false,
    alpha: false,
    powerPreference: 'high-performance',
    stencil: false,
    depth: true,
  })
} catch (err) {
  showGate('无法启动 WebGL', '这台设备的浏览器禁用了 WebGL。请开启硬件加速，或换 Chrome / Edge 再试。')
  throw err
}

renderer.setClearColor(0x000000, 1)
renderer.toneMapping = THREE.NoToneMapping

const scene = new THREE.Scene()
const camera = new THREE.PerspectiveCamera(48, 1, 0.1, 100)
camera.position.set(0, 0, 6.2)

const flowerGroup = new THREE.Group()
scene.add(flowerGroup)

const { points: flower, material: flowerMat } = createFlower({
  count: CONFIG.count,
  petals: CONFIG.petals,
  radius: CONFIG.radius,
  seed: CONFIG.seed,
})
flowerGroup.add(flower)

// 背景星尘
const dustData = createDust({ count: 700, spread: 8.5 })
const dustMat = new THREE.ShaderMaterial({
  vertexShader: dustVertexShader,
  fragmentShader: dustFragmentShader,
  uniforms: { uTime: { value: 0 }, uPixelRatio: { value: 1 } },
  transparent: true,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
})
const dust = new THREE.Points(dustData.geometry, dustMat)
dust.frustumCulled = false
scene.add(dust)

/* ── 状态 ──────────────────────────────────────────────────── */
const state = {
  spread: CONFIG.lockedSpread ?? 0.35,   // 当前绽放程度（缓动后的值）
  target: CONFIG.lockedSpread ?? 0.35,   // 目标值
  hand: new THREE.Vector2(0, 0),
  handActive: 0,
  hasHand: false,
  cameraReady: false,
  pointerMode: false,
  showSkeleton: false,
  showBg: false,
  landmarks: null,
  rawRatio: 0,
  fps: 0,
}

/* ── 尺寸 / 响应式 ─────────────────────────────────────────── */
let dpr = 1
function resize() {
  const w = window.innerWidth
  const h = window.innerHeight
  dpr = Math.min(window.devicePixelRatio || 1, 2)

  renderer.setPixelRatio(dpr)
  renderer.setSize(w, h, false)

  camera.aspect = w / h
  // 竖屏时把相机拉远，避免花被裁掉
  camera.position.z = w / h < 0.85 ? 7.8 : 5.7
  camera.updateProjectionMatrix()

  overlay.width = Math.round(w * dpr)
  overlay.height = Math.round(h * dpr)
  ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0)

  flowerMat.uniforms.uPixelRatio.value = dpr
  // 粒子屏幕尺寸随视口高度缩放，保持视觉比例一致
  flowerMat.uniforms.uPointScale.value = 0.062 * clamp(h / 900, 0.72, 1.45)
  dustMat.uniforms.uPixelRatio.value = dpr
}
window.addEventListener('resize', resize, { passive: true })
window.addEventListener('orientationchange', () => setTimeout(resize, 120), { passive: true })
resize()

/* ── 手部追踪 ──────────────────────────────────────────────── */
const tracker = new HandTracker({
  video,
  onStatus: (msg) => toast(msg),
  onLandmarks: (lm) => { state.landmarks = lm },
  onFrame: (tension, pos, hasHand) => {
    state.target = tension
    state.hasHand = hasHand
    state.hand.set(pos.x, pos.y)
    state.handActive = hasHand ? 1 : 0
    if (tracker.rawRatio) state.rawRatio = tracker.rawRatio
  },
})

async function startCamera() {
  hideGate()
  // 演示 / 截图 / 自动化测试：?camera=off 直接进鼠标模式，不碰摄像头
  if (params.get('camera') === 'off') {
    state.pointerMode = true
    video.classList.add('off')
    setPill('鼠标模式 · 左右移动控制')
    return
  }
  try {
    await tracker.start()
    state.cameraReady = true
    state.pointerMode = false
  } catch (err) {
    state.cameraReady = false
    state.pointerMode = true
    console.warn('[gesture-flower] camera failed:', err)
    showGate('摄像头没启动', describeCameraError(err) + '\n\n已切换到「鼠标模式」：左右移动鼠标即可控制花朵绽放。')
    setPill('鼠标模式 · 左右移动控制', 'err')
  }
}

retryBtn.addEventListener('click', () => {
  tracker.stop()
  startCamera()
})

/* ── 鼠标 / 触摸兜底 ──────────────────────────────────────── */
let lastPointer = 0
function usePointerFallback() {
  if (state.cameraReady) return
  state.pointerMode = true
}
window.addEventListener('pointermove', (e) => {
  if (state.cameraReady) return
  usePointerFallback()
  const nx = (e.clientX / window.innerWidth - 0.5) * 2
  const ny = -(e.clientY / window.innerHeight - 0.5) * 2
  state.target = clamp((e.clientX / window.innerWidth - 0.1) / 0.8, 0, 1)
  state.hand.set(nx * 0.9, ny * 0.9)
  state.handActive = 0.6
  lastPointer = performance.now()
}, { passive: true })

/* ── 快捷键 ────────────────────────────────────────────────── */
window.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase()
  if (k === 'l') {
    state.showSkeleton = !state.showSkeleton
    toast(state.showSkeleton ? '显示手部骨架' : '隐藏手部骨架')
  } else if (k === 'v') {
    state.showBg = !state.showBg
    video.classList.toggle('bg', state.showBg)
    toast(state.showBg ? '摄像头作为背景' : '摄像头缩到角落')
  } else if (k === 'd') {
    CONFIG.debug = !CONFIG.debug
    toast(CONFIG.debug ? '调试信息开' : '调试信息关')
  } else if (k === 'r') {
    tracker.stop()
    startCamera()
  }
})

/* ── HUD ───────────────────────────────────────────────────── */
let hudTimer = 0
function setPill(text, cls = '') {
  stateEl.textContent = text
  stateEl.className = 'pill' + (cls ? ' ' + cls : '')
}

function updateHud(now) {
  if (now - hudTimer < 90) return
  hudTimer = now

  const s = state.spread
  barEl.style.width = (s * 100).toFixed(1) + '%'
  valueEl.textContent = s.toFixed(2)

  if (!state.cameraReady && !state.pointerMode) {
    setPill('等待摄像头…')
    return
  }
  if (state.pointerMode && !state.cameraReady) {
    setPill(s < 0.32 ? '花苞闭合' : s > 0.66 ? '花朵绽放' : '过渡中', s > 0.66 ? 'bloom' : s < 0.32 ? 'bud' : '')
    return
  }
  if (!state.hasHand) {
    setPill('等待伸手…')
    return
  }
  if (s < 0.32) setPill('花苞闭合', 'bud')
  else if (s > 0.66) setPill('花朵绽放', 'bloom')
  else setPill('过渡中')
}

/* ── 手部骨架绘制 ─────────────────────────────────────────── */
function drawSkeleton() {
  const w = window.innerWidth
  const h = window.innerHeight
  ctx2d.clearRect(0, 0, w, h)
  if (!state.showSkeleton || !state.landmarks) return

  const lm = state.landmarks
  // 画面镜像 → 骨架也要镜像才对得上
  const px = (i) => (1 - lm[i].x) * w
  const py = (i) => lm[i].y * h

  ctx2d.lineWidth = 2
  ctx2d.strokeStyle = 'rgba(255,158,207,0.55)'
  ctx2d.beginPath()
  for (const [a, b] of HAND_CONNECTIONS) {
    ctx2d.moveTo(px(a), py(a))
    ctx2d.lineTo(px(b), py(b))
  }
  ctx2d.stroke()

  for (let i = 0; i < lm.length; i++) {
    const tip = [4, 8, 12, 16, 20].includes(i)
    ctx2d.beginPath()
    ctx2d.arc(px(i), py(i), tip ? 4.5 : 2.6, 0, Math.PI * 2)
    ctx2d.fillStyle = tip ? 'rgba(167,232,255,0.95)' : 'rgba(179,136,255,0.85)'
    ctx2d.fill()
  }
}

/* ── 主循环 ────────────────────────────────────────────────── */
const clock = new THREE.Clock()
let frames = 0
let fpsAt = performance.now()

function animate() {
  requestAnimationFrame(animate)
  const dt = Math.min(clock.getDelta(), 0.05)
  const t = clock.elapsedTime

  // 没有手 / 没有指针时，让花保持半开的呼吸状态，而不是突然全开或全关
  if (CONFIG.lockedSpread !== null) {
    state.target = CONFIG.lockedSpread
  } else if (state.cameraReady && !state.hasHand) {
    state.target = 0.45 + Math.sin(t * 0.7) * 0.06
    state.handActive += (0 - state.handActive) * 0.05
  } else if (!state.cameraReady && performance.now() - lastPointer > 2500) {
    state.target = 0.45 + Math.sin(t * 0.7) * 0.06
    state.handActive += (0 - state.handActive) * 0.05
  }

  // 需求指定的缓动：current += (target − current) · 0.1
  state.spread += (state.target - state.spread) * 0.1

  flowerMat.uniforms.uTime.value = t
  flowerMat.uniforms.uSpread.value = state.spread
  flowerMat.uniforms.uHand.value.set(state.hand.x, state.hand.y)
  flowerMat.uniforms.uHandActive.value = state.handActive
  dustMat.uniforms.uTime.value = t

  // 花朵整体轻微漂移 + 跟手（幅度很小，避免变成"拖拽"）
  flowerGroup.position.x += (state.hand.x * 0.45 * state.handActive - flowerGroup.position.x) * 0.04
  flowerGroup.position.y += (state.hand.y * 0.32 * state.handActive - flowerGroup.position.y) * 0.04
  flowerGroup.rotation.z = Math.sin(t * 0.13) * 0.05 + state.hand.x * 0.08 * state.handActive
  flowerGroup.rotation.x = -0.12 + Math.sin(t * 0.11) * 0.03
  flowerGroup.scale.setScalar(0.94 + state.spread * 0.08)

  // 视差
  camera.position.x += (state.hand.x * 0.18 * state.handActive - camera.position.x) * 0.05
  camera.position.y += (state.hand.y * 0.12 * state.handActive - camera.position.y) * 0.05
  camera.lookAt(0, 0, 0)

  dust.rotation.z = t * 0.008

  renderer.render(scene, camera)
  drawSkeleton()
  updateHud(performance.now())

  if (CONFIG.debug) {
    frames++
    const now = performance.now()
    if (now - fpsAt > 500) {
      state.fps = Math.round((frames * 1000) / (now - fpsAt))
      frames = 0
      fpsAt = now
    }
    debugEl.textContent =
      `fps ${state.fps}\nspread ${state.spread.toFixed(3)}\n` +
      `ratio ${state.rawRatio.toFixed(2)}\nparticles ${CONFIG.count}\n` +
      `hand ${state.hasHand ? 'yes' : 'no'}  cam ${state.cameraReady ? 'on' : 'off'}`
    debugEl.style.display = 'block'
  } else if (debugEl.style.display !== 'none') {
    debugEl.style.display = 'none'
  }
}

/* ── 小工具 ────────────────────────────────────────────────── */
const debugEl = document.createElement('pre')
debugEl.style.cssText =
  'position:fixed;right:14px;top:14px;z-index:5;margin:0;padding:10px 12px;border-radius:12px;' +
  'font:11px/1.5 ui-monospace,Menlo,monospace;color:#a7e8ff;background:rgba(10,4,14,.72);' +
  'box-shadow:inset 0 0 0 1px rgba(167,232,255,.25);display:none;pointer-events:none;white-space:pre'
document.body.appendChild(debugEl)

let toastTimer = 0
const toastEl = document.createElement('div')
toastEl.id = 'toast'
document.body.appendChild(toastEl)
function toast(msg) {
  toastEl.textContent = msg
  toastEl.classList.add('show')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 1800)
}

function showGate(title, msg) {
  gateTitle.textContent = title
  gateMsg.textContent = msg
  gate.classList.remove('hidden')
}
function hideGate() {
  gate.classList.add('hidden')
}

/* ── 启动 ──────────────────────────────────────────────────── */
// 冒烟测试用标记：无头浏览器 / 自动化脚本可以检查 body[data-ready] 与 body[data-error]
window.addEventListener('error', (e) => {
  document.body.dataset.error = String(e.message || 'error').slice(0, 200)
})
window.addEventListener('unhandledrejection', (e) => {
  document.body.dataset.error = String(e.reason?.message || e.reason || 'rejection').slice(0, 200)
})

toast(`粒子 ${CONFIG.count} · 花瓣 ${CONFIG.petals}`)
startCamera()
animate()

let firstFrame = true
const markReady = () => {
  if (!firstFrame) return
  firstFrame = false
  requestAnimationFrame(() => {
    document.body.dataset.ready = '1'
    document.body.dataset.count = String(CONFIG.count)
  })
}
markReady()

// 页面切回来时，若摄像头画面停了就重连
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.cameraReady) {
    const v = video
    if (v.srcObject && v.paused) v.play().catch(() => {})
  }
})

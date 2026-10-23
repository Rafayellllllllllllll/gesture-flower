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

const { points: flower, glow: flowerGlow, material: flowerMat, glowMaterial: flowerGlowMat } = createFlower({
  count: CONFIG.count,
  petals: CONFIG.petals,
  radius: CONFIG.radius,
  seed: CONFIG.seed,
})
flowerGroup.add(flowerGlow)
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

// 背景极淡的粉色辉光，把"梦幻"托起来（纯贴图，几乎不耗性能）
function radialTexture() {
  const s = 256
  const c = document.createElement('canvas')
  c.width = c.height = s
  const g = c.getContext('2d')
  const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2)
  grd.addColorStop(0, 'rgba(255,158,207,0.50)')
  grd.addColorStop(0.42, 'rgba(179,136,255,0.14)')
  grd.addColorStop(1, 'rgba(0,0,0,0)')
  g.fillStyle = grd
  g.fillRect(0, 0, s, s)
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}
const aura = new THREE.Sprite(new THREE.SpriteMaterial({
  map: radialTexture(),
  blending: THREE.AdditiveBlending,
  depthWrite: false,
  transparent: true,
  opacity: 0.6,
}))
aura.scale.set(9.5, 9.5, 1)
aura.position.set(0, 0, -2.6)
scene.add(aura)

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
  // 手机上限制渲染分辨率，保证 60fps（点数 × DPR² 直接决定填充率）
  dpr = Math.min(window.devicePixelRatio || 1, isCoarse ? 1.6 : 2)

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
  flowerGlowMat.uniforms.uPointScale.value = flowerMat.uniforms.uPointScale.value * 3.6
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

const startEl = document.getElementById('start')
const startCamBtn = document.getElementById('startCam')
const startTouchBtn = document.getElementById('startTouch')
const useTouchBtn = document.getElementById('useTouch')

function hideStart() {
  if (!startEl || startEl.classList.contains('hide')) return
  startEl.classList.add('hide')
  setTimeout(() => startEl.remove(), 500)
}

/** 触屏 / 鼠标模式：按住绽放、松开收拢、拖动跟随 */
function enterTouchMode(hint) {
  state.cameraReady = false
  state.pointerMode = true
  video.classList.add('off')
  hideStart()
  if (hint) toast(hint)
  setPill('按住屏幕 / 按住鼠标 → 绽放')
}

async function startCamera() {
  hideGate()
  hideStart()
  // 演示 / 截图 / 自动化测试：?camera=off 直接进触屏模式，不碰摄像头
  if (params.get('camera') === 'off') {
    enterTouchMode()
    return
  }
  setPill('正在连接摄像头…')
  try {
    await tracker.start()
    state.cameraReady = true
    state.pointerMode = false
    setPill('把手放进画面')
  } catch (err) {
    state.cameraReady = false
    console.warn('[gesture-flower] camera failed:', err)
    enterTouchMode()
    showGate('摄像头没启动', describeCameraError(err) + '\n\n可以先用触屏 / 鼠标玩：按住即绽放，松开收拢。')
    setPill('触屏模式 · 按住绽放', 'err')
  }
}

startCamBtn?.addEventListener('click', () => { startCamera() })
startTouchBtn?.addEventListener('click', () => enterTouchMode('按住屏幕 / 按住鼠标 → 绽放'))
useTouchBtn?.addEventListener('click', () => { hideGate(); enterTouchMode('按住即绽放，松开收拢') })
retryBtn.addEventListener('click', () => {
  hideGate()
  tracker.stop()
  startCamera()
})

/* ── 触屏 / 鼠标交互（摄像头不可用时的主角）──────────────── */
let lastPointer = 0
let holding = false

function applyPointer(e) {
  const nx = (e.clientX / window.innerWidth - 0.5) * 2
  const ny = -(e.clientY / window.innerHeight - 0.5) * 2
  state.hand.set(nx * 0.85, ny * 0.85)
  state.handActive = 0.75
  lastPointer = performance.now()
}

window.addEventListener('pointerdown', (e) => {
  if (state.cameraReady) return
  holding = true
  state.pointerMode = true
  applyPointer(e)
  state.target = 1                      // 按住 → 绽放
  if (e.pointerType !== 'mouse') e.preventDefault()
}, { passive: false })

window.addEventListener('pointermove', (e) => {
  if (state.cameraReady) return
  if (holding) { applyPointer(e); return }
  if (e.pointerType === 'mouse') {      // 桌面：不按键也能左右扫
    applyPointer(e)
    state.target = clamp((e.clientX / window.innerWidth - 0.1) / 0.8, 0, 1)
  }
}, { passive: true })

function endHold() {
  if (state.cameraReady || !holding) return
  holding = false
  state.target = 0.18                   // 松开 → 收拢成花苞
  lastPointer = 0                       // 让"待机呼吸"立刻接管
}
window.addEventListener('pointerup', endHold, { passive: true })
window.addEventListener('pointercancel', endHold, { passive: true })
window.addEventListener('pointerleave', endHold, { passive: true })

// 手机上按住拖动时不要滚动页面、不要弹长按菜单
document.addEventListener('touchmove', (e) => { if (holding) e.preventDefault() }, { passive: false })
document.addEventListener('contextmenu', (e) => { if (!state.cameraReady) e.preventDefault() })

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
    // 分阶段提示：能一眼看出是"没画面 / 模型没跑 / 模型跑了但没手"
    const t = tracker
    const waited = performance.now() - (t.startAt || performance.now())
    if (t.sendErrors > 0) setPill('手势推理报错（按 D 看原因）', 'err')
    else if (t.framesSent === 0 && waited > 4000) setPill('摄像头没出画面（可能被占用）', 'err')
    else if (t.resultsCount === 0 && waited > 7000) setPill('手势模型没出结果 · 换 Chrome 试试', 'err')
    else if (t.resultsCount > 0) setPill('把手放进画面中间（近一点、亮一点）', '')
    else setPill('正在加载手势模型…', '')
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
  } else if (!state.cameraReady && !holding && performance.now() - lastPointer > 2500) {
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
  flowerGroup.rotation.y = Math.sin(t * 0.09) * 0.18
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
      `hand ${state.hasHand ? 'yes' : 'no'}  cam ${state.cameraReady ? 'on' : 'off'}\n` +
      `phase ${tracker.phase}  score ${tracker.lastScore.toFixed(2)}\n` +
      `frames ${tracker.framesSent} sent / ${tracker.framesSkipped} skip\n` +
      `results ${tracker.resultsCount}  errors ${tracker.sendErrors}\n` +
      `err ${tracker.lastError ? tracker.lastError.slice(0, 80) : '-'}\n` +
      `search ${location.search || '(none)'}\n` +
      `gerr ${(document.body.dataset.error || '-').slice(0, 70)}`
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
// 页面一进来就是"可玩"状态（触屏/鼠标）；摄像头由开始界面的按钮触发
state.pointerMode = true
setPill('点一下开始')
if (params.get('camera') === 'off' || CONFIG.lockedSpread !== null) {
  enterTouchMode()   // 截图 / 演示 / 自动化：跳过开始界面
} else if (params.get('camera') === 'auto') {
  startCamera()      // 自动进摄像头（老访客 / 自动化测试用）
}
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

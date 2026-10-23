/**
 * MediaPipe Hands 封装 + 手掌张开度 tension 计算。
 *
 * ── tension 公式（0 = 握拳，1 = 完全张开）────────────────────────
 * 1) 手掌尺度：palmSpan = |wrist(0) − middle_MCP(9)|
 * 2) 四指伸展比（指尖 8/12/16/20，指根 5/9/13/17）：
 *      ratio_i = |wrist − tip_i| / palmSpan
 * 3) 取均值 meanRatio（握拳约 1.2~1.5，张开约 2.2~2.6）
 * 4) 归一化 + 平滑：t = smoothstep(clamp((meanRatio − 1.12) / (2.30 − 1.12), 0, 1))
 * 5) 时间维度再做一次指数平滑：s ← s + (t − s) · 0.18
 * 这样握拳/张开的临界抖动不会让花朵抽搐。
 */

const TIP = [8, 12, 16, 20]
const MCP = [5, 9, 13, 17]

export const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
]

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)
const smoothstep = (v) => v * v * (3 - 2 * v)

function dist(a, b) {
  const dx = a.x - b.x
  const dy = a.y - b.y
  return Math.hypot(dx, dy)
}

/**
 * 单帧张力（未平滑）
 * @param {Array<{x:number,y:number,z:number}>} lm 21 个关键点
 */
export function computeTension(lm) {
  const palmSpan = dist(lm[0], lm[9]) || 1e-6
  let sum = 0
  for (let i = 0; i < TIP.length; i++) {
    sum += dist(lm[0], lm[TIP[i]]) / palmSpan
  }
  const meanRatio = sum / TIP.length
  const raw = clamp01((meanRatio - 1.12) / (2.30 - 1.12))
  return { tension: smoothstep(raw), meanRatio, palmSpan }
}

/** 掌心位置（归一化 0..1，未镜像）+ 手掌朝向 */
function palmCenter(lm) {
  const ids = [0, 5, 9, 13, 17]
  let x = 0, y = 0
  for (const i of ids) { x += lm[i].x; y += lm[i].y }
  return { x: x / ids.length, y: y / ids.length }
}

export class HandTracker {
  /**
   * @param {object} opt
   * @param {HTMLVideoElement} opt.video
   * @param {(t:number, handPos:{x:number,y:number}, hasHand:boolean)=>void} opt.onFrame
   * @param {(landmarks:Array|null)=>void} opt.onLandmarks
   * @param {(msg:string)=>void} opt.onStatus
   */
  constructor({ video, onFrame, onLandmarks, onStatus }) {
    this.video = video
    this.onFrame = onFrame
    this.onLandmarks = onLandmarks
    this.onStatus = onStatus || (() => {})

    this.stream = null
    this.hands = null
    this.running = false
    this.lastVideoTime = -1
    this.raf = 0

    this.tension = 0.35
    this.handPos = { x: 0, y: 0 }
    this.hasHand = false
    this.lastSeen = 0
  }

  async start() {
    if (this.running) return
    if (!window.isSecureContext) {
      throw new Error('当前页面不是安全上下文（需 https 或 localhost），浏览器会拒绝摄像头。')
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('此浏览器不支持 getUserMedia。')
    }
    if (typeof window.Hands !== 'function') {
      throw new Error('MediaPipe Hands 未加载，请确认 vendor/mediapipe/hands.js 存在。')
    }

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
    })

    this.video.srcObject = this.stream
    await this.video.play().catch(() => {})
    this.video.classList.remove('off')

    this.hands = new window.Hands({ locateFile: (file) => `./vendor/mediapipe/${file}` })
    this.hands.setOptions({
      maxNumHands: 1,
      modelComplexity: 0,
      minDetectionConfidence: 0.6,
      minTrackingConfidence: 0.5,
    })
    this.hands.onResults((res) => this._onResults(res))

    this.running = true
    this.onStatus('已连接摄像头')
    this._loop()
  }

  stop() {
    this.running = false
    cancelAnimationFrame(this.raf)
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop()
      this.stream = null
    }
    this.video.srcObject = null
    this.video.classList.add('off')
  }

  _loop() {
    if (!this.running) return
    const v = this.video
    if (v.readyState >= 2 && v.currentTime !== this.lastVideoTime) {
      this.lastVideoTime = v.currentTime
      this.hands.send({ image: v }).catch(() => {})
    }
    this.raf = requestAnimationFrame(() => this._loop())
  }

  _onResults(res) {
    const list = res.multiHandLandmarks
    const lm = list && list.length ? list[0] : null
    const now = performance.now()

    if (lm) {
      this.lastSeen = now
      this.hasHand = true

      const { tension, meanRatio } = computeTension(lm)
      // 指数平滑：s ← s + (t − s)·0.18
      this.tension += (tension - this.tension) * 0.18
      this.rawRatio = meanRatio

      const c = palmCenter(lm)
      // 画面是镜像显示的，这里换成「屏幕方向」
      const tx = (0.5 - c.x) * 2
      const ty = -(c.y - 0.5) * 2
      this.handPos.x += (tx - this.handPos.x) * 0.15
      this.handPos.y += (ty - this.handPos.y) * 0.15

      this.onLandmarks?.(lm)
    } else {
      // 丢手超过 400ms 才认为真的没有手，避免短暂丢失导致闪烁
      if (now - this.lastSeen > 400) {
        this.hasHand = false
        this.tension += (0.45 - this.tension) * 0.04
        this.onLandmarks?.(null)
      }
    }

    this.onFrame?.(this.tension, this.handPos, this.hasHand)
  }
}

export function describeCameraError(err) {
  const name = err?.name || ''
  const map = {
    NotAllowedError: '摄像头权限被拒绝。点击地址栏的摄像头图标允许访问，然后按「重试」。',
    PermissionDeniedError: '摄像头权限被拒绝。请在浏览器设置里允许本站使用摄像头。',
    NotFoundError: '没有找到摄像头设备。请接上摄像头再重试。',
    DevicesNotFoundError: '没有找到摄像头设备。请接上摄像头再重试。',
    NotReadableError: '摄像头被其它程序占用（会议软件、录屏工具等），关掉它们再重试。',
    TrackStartError: '摄像头启动失败，可能被其它程序占用。',
    OverconstrainedError: '摄像头不支持所需的分辨率。',
    SecurityError: '安全限制：页面必须通过 https 或 localhost 打开。',
  }
  return map[name] || `${err?.message || err || '未知错误'}`
}

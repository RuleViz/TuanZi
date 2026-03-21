/**
 * TuanZi Desktop — 液态玻璃交互效果
 * 鼠标跟踪变形 / 色散 / 动态边缘高光
 */

// ── 配置 ──
const GLASS_CONFIG = {
  /** 鼠标影响半径 (px) */
  radius: 280,
  /** 位移变形强度 (SVG scale) */
  displaceScale: 5,
  /** 色散偏移量 (px) */
  chromaticShift: 0.8,
  /** 弹性回弹阻尼 */
  dampingFactor: 0.08,
  /** 边缘高光最大透明度 */
  edgeGlowOpacity: 0.18,
  /** 网格浮动动画速度 */
  meshAnimSpeed: 0.0003
} as const

// ── 状态 ──
let mouseX = 0
let mouseY = 0
let smoothX = 0
let smoothY = 0
let rafId: number | null = null

// ── SVG 滤镜引用 ──
let displacementFilter: SVGFEDisplacementMapElement | null = null
let chromaticRedShift: SVGFEOffsetElement | null = null
let chromaticGreenShift: SVGFEOffsetElement | null = null
let chromaticBlueShift: SVGFEOffsetElement | null = null

// ── 背景网格 ──
let meshEl: HTMLElement | null = null

/**
 * 初始化液态玻璃交互
 */
export function initLiquidGlass(): void {
  displacementFilter = document.querySelector('#liquid-glass-filter feDisplacementMap')
  chromaticRedShift = document.querySelector("#chromatic-aberration feOffset[result='RED_SHIFT']")
  chromaticGreenShift = document.querySelector(
    "#chromatic-aberration feOffset[result='GREEN_SHIFT']"
  )
  chromaticBlueShift = document.querySelector("#chromatic-aberration feOffset[result='BLUE_SHIFT']")
  meshEl = document.getElementById('glassBgMesh')

  if (!displacementFilter && !meshEl) return

  document.addEventListener('mousemove', onMouseMove, { passive: true })
  startAnimationLoop()
}

/**
 * 销毁液态玻璃交互
 */
export function destroyLiquidGlass(): void {
  document.removeEventListener('mousemove', onMouseMove)
  if (rafId !== null) {
    cancelAnimationFrame(rafId)
    rafId = null
  }
}

// ── 事件 ──
function onMouseMove(e: MouseEvent): void {
  mouseX = e.clientX
  mouseY = e.clientY
}

// ── 动画循环 ──
function startAnimationLoop(): void {
  const loop = (): void => {
    // 平滑插值鼠标位置
    smoothX += (mouseX - smoothX) * GLASS_CONFIG.dampingFactor
    smoothY += (mouseY - smoothY) * GLASS_CONFIG.dampingFactor

    updateDisplacement()
    updateChromaticAberration()
    updateMeshGradient()

    rafId = requestAnimationFrame(loop)
  }
  rafId = requestAnimationFrame(loop)
}

/**
 * 根据鼠标位置动态调整位移变形
 */
function updateDisplacement(): void {
  if (!displacementFilter) return

  const vw = window.innerWidth
  const vh = window.innerHeight
  // 中心距离归一化 [0..1]
  const cx = (smoothX - vw / 2) / (vw / 2)
  const cy = (smoothY - vh / 2) / (vh / 2)
  const dist = Math.sqrt(cx * cx + cy * cy)

  // 距离越近中心变形越小, 边缘变形增大
  const scale = GLASS_CONFIG.displaceScale * (0.6 + 0.4 * Math.min(dist, 1))
  displacementFilter.setAttribute('scale', String(scale.toFixed(2)))
}

/**
 * 根据鼠标方向动态调整色散方向和强度
 */
function updateChromaticAberration(): void {
  if (!chromaticRedShift || !chromaticGreenShift || !chromaticBlueShift) return

  const vw = window.innerWidth
  const vh = window.innerHeight
  const nx = (smoothX / vw - 0.5) * 2 // [-1..1]
  const ny = (smoothY / vh - 0.5) * 2

  const shift = GLASS_CONFIG.chromaticShift
  // 红通道偏向鼠标方向
  chromaticRedShift.setAttribute('dx', String((nx * shift).toFixed(3)))
  chromaticRedShift.setAttribute('dy', String((ny * shift * 0.5).toFixed(3)))
  // 绿通道偏反方向
  chromaticGreenShift.setAttribute('dx', String((-nx * shift * 0.5).toFixed(3)))
  chromaticGreenShift.setAttribute('dy', String((ny * shift * 0.5).toFixed(3)))
  // 蓝通道偏垂直方向
  chromaticBlueShift.setAttribute('dx', String((-nx * shift * 0.3).toFixed(3)))
  chromaticBlueShift.setAttribute('dy', String((-ny * shift).toFixed(3)))
}

/**
 * 根据鼠标位置微移背景网格渐变, 产生视差效果
 */
function updateMeshGradient(): void {
  // if (!meshEl) return

  // const vw = window.innerWidth
  // const vh = window.innerHeight
  // const px = (smoothX / vw) * 100
  // const py = (smoothY / vh) * 100

  // // 渐变焦点跟随鼠标偏移 (幅度控制在 ±8%)
  // const ox = (px - 50) * 0.16
  // const oy = (py - 50) * 0.16

  // meshEl.style.background = `
  //   radial-gradient(ellipse 60% 50% at ${15 + ox}% ${20 + oy}%, rgba(190, 198, 220, 0.16) 0%, transparent 72%),
  //   radial-gradient(ellipse 50% 45% at ${85 - ox}% ${30 - oy}%, rgba(92, 102, 124, 0.14) 0%, transparent 72%),
  //   radial-gradient(ellipse 55% 40% at ${50 + ox * 0.5}% ${80 - oy}%, rgba(220, 228, 245, 0.08) 0%, transparent 74%),
  //   radial-gradient(ellipse 100% 60% at 50% 0%, rgba(255, 255, 255, 0.05) 0%, transparent 68%),
  //   linear-gradient(180deg, rgba(20, 22, 30, 0.22) 0%, rgba(20, 22, 30, 0.16) 50%, rgba(20, 22, 30, 0.22) 100%)
  // `
}

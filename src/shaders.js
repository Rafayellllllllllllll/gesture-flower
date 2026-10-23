/**
 * GLSL 着色器：顶点着色器里做「花苞 → 绽放」的位置插值，
 * 片元着色器里画柔和的发光粒子（叠加混合）。
 *
 * 颜色只允许：粉 #FF7AB6 / #FF9ECF、浅蓝 #8FD3FF / #A7E8FF、紫 #B388FF / #9B6BFF。
 * 不用深蓝、荧光绿、暖黄。
 */

export const flowerVertexShader = /* glsl */`
precision highp float;

uniform float uTime;
uniform float uSpread;       // 0 = 花苞，1 = 完全绽放（已缓动）
uniform float uPixelRatio;
uniform float uPointScale;
uniform float uAlphaMul;     // 光晕层用：同一套着色器，渲染成大而淡的第二层
uniform vec2  uHand;         // 手部位置，约 -1..1
uniform float uHandActive;   // 0 / 1

attribute vec3 aBud;         // 花苞状态位置
attribute vec3 aBloom;       // 绽放状态位置
attribute float aRho;        // 0 = 花心 → 1 = 花瓣边缘
attribute float aEdge;       // 0 = 花瓣中线 → 1 = 花瓣侧缘
attribute float aSeed;       // 随机种子 0..1
attribute float aSize;

varying vec3  vColor;
varying float vGlow;
varying float vEdge;
varying float vAlphaMul;

vec3 palette(float rho) {
  vec3 pinkDeep   = vec3(1.000, 0.478, 0.714); // #FF7AB6
  vec3 pinkLight  = vec3(1.000, 0.620, 0.812); // #FF9ECF
  vec3 blueSoft   = vec3(0.560, 0.827, 1.000); // #8FD3FF
  vec3 blueLight  = vec3(0.655, 0.910, 1.000); // #A7E8FF
  vec3 purple     = vec3(0.702, 0.533, 1.000); // #B388FF
  vec3 purpleDeep = vec3(0.608, 0.420, 1.000); // #9B6BFF

  // 花蕊：粉色 + 一点浅蓝，最亮
  vec3 center = mix(pinkLight, blueLight, smoothstep(0.10, 0.30, rho) * 0.45);
  // 花瓣主体：粉（占比最大，一直到 rho≈0.62）
  vec3 petal = mix(pinkDeep, pinkLight, smoothstep(0.16, 0.58, rho) * 0.75);
  // 花瓣外缘：浅蓝 → 紫（只在最外圈出现）
  vec3 edge = mix(pinkLight, blueSoft, smoothstep(0.62, 0.84, rho));
  edge = mix(edge, purple, smoothstep(0.82, 0.95, rho));
  edge = mix(edge, purpleDeep, smoothstep(0.94, 1.0, rho));

  vec3 c = mix(center, petal, smoothstep(0.10, 0.34, rho));
  c = mix(c, edge, smoothstep(0.60, 0.90, rho));
  return c;
}

void main() {
  // 错峰绽放：花心先开、瓣尖和外缘稍后开，中间态才是"花瓣层层舒展"而不是一团模糊
  float delay = 0.28 * (0.45 * aRho + 0.55 * aSeed);
  float local = clamp((uSpread - delay) / max(1.0 - delay, 0.0001), 0.0, 1.0);

  // 平滑缓动，避免张力抖动直接传到视觉
  float e = smoothstep(0.0, 1.0, local);

  // 位置插值：顶点着色器里完成，CPU 每帧只改一个 uniform
  vec3 pos = mix(aBud, aBloom, e);

  // 半开时最明显的扭转：按半径连贯旋转（内圈慢、外圈快），像花瓣向外翻开
  float mid = 4.0 * e * (1.0 - e);
  float ang = mid * (0.26 + 0.30 * aRho);
  float cs = cos(ang), sn = sin(ang);
  pos.xy = mat2(cs, -sn, sn, cs) * pos.xy;

  // 呼吸感
  pos *= 1.0 + 0.014 * sin(uTime * 1.5 + aSeed * 6.2831);

  // 跟随手指：花瓣外缘跟随幅度更大，形成轻微「撩动」
  float follow = 0.06 + 0.14 * aRho;
  pos.x += uHand.x * follow * uHandActive;
  pos.y += uHand.y * follow * uHandActive;

  // 花苞时轻微下垂，绽放时向上舒展
  pos.y += (0.10 * (1.0 - e) - 0.04 * e) * aRho;

  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mv;

  float depthScale = 320.0 / max(-mv.z, 0.001);
  // 花苞时粒子挤在小体积里 → 单颗压暗；绽放时铺开 → 提亮，整体亮度才稳定
  float rim = smoothstep(0.78, 1.0, aEdge);
  gl_PointSize = aSize * uPointScale * uPixelRatio * depthScale * (0.72 + 0.45 * e) * (1.0 + 0.55 * rim);

  vColor = palette(aRho);
  // 花瓣侧缘往浅蓝→紫偏一点，勾出发光的轮廓（最外圈偏紫，避免整圈发青）
  vec3 rimColor = mix(vec3(0.655, 0.910, 1.000), vec3(0.702, 0.533, 1.000), smoothstep(0.45, 1.0, aEdge));
  vColor = mix(vColor, rimColor, rim * 0.50);

  // 花心粒子极密，按粒子大幅压暗，靠叠加自然发光，避免糊成一团白
  float centerDamp = mix(0.28, 1.0, smoothstep(0.02, 0.34, aRho));
  vGlow = mix(0.55, 1.22, e) * (0.80 + 0.30 * aSeed) * centerDamp * (1.0 + 0.40 * rim);
  vEdge = aEdge;
  vAlphaMul = uAlphaMul;
}
`

export const flowerFragmentShader = /* glsl */`
precision highp float;

varying vec3  vColor;
varying float vGlow;
varying float vEdge;
varying float vAlphaMul;

void main() {
  // 圆形柔光点精灵
  vec2 d = gl_PointCoord - vec2(0.5);
  float r = length(d) * 2.0;
  if (r > 1.0) discard;

  float core = pow(1.0 - r, 2.6);       // 亮核
  float halo = pow(1.0 - r, 0.85);      // 外圈光晕

  // 叠加混合很容易过曝：单颗粒子要克制，靠数量堆出光感
  float alpha = (core * 0.66 + halo * 0.17) * vGlow * vAlphaMul;

  vec3 col = vColor * (0.62 + 0.80 * core);
  gl_FragColor = vec4(col, alpha);
}
`

/** 背景星尘：极少量粒子，衬托花体，不抢主体 */
export const dustVertexShader = /* glsl */`
precision highp float;
uniform float uTime;
uniform float uPixelRatio;
attribute float aSeed;
attribute float aSize;
varying float vAlpha;
void main() {
  vec3 p = position;
  p.x += sin(uTime * 0.25 + aSeed * 12.0) * 0.35;
  p.y += cos(uTime * 0.21 + aSeed * 9.0) * 0.28;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = aSize * uPixelRatio * (180.0 / max(-mv.z, 0.001));
  vAlpha = 0.10 + 0.22 * fract(aSeed * 7.13);
}
`

export const dustFragmentShader = /* glsl */`
precision highp float;
varying float vAlpha;
void main() {
  vec2 d = gl_PointCoord - vec2(0.5);
  float r = length(d) * 2.0;
  if (r > 1.0) discard;
  float a = pow(1.0 - r, 2.0) * vAlpha;
  gl_FragColor = vec4(vec3(0.72, 0.82, 1.0), a);
}
`

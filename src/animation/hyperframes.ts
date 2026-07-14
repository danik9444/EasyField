// Builds a HyperFrames composition (a self-contained HTML doc with a GSAP
// timeline on window.__timelines) from the animation settings. The exact same
// HTML is used for the in-panel iframe preview and for `hyperframes render`.
//
// Format per the scaffold: a #root stage with data-composition-id/start/duration
// /width/height, `.clip` children, and a PAUSED gsap timeline the renderer seeks.
// For preview we append `.play()` so the animation runs live in the iframe.
import type { AnimSettings } from '../data/animationConfig'
import { dimsFor } from '../data/animationConfig'
import gsapSourceRaw from 'gsap/dist/gsap.min.js?raw'

const gsapSource = gsapSourceRaw.replace(/<\/script/gi, '<\\/script')

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const seekBridge = `
const EF_CHANNEL = "easyfield-hyperframes-v1";
window.addEventListener("message", (event) => {
  const message = event.data;
  if (!message || message.channel !== EF_CHANNEL || message.type !== "seek") return;
  const current = window.__timelines && window.__timelines.main;
  if (!current) return;
  current.pause();
  current.seek(message.seconds, true);
  requestAnimationFrame(() => requestAnimationFrame(() => parent.postMessage({ channel: EF_CHANNEL, type: "seeked", requestId: message.requestId, frame: message.frame }, "*")));
});
parent.postMessage({ channel: EF_CHANNEL, type: "ready" }, "*");`

// GSAP `from` vars for each preset, applied to the #title clip.
function presetTween(preset: string): string {
  switch (preset) {
    case 'Slide Up':
      return `tl.from("#title", { yPercent: 60, autoAlpha: 0, duration: 0.9, ease: "back.out(1.4)" }, 0);`
    case 'Pop Scale':
      return `tl.from("#title", { scale: 0, autoAlpha: 0, duration: 0.7, ease: "back.out(2)" }, 0);`
    case 'Lower Third':
      return `tl.from("#title", { xPercent: -120, autoAlpha: 0, duration: 0.9, ease: "power3.out" }, 0);`
    case 'Title Card':
      return `tl.from("#title", { scale: 1.14, autoAlpha: 0, letterSpacing: "0.24em", duration: 1.1, ease: "power2.out" }, 0);`
    case 'Kinetic Type':
      return `tl.from("#title .w", { yPercent: 80, rotate: 8, autoAlpha: 0, duration: 0.6, ease: "back.out(1.6)", stagger: 0.09 }, 0);`
    default: // Fade In
      return `tl.from("#title", { autoAlpha: 0, y: 20, duration: 0.9, ease: "power2.out" }, 0);`
  }
}

export function buildHyperframesHtml(s: AnimSettings, assetUrls: string[] = [], opts: { preview?: boolean } = {}): string {
  const { width, height } = dimsFor(s.aspect)
  const light = s.bg.toUpperCase() === '#FFFFFF'
  const fg = light ? '#0E0E13' : '#F5F5FA'
  const previewPlay = opts.preview ? `tl.repeat(-1).repeatDelay(0.9).play();` : ``

  if (s.recipe === 'audio-visualizer') {
    const bars = Array.from({ length: 32 }, (_, index) => `<span class="bar" style="height:${28 + ((index * 29) % 68)}%"></span>`).join('')
    return `<!doctype html><html lang="en"><head><meta charset="UTF-8" />
<meta name="viewport" content="width=${width}, height=${height}" />
<script>${gsapSource}</script>
<style>*{box-sizing:border-box}html,body{margin:0;width:${width}px;height:${height}px;overflow:hidden;background:${s.bg};font-family:Inter,system-ui,sans-serif}#root{position:relative;width:100%;height:100%;display:flex;flex-direction:column;justify-content:center;padding:8%;color:${fg};background:radial-gradient(circle at 45% 45%,${s.accent}35,transparent 60%)}.wave{height:34%;display:flex;align-items:center;gap:${Math.max(3, Math.round(width * 0.004))}px}.bar{flex:1;min-width:2px;border-radius:999px;background:${s.accent};box-shadow:0 0 22px ${s.accent}44;transform-origin:center}.title{margin-top:5%;font-size:${Math.round(width * 0.044)}px;font-weight:800;text-align:center}</style>
</head><body><div id="root" data-composition-id="main" data-start="0" data-duration="${s.durationSec}" data-width="${width}" data-height="${height}"><div class="wave">${bars}</div><div class="title">${esc(s.text)}</div></div>
<script>window.__timelines=window.__timelines||{};const tl=gsap.timeline({paused:true});tl.from(".bar",{scaleY:.12,autoAlpha:.38,duration:.34,ease:"sine.inOut",stagger:{each:.025,from:"center",repeat:5,yoyo:true}},0);tl.from(".title",{y:30,autoAlpha:0,duration:.8,ease:"power2.out"},0);window.__timelines.main=tl;${seekBridge}${previewPlay}</script></body></html>`
  }

  if (s.recipe === 'data-to-video') {
    const bars = Array.from({ length: 5 }, (_, index) => {
      const value = 32 + (((s.text.charCodeAt(index % Math.max(1, s.text.length)) || 65) * (index + 3)) % 68)
      return `<span class="data-bar" style="height:${value}%"></span>`
    }).join('')
    return `<!doctype html><html lang="en"><head><meta charset="UTF-8" />
<meta name="viewport" content="width=${width}, height=${height}" /><script>${gsapSource}</script>
<style>*{box-sizing:border-box}html,body{margin:0;width:${width}px;height:${height}px;overflow:hidden;background:${s.bg};font-family:Inter,system-ui,sans-serif}#root{position:relative;width:100%;height:100%;padding:9%;display:flex;flex-direction:column;justify-content:center;color:${fg};background:radial-gradient(circle at 72% 28%,${s.accent}30,transparent 55%)}.title{max-width:88%;margin-bottom:6%;font-size:${Math.round(width * 0.044)}px;font-weight:800}.chart{height:42%;display:flex;align-items:flex-end;gap:4%}.data-bar{flex:1;border-radius:12px;background:linear-gradient(180deg,${s.accent},${s.accent}66);box-shadow:0 12px 36px ${s.accent}33;transform-origin:bottom}</style>
</head><body><div id="root" data-composition-id="main" data-start="0" data-duration="${s.durationSec}" data-width="${width}" data-height="${height}"><div class="title">${esc(s.text)}</div><div class="chart">${bars}</div></div>
<script>window.__timelines=window.__timelines||{};const tl=gsap.timeline({paused:true});tl.from(".title",{x:-30,autoAlpha:0,duration:.7,ease:"power2.out"},0);tl.from(".data-bar",{scaleY:0,duration:1,ease:"back.out(1.25)",stagger:.1},.15);window.__timelines.main=tl;${seekBridge}${previewPlay}</script></body></html>`
  }

  if (s.recipe === 'smart-captions') {
    const words = s.text.split(/\s+/).filter(Boolean).slice(0, 18).map((word) => `<span>${esc(word)}</span>`).join(' ')
    return `<!doctype html><html lang="en"><head><meta charset="UTF-8" />
<meta name="viewport" content="width=${width}, height=${height}" /><script>${gsapSource}</script>
<style>*{box-sizing:border-box}html,body{margin:0;width:${width}px;height:${height}px;overflow:hidden;background:${s.bg};font-family:Inter,system-ui,sans-serif}#root{position:relative;width:100%;height:100%;background:radial-gradient(circle at 50% 70%,${s.accent}28,transparent 55%)}.captions{position:absolute;left:8%;right:8%;bottom:12%;display:flex;flex-wrap:wrap;justify-content:center;gap:.24em;color:${fg};font-size:${Math.round(width * .045)}px;font-weight:850;line-height:1.18}.captions span{display:inline-block}</style>
</head><body><div id="root" data-composition-id="main" data-start="0" data-duration="${s.durationSec}" data-width="${width}" data-height="${height}"><div class="captions">${words}</div></div>
<script>window.__timelines=window.__timelines||{};const tl=gsap.timeline({paused:true});tl.from(".captions span",{y:24,autoAlpha:0,duration:.35,ease:"back.out(1.4)",stagger:.11},0);window.__timelines.main=tl;${seekBridge}${previewPlay}</script></body></html>`
  }

  // Assets mode — lay out uploaded images (data URLs) with a staggered entrance.
  if (s.mode === 'assets' && assetUrls.length) {
    const cols = assetUrls.length > 1 ? 2 : 1
    const tiles = assetUrls
      .slice(0, 4)
      .map((url, i) => {
        const w = 100 / cols - 6
        const h = assetUrls.length > 2 ? 44 : 80
        const left = (i % cols) * (100 / cols) + 3
        const top = assetUrls.length > 2 ? Math.floor(i / cols) * 48 + 4 : 10
        return `<div class="tile" style="position:absolute;width:${w}%;height:${h}%;left:${left}%;top:${top}%;border-radius:18px;overflow:hidden;box-shadow:0 20px 60px ${s.accent}44;background:url('${url}') center/cover no-repeat"></div>`
      })
      .join('')
    const caption = s.text
      ? `<div id="cap" class="clip" data-start="0" data-duration="${s.durationSec}" style="position:absolute;left:0;right:0;bottom:6%;text-align:center;color:${fg};font-weight:800;font-size:${Math.round(width * 0.05)}px">${esc(s.text)}</div>`
      : ''
    return `<!doctype html><html lang="en"><head><meta charset="UTF-8" />
<meta name="viewport" content="width=${width}, height=${height}" />
<script>${gsapSource}</script>
<style>*{margin:0;padding:0;box-sizing:border-box}html,body{width:${width}px;height:${height}px;overflow:hidden;background:${s.bg};font-family:Inter,system-ui,sans-serif}#root{position:relative;width:${width}px;height:${height}px}</style>
</head><body>
<div id="root" data-composition-id="main" data-start="0" data-duration="${s.durationSec}" data-width="${width}" data-height="${height}">${tiles}${caption}</div>
<script>
window.__timelines = window.__timelines || {};
const tl = gsap.timeline({ paused: true });
tl.from(".tile", { yPercent: 40, scale: 0.9, autoAlpha: 0, duration: 0.8, ease: "back.out(1.3)", stagger: 0.18 }, 0);
${caption ? `tl.from("#cap", { y: 30, autoAlpha: 0, duration: 0.8 }, 0.4);` : ''}
window.__timelines["main"] = tl;
${seekBridge}
${previewPlay}
</script></body></html>`
  }

  const isLowerThird = s.preset === 'Lower Third'
  const isKinetic = s.preset === 'Kinetic Type'
  const titleSize = Math.round(width * (s.mode === 'prompt' ? 0.058 : 0.072))

  const inner = isLowerThird
    ? `<div class="bar">${esc(s.text)}</div>`
    : isKinetic
      ? s.text
          .split(' ')
          .map((w) => `<span class="w">${esc(w)}</span>`)
          .join(' ')
      : esc(s.text)

  const titleStyle = isLowerThird
    ? `position:absolute;left:6%;bottom:9%;`
    : `position:absolute;inset:0;display:flex;align-items:center;justify-content:center;text-align:center;padding:0 5%;color:${fg};font-weight:800;font-size:${titleSize}px;line-height:1.08;text-shadow:${light ? 'none' : `0 6px 40px ${s.accent}66`};`

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=${width}, height=${height}" />
<script>${gsapSource}</script>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  html,body{width:${width}px;height:${height}px;overflow:hidden;background:${s.bg};font-family:Inter,system-ui,sans-serif}
  #root{position:relative;width:${width}px;height:${height}px}
  .glow{position:absolute;inset:0;background:radial-gradient(60% 60% at 42% 34%, ${s.accent}55, transparent 70%);filter:blur(8px)}
  .glow2{position:absolute;inset:0;background:radial-gradient(52% 52% at 70% 76%, ${s.accent}33, transparent 70%)}
  .w{display:inline-block;margin-right:.26em}
  .bar{display:inline-block;background:${s.accent};color:#0E0E13;font-weight:800;font-size:${Math.round(width * 0.035)}px;padding:.3em .7em;border-radius:12px}
</style>
</head>
<body>
  <div id="root" data-composition-id="main" data-start="0" data-duration="${s.durationSec}" data-width="${width}" data-height="${height}">
    ${isLowerThird ? '' : '<div class="glow"></div><div class="glow2"></div>'}
    <div id="title" class="clip" data-start="0" data-duration="${s.durationSec}" data-track-index="1" style="${titleStyle}">${inner}</div>
  </div>
  <script>
    window.__timelines = window.__timelines || {};
    const tl = gsap.timeline({ paused: true });
    ${presetTween(s.preset)}
    window.__timelines["main"] = tl;
    ${seekBridge}
    ${previewPlay}
  </script>
</body>
</html>`
}

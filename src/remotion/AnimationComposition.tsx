import React from 'react'
import { AbsoluteFill, Img, Sequence, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion'
import type { AnimRecipeId } from '../data/animationConfig'

// One composition drives all three modes. It's a plain React component, so the
// exact same code runs in the in-panel <Player> preview and in the Node renderer.
// A `type` (not interface) so it satisfies Remotion's `Record<string, unknown>`
// props constraint.
export type AnimProps = {
  mode: string
  recipe?: AnimRecipeId
  text: string
  preset: string
  accent: string
  bg: string
  assetUrls: string[]
  // Read by the render entry's calculateMetadata (ignored by the component,
  // which gets fps/size from useVideoConfig). The <Player> sets these directly.
  fps?: number
  durationSec?: number
  width?: number
  height?: number
}

const clamp = { extrapolateLeft: 'clamp' as const, extrapolateRight: 'clamp' as const }

// Per-preset transform for a single animated block, driven by the frame.
function presetStyle(preset: string, frame: number, fps: number, i = 0): React.CSSProperties {
  const stagger = i * 6
  const f = Math.max(0, frame - stagger)
  switch (preset) {
    case 'Slide Up': {
      const s = spring({ frame: f, fps, config: { damping: 16, mass: 0.7 } })
      return { transform: `translateY(${interpolate(s, [0, 1], [90, 0])}px)`, opacity: interpolate(f, [0, 14], [0, 1], clamp) }
    }
    case 'Pop Scale': {
      const s = spring({ frame: f, fps, config: { damping: 9, mass: 0.6, stiffness: 120 } })
      return { transform: `scale(${s})`, opacity: interpolate(f, [0, 6], [0, 1], clamp) }
    }
    case 'Kinetic Type': {
      const s = spring({ frame: f, fps, config: { damping: 12 } })
      return {
        display: 'inline-block',
        transform: `translateY(${interpolate(s, [0, 1], [40, 0])}px) rotate(${interpolate(s, [0, 1], [8, 0])}deg)`,
        opacity: interpolate(f, [0, 8], [0, 1], clamp),
        marginRight: '0.28em',
      }
    }
    case 'Lower Third': {
      const inX = interpolate(spring({ frame: f, fps, config: { damping: 18 } }), [0, 1], [-120, 0])
      return { transform: `translateX(${inX}%)`, opacity: interpolate(f, [0, 10], [0, 1], clamp) }
    }
    case 'Title Card': {
      const s = spring({ frame: f, fps, config: { damping: 20 } })
      return {
        transform: `scale(${interpolate(s, [0, 1], [1.12, 1])})`,
        opacity: interpolate(f, [0, 18], [0, 1], clamp),
        letterSpacing: `${interpolate(s, [0, 1], [0.22, 0.02], clamp)}em`,
      }
    }
    default: // Fade In
      return { opacity: interpolate(f, [0, 20], [0, 1], clamp), transform: `translateY(${interpolate(f, [0, 20], [12, 0], clamp)}px)` }
  }
}

// Soft drifting accent glows behind the content (used by prompt + preset modes).
const Backdrop: React.FC<{ accent: string; bg: string }> = ({ accent, bg }) => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const drift = Math.sin((frame / fps) * 0.8)
  return (
    <AbsoluteFill style={{ background: bg }}>
      <AbsoluteFill
        style={{
          background: `radial-gradient(60% 60% at ${40 + drift * 12}% 35%, ${accent}55, transparent 70%)`,
          filter: 'blur(8px)',
        }}
      />
      <AbsoluteFill
        style={{
          background: `radial-gradient(50% 50% at ${70 - drift * 10}% 75%, ${accent}33, transparent 70%)`,
        }}
      />
    </AbsoluteFill>
  )
}

export const AnimationComposition: React.FC<AnimProps> = ({ mode, recipe = 'custom', text, preset, accent, bg, assetUrls }) => {
  const frame = useCurrentFrame()
  const { fps, width } = useVideoConfig()
  const light = bg.toUpperCase() === '#FFFFFF'
  const fg = light ? '#0E0E13' : '#F5F5FA'

  if (recipe === 'audio-visualizer') {
    const bars = Array.from({ length: 32 }, (_, index) => {
      const wave = (Math.sin(frame / Math.max(1, fps / 8) + index * 0.72) + 1) / 2
      const envelope = 0.32 + ((index * 17) % 11) / 16
      return Math.max(8, wave * envelope * 100)
    })
    return (
      <AbsoluteFill style={{ background: bg, color: fg, fontFamily: 'Inter, system-ui, sans-serif', justifyContent: 'center', padding: '8%' }}>
        <Backdrop accent={accent} bg={bg} />
        <div style={{ position: 'relative', zIndex: 1, display: 'flex', height: '34%', alignItems: 'center', gap: width * 0.004 }}>
          {bars.map((value, index) => <div key={index} style={{ flex: 1, minWidth: 2, height: `${value}%`, borderRadius: 999, background: accent, boxShadow: `0 0 22px ${accent}44` }} />)}
        </div>
        <div style={{ position: 'relative', zIndex: 1, marginTop: '5%', fontSize: width * 0.044, fontWeight: 800, textAlign: 'center', ...presetStyle('Slide Up', frame, fps) }}>{text}</div>
      </AbsoluteFill>
    )
  }

  if (recipe === 'data-to-video') {
    const values = Array.from({ length: 5 }, (_, index) => 32 + ((text.charCodeAt(index % Math.max(1, text.length)) || 65) * (index + 3)) % 68)
    const reveal = spring({ frame, fps, config: { damping: 18 } })
    return (
      <AbsoluteFill style={{ background: bg, color: fg, fontFamily: 'Inter, system-ui, sans-serif', padding: '9%', justifyContent: 'center' }}>
        <Backdrop accent={accent} bg={bg} />
        <div style={{ position: 'relative', zIndex: 1, fontSize: width * 0.044, fontWeight: 800, marginBottom: '6%', maxWidth: '88%' }}>{text}</div>
        <div style={{ position: 'relative', zIndex: 1, height: '42%', display: 'flex', alignItems: 'flex-end', gap: '4%' }}>
          {values.map((value, index) => (
            <div key={index} style={{ flex: 1, height: `${value * reveal}%`, borderRadius: 12, background: `linear-gradient(180deg, ${accent}, ${accent}66)`, boxShadow: `0 12px 36px ${accent}33` }} />
          ))}
        </div>
      </AbsoluteFill>
    )
  }

  if (recipe === 'smart-captions') {
    const captionWords = text.split(/\s+/).filter(Boolean).slice(0, 18)
    const active = captionWords.length ? Math.floor(frame / Math.max(1, fps * 0.35)) % captionWords.length : 0
    return (
      <AbsoluteFill style={{ background: bg, fontFamily: 'Inter, system-ui, sans-serif' }}>
        <Backdrop accent={accent} bg={bg} />
        <div style={{ position: 'absolute', zIndex: 1, left: '8%', right: '8%', bottom: '12%', display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: '0.24em', fontSize: width * 0.045, fontWeight: 850, lineHeight: 1.18 }}>
          {captionWords.map((word, index) => <span key={`${word}-${index}`} style={{ color: index === active ? '#0E0E13' : fg, background: index === active ? accent : 'transparent', padding: index === active ? '0.05em 0.18em' : '0.05em 0', borderRadius: 8 }}>{word}</span>)}
        </div>
      </AbsoluteFill>
    )
  }

  if (mode === 'assets' && assetUrls.length) {
    return (
      <AbsoluteFill style={{ background: bg }}>
        {assetUrls.slice(0, 4).map((url, i) => {
          const s = spring({ frame: frame - i * 8, fps, config: { damping: 15 } })
          const cols = assetUrls.length > 1 ? 2 : 1
          return (
            <div
              key={url}
              style={{
                position: 'absolute',
                width: `${100 / cols - 6}%`,
                height: assetUrls.length > 2 ? '44%' : '80%',
                left: `${(i % cols) * (100 / cols) + 3}%`,
                top: assetUrls.length > 2 ? `${Math.floor(i / cols) * 48 + 4}%` : '10%',
                opacity: s,
                transform: `translateY(${interpolate(s, [0, 1], [50, 0])}px) scale(${interpolate(s, [0, 1], [0.9, 1])})`,
                borderRadius: 18,
                overflow: 'hidden',
                boxShadow: `0 20px 60px ${accent}44`,
              }}
            >
              <Img src={url} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            </div>
          )
        })}
        {text && (
          <div style={{ position: 'absolute', bottom: '6%', left: 0, right: 0, textAlign: 'center', color: fg, fontSize: width * 0.05, fontWeight: 800, ...presetStyle('Slide Up', frame, fps) }}>
            {text}
          </div>
        )}
      </AbsoluteFill>
    )
  }

  const words = text.split(' ')
  const kinetic = preset === 'Kinetic Type'
  const isLowerThird = preset === 'Lower Third'

  return (
    <AbsoluteFill style={{ alignItems: 'center', justifyContent: isLowerThird ? 'flex-end' : 'center', fontFamily: 'Inter, system-ui, sans-serif' }}>
      <Backdrop accent={accent} bg={bg} />
      {isLowerThird ? (
        <div style={{ marginBottom: '9%', marginLeft: '6%', alignSelf: 'flex-start', ...presetStyle(preset, frame, fps) }}>
          <div style={{ background: accent, color: '#0E0E13', fontWeight: 800, fontSize: width * 0.035, padding: '0.3em 0.7em', borderRadius: 10, display: 'inline-block' }}>{text}</div>
        </div>
      ) : (
        <Sequence style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div
            style={{
              color: fg,
              fontWeight: 800,
              fontSize: width * (mode === 'prompt' ? 0.058 : 0.072),
              lineHeight: 1.08,
              textAlign: 'center',
              maxWidth: '82%',
              padding: '0 4%',
              textShadow: light ? 'none' : `0 6px 40px ${accent}66`,
              ...(kinetic ? {} : presetStyle(preset, frame, fps)),
            }}
          >
            {kinetic
              ? words.map((w, i) => (
                  <span key={i} style={presetStyle(preset, frame, fps, i)}>
                    {w}
                  </span>
                ))
              : text}
          </div>
        </Sequence>
      )}
    </AbsoluteFill>
  )
}

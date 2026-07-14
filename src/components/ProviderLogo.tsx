import type { CSSProperties } from 'react'
import alibabaLogo from '../assets/providers/alibaba.svg'
import anthropicLogo from '../assets/providers/anthropic.svg'
import blackForestLogo from '../assets/providers/blackforest.svg'
import byteDanceLogo from '../assets/providers/bytedance.svg'
import davinciLogo from '../assets/providers/davinci.svg'
import elevenLabsLogo from '../assets/providers/elevenlabs.svg'
import googleLogo from '../assets/providers/google.svg'
import hyperFramesLogo from '../assets/providers/hyperframes.svg'
import ideogramLogo from '../assets/providers/ideogram.svg'
import kuaishouLogo from '../assets/providers/kuaishou.svg'
import minimaxLogo from '../assets/providers/minimax.svg'
import openaiLogo from '../assets/providers/openai.svg'
import recraftLogo from '../assets/providers/recraft.svg'
import runwayLogo from '../assets/providers/runway.svg'
import sunoLogo from '../assets/providers/suno.svg'
import topazLogo from '../assets/providers/topaz.svg'
import volcengineLogo from '../assets/providers/volcengine.svg'
import xaiLogo from '../assets/providers/xai.svg'
import { PROVIDER_BRANDS, type ProviderBrandId } from '../data/providerBrands'

const PROVIDER_ASSETS: Partial<Record<ProviderBrandId, string>> = {
  openai: openaiLogo,
  anthropic: anthropicLogo,
  bytedance: byteDanceLogo,
  google: googleLogo,
  blackforest: blackForestLogo,
  alibaba: alibabaLogo,
  kuaishou: kuaishouLogo,
  xai: xaiLogo,
  minimax: minimaxLogo,
  runway: runwayLogo,
  suno: sunoLogo,
  elevenlabs: elevenLabsLogo,
  ideogram: ideogramLogo,
  topaz: topazLogo,
  recraft: recraftLogo,
  volcengine: volcengineLogo,
  davinci: davinciLogo,
  hyperframes: hyperFramesLogo,
}

interface ProviderLogoProps {
  brand: ProviderBrandId
  size?: number
  className?: string
}

type ProviderLogoStyle = CSSProperties & {
  '--ef-provider-logo'?: string
  '--ef-provider-color': string
}

function LocalProviderGlyph({ brand }: { brand: ProviderBrandId }) {
  if (brand === 'librosa') {
    return (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M3 14v-4M7 18V6M11 15V9M15 20V4M19 16V8M22 13v-2" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      </svg>
    )
  }
  if (brand === 'remotion') {
    return (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M12 2.8 21 20H3L12 2.8Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
        <path d="M12 8.2 16.8 17H7.2L12 8.2Z" fill="currentColor" />
      </svg>
    )
  }
  if (brand === 'cloud') {
    return (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M7.4 18.5h9.2a4.1 4.1 0 0 0 .5-8.17A5.7 5.7 0 0 0 6.23 8.9 4.85 4.85 0 0 0 7.4 18.5Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
        <path d="m12 8 .65 1.85L14.5 10.5l-1.85.65L12 13l-.65-1.85-1.85-.65 1.85-.65L12 8Z" fill="currentColor" />
      </svg>
    )
  }
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="m12 2.7 1.55 5.75L19.3 10l-5.75 1.55L12 17.3l-1.55-5.75L4.7 10l5.75-1.55L12 2.7Z" fill="currentColor" />
      <circle cx="18.5" cy="17.8" r="2.2" fill="currentColor" opacity=".56" />
    </svg>
  )
}

export function ProviderLogo({ brand, size = 22, className = '' }: ProviderLogoProps) {
  const asset = PROVIDER_ASSETS[brand]
  const definition = PROVIDER_BRANDS[brand]
  const style: ProviderLogoStyle = {
    width: size,
    height: size,
    '--ef-provider-color': definition.color,
    ...(asset ? { '--ef-provider-logo': `url("${asset}")` } : {}),
  }

  return (
    <span
      className={`ef-provider-logo${asset ? ' has-mask' : ' has-glyph'}${className ? ` ${className}` : ''}`}
      data-provider-logo={brand}
      data-provider-name={definition.label}
      style={style}
      title={definition.label}
      aria-hidden="true"
    >
      {!asset && <LocalProviderGlyph brand={brand} />}
    </span>
  )
}

import { useMemo } from 'react'
import type { ModelDefinition } from '../core/contracts'
import { resolveProviderBrand } from '../data/providerBrands'
import { Dropdown, type DropdownOptionMeta } from './Dropdown'

interface ModelBrowserProps {
  models: ModelDefinition[]
  value?: string
  onChange: (modelId: string) => void
  label?: string
  stepNumber?: string
}

function providerGroup(model: ModelDefinition): string {
  if (model.provider === 'local') return 'On this Mac'
  if (model.provider === 'resolve') return 'DaVinci Resolve'

  const key = `${model.id} ${model.name}`.toLowerCase()
  if (key.includes('seedream')) return 'Seedream'
  if (key.includes('nano-banana')) return 'Nano Banana'
  if (key.includes('gemini') || key.includes('veo')) return 'Google'
  if (key.includes('kling')) return 'Kling'
  if (key.includes('omnihuman')) return 'OmniHuman'
  if (key.includes('infinitalk')) return 'InfiniteTalk'
  if (key.includes('volcengine')) return 'Volcengine'
  if (key.includes('grok')) return 'Grok Imagine'
  if (key.includes('wan')) return 'Wan'
  if (key.includes('suno')) return 'Suno Sounds'
  return 'Kie Cloud'
}

function priceLabel(model: ModelDefinition): string {
  if (!model.available) return 'Adapter planned'
  if (model.priceCredits == null) return 'Price confirmed before run'
  if (model.priceCredits === 0) return 'Free · local'
  return `${model.priceCredits} credits${model.priceUnit ? ` / ${model.priceUnit}` : ''}`
}

export function ModelBrowser({ models, value, onChange, label = 'Model', stepNumber = '04' }: ModelBrowserProps) {
  const selected = models.find((model) => model.id === value) ?? models[0]

  const optionMeta = useMemo<Record<string, DropdownOptionMeta>>(() => Object.fromEntries(
    models.map((model) => {
      const recommendation = model.recommendation?.toUpperCase()
      const summary = model.recommendationReason ?? model.recommendedFor.slice(0, 3).join(' · ')
      return [model.name, {
        group: providerGroup(model),
        eyebrow: model.provider === 'kie' ? 'KIE CLOUD' : model.provider.toUpperCase(),
        badge: model.available ? recommendation : 'PLANNED',
        description: [summary, priceLabel(model)].filter(Boolean).join(' · '),
        searchTerms: [
          model.provider,
          ...model.recommendedFor,
          ...model.capabilities.map((capability) => capability.label),
          ...model.inputKinds,
          ...model.outputKinds,
        ],
        disabled: !model.available,
        disabledReason: model.unavailableReason,
        providerBrand: resolveProviderBrand(model.name, model.id, model.provider) ?? 'kie',
      } satisfies DropdownOptionMeta]
    }),
  ), [models])

  if (!models.length || !selected) {
    return (
      <div className="ef-mb-empty" role="status">
        <span>{label}</span>
        <strong>No validated adapter yet</strong>
      </div>
    )
  }

  return (
    <div className="ef-model-browser ef-model-browser--anchored">
      <span className="ef-field-label">{stepNumber} · {label}</span>
      <Dropdown
        options={models.map((model) => model.name)}
        selected={selected.name}
        onSelect={(modelName) => {
          const model = models.find((candidate) => candidate.name === modelName)
          if (model?.available) onChange(model.id)
        }}
        label={label}
        align="left"
        variant="field"
        optionMeta={optionMeta}
        searchable={models.length >= 6}
      />
    </div>
  )
}

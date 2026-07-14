import { formatEstimate, priceSourceLabel, type Estimate } from '../data/pricing'

export function PriceEstimate({ estimate }: { estimate: Estimate }) {
  return (
    <div className="ef-price">
      <span className="ef-price-label">EST. COST</span>
      <span className="ef-spacer" />
      <span className="ef-price-value">
        <span
          className={`ef-price-source is-${estimate.source ?? 'fallback'}`}
          title={estimate.source === 'live' ? 'Live cloud pricing' : estimate.source === 'fallback' ? 'Current dated fallback; live feed unavailable' : undefined}
        >
          {priceSourceLabel(estimate)}
        </span>
        {formatEstimate(estimate, false)}
      </span>
    </div>
  )
}

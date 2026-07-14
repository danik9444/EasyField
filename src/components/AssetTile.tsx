import { Icon } from '../icons'
import type { Asset } from '../data/library'

export function AssetTile({ asset, onClick }: { asset: Asset; onClick?: () => void }) {
  return (
    <button className={'ef-asset-tile ef-asset-tile--' + asset.kind} onClick={onClick}>
      {asset.kind === 'video' && (
        <span className="ef-asset-play">▶</span>
      )}
      {asset.kind === 'audio' && (
        <span className="ef-asset-audio-icon">
          <Icon glyph="music" size={16} />
        </span>
      )}
      <span className="ef-asset-meta">{asset.meta}</span>
      <span className="ef-asset-overlay">
        <span className="ef-asset-name">{asset.name}</span>
      </span>
    </button>
  )
}

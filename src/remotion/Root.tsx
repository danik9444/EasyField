import { Composition } from 'remotion'
import { AnimationComposition, type AnimProps } from './AnimationComposition'

const DEFAULTS: AnimProps = {
  mode: 'presets',
  text: 'EasyField',
  preset: 'Fade In',
  accent: '#E26BD2',
  bg: '#0E0E13',
  assetUrls: [],
  fps: 30,
  durationSec: 5,
  width: 1920,
  height: 1080,
}

// Registered composition the local renderer (`npx remotion render`) targets.
// Duration + size come from the props passed on the CLI via calculateMetadata.
export const RemotionRoot: React.FC = () => (
  <Composition
    id="Animation"
    component={AnimationComposition}
    durationInFrames={150}
    fps={30}
    width={1920}
    height={1080}
    defaultProps={DEFAULTS}
    calculateMetadata={({ props }) => ({
      durationInFrames: Math.max(1, Math.round((props.durationSec ?? 5) * (props.fps ?? 30))),
      fps: props.fps ?? 30,
      width: props.width ?? 1920,
      height: props.height ?? 1080,
    })}
  />
)

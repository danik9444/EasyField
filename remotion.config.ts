// Config for the local Remotion renderer (`npx remotion render src/remotion/index.ts Animation …`).
import { Config } from '@remotion/cli/config'

Config.setVideoImageFormat('jpeg')
Config.overrideWebpackConfig((c) => c)

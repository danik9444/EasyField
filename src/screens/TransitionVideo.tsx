import { CreateVideo, type CreateVideoProps } from './CreateVideo'

export function TransitionVideo(props: Omit<CreateVideoProps, 'mode'>) {
  return <CreateVideo {...props} mode="transition" />
}

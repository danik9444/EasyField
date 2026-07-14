import { CreateVideo, type CreateVideoProps } from './CreateVideo'

// Extend intentionally shares the complete Create Video workspace so drafts,
// pricing, jobs, Library ingestion, review and placement never drift apart.
export function ExtendVideo(props: Omit<CreateVideoProps, 'mode'>) {
  return <CreateVideo {...props} mode="extend" />
}

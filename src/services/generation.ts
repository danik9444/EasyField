// Local, non-kie helper data. Real media generation lives in services/run.ts and
// prompt enhancement in services/chat.ts (both call kie.ai). What remains here is
// the SuperBrain demo plan.

export interface PlanStep {
  name: string
  cat: string
  color: string
}

export const BRAIN_PLAN: PlanStep[] = [
  { name: 'LUTs', cat: 'FOOTAGE', color: '#9BA3B5' },
  { name: 'Captions', cat: 'MOTION', color: '#FFB454' },
  { name: 'Music', cat: 'AUDIO', color: '#3ED598' },
]

export const PLAN_STEP_MS = 950

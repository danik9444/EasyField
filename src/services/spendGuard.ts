import type { Estimate } from '../data/pricing'

export interface SpendApproval {
  approved: boolean
  estimatedCredits: number | null
  ceiling: number
  reason?: string
}

/**
 * Pricing is informational. EasyField deliberately does not impose a local
 * spend ceiling: unknown prices and per-second rates may proceed, while the
 * provider still enforces the account's real balance and rate limits.
 *
 * The compatibility shape remains because older screens and durable drafts
 * still call this helper. It must never become a generation gate again.
 */
export function getSpendApproval(estimate: Estimate, ceiling: number): SpendApproval {
  void ceiling
  return {
    approved: true,
    estimatedCredits: estimate.credits != null && Number.isFinite(estimate.credits) ? estimate.credits : null,
    ceiling: Number.POSITIVE_INFINITY,
  }
}

export class SpendApprovalError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SpendApprovalError'
  }
}

export function assertSpendApproved(estimate: Estimate, action: string, ceiling: number): SpendApproval {
  const approval = getSpendApproval(estimate, ceiling)
  if (!approval.approved) throw new SpendApprovalError(`${action} was not started. ${approval.reason}`)
  return approval
}

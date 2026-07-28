/**
 * Sample data for fixture mode.
 *
 * These shapes mirror what the easyfield-admin SQL wrappers return, so the
 * console renders the same fields it will receive from a real deployment.
 * Amounts are integer micro-unit strings exactly as the database emits them —
 * using convenient numbers here would hide the formatting bugs this data exists
 * to catch.
 */

import type { AdminUser, AuditPage, CreditDetail, Incidents, Overview, UserDetail } from './api'

const HOUR = 3_600_000
const DAY = 24 * HOUR

function isoAgo(offsetMs: number): string {
  return new Date(Date.now() - offsetMs).toISOString()
}

const OWNER = '0f2b7c1e-9d84-4a6f-b3c2-15a7e4d80931'
const CUSTOMER_A = '7c1d5a92-3e64-4b18-9f27-6ad3c8b41052'
const CUSTOMER_B = 'b48e2f07-6a15-4c93-8d51-2e97f306a4c8'
const SUPPORT = '2a9f6013-8c47-4e52-b761-93d05fa27e4b'
const CUSTOMER_C = 'd51c8b34-7f29-4a06-9e83-4b62c17d0af5'

const users: AdminUser[] = [
  {
    userId: OWNER,
    email: 'owner@easyfield.test',
    platformRole: 'admin',
    createdAt: isoAgo(90 * DAY),
    emailConfirmed: true,
    banned: false,
    deleted: false,
    availableMicrocredits: '0',
    subscriptionStatus: null,
    planKey: null,
  },
  {
    userId: CUSTOMER_A,
    email: 'dana@studio.test',
    platformRole: 'customer',
    createdAt: isoAgo(41 * DAY),
    emailConfirmed: true,
    banned: false,
    deleted: false,
    availableMicrocredits: '1483920000',
    subscriptionStatus: 'active',
    planKey: 'creator',
  },
  {
    userId: SUPPORT,
    email: 'rota@easyfield.test',
    platformRole: 'support',
    createdAt: isoAgo(30 * DAY),
    emailConfirmed: true,
    banned: false,
    deleted: false,
    availableMicrocredits: '0',
    subscriptionStatus: null,
    planKey: null,
  },
  {
    userId: CUSTOMER_B,
    email: 'noa@posthouse.test',
    platformRole: 'customer',
    createdAt: isoAgo(12 * DAY),
    emailConfirmed: true,
    banned: false,
    deleted: false,
    availableMicrocredits: '4920500000',
    subscriptionStatus: 'past_due',
    planKey: 'pro',
  },
  {
    userId: CUSTOMER_C,
    email: 'unverified@studio.test',
    platformRole: 'customer',
    createdAt: isoAgo(2 * DAY),
    emailConfirmed: false,
    banned: false,
    deleted: false,
    availableMicrocredits: '0',
    subscriptionStatus: null,
    planKey: null,
  },
]

const overview: Overview = {
  generatedAt: isoAgo(0),
  users: { total: 5, customers: 3, support: 1, admins: 1 },
  subscriptions: { active: 1, past_due: 1, canceled: 2 },
  credits: {
    availableMicrocredits: '6404420000',
    reservedMicrocredits: '120000000',
    lifetimeGrantedMicrocredits: '14000000000',
    lifetimeConsumedMicrocredits: '7475580000',
  },
  checkouts: { completed: 4, open: 1, failed: 2 },
}

const details: Record<string, UserDetail> = {
  [CUSTOMER_A]: {
    profile: {
      userId: CUSTOMER_A,
      email: 'dana@studio.test',
      platformRole: 'customer',
      createdAt: isoAgo(41 * DAY),
      emailConfirmed: true,
      banned: false,
      deleted: false,
      lastSignInAt: isoAgo(3 * HOUR),
    },
    creditAccount: {
      availableMicrocredits: '1483920000',
      reservedMicrocredits: '20000000',
      lifetimeGrantedMicrocredits: '6000000000',
      lifetimeConsumedMicrocredits: '4496080000',
      lifetimeExpiredMicrocredits: '0',
      updatedAt: isoAgo(2 * HOUR),
    },
    subscriptions: [
      {
        id: 'c3f8a1d2-4b57-4e69-9a03-8d12f5e7b640',
        planKey: 'creator',
        billingInterval: 'annual',
        status: 'active',
        currentPeriodStart: isoAgo(41 * DAY),
        currentPeriodEnd: isoAgo(-324 * DAY),
        cancelAtPeriodEnd: false,
        unitAmountCurrencyMicros: '240000000',
        currencyCode: 'USD',
      },
    ],
    autoReload: { enabled: true, planKey: 'creator' },
    partnerEntitlement: null,
    roleHistory: [],
  },
  [CUSTOMER_B]: {
    profile: {
      userId: CUSTOMER_B,
      email: 'noa@posthouse.test',
      platformRole: 'customer',
      createdAt: isoAgo(12 * DAY),
      emailConfirmed: true,
      banned: false,
      deleted: false,
      lastSignInAt: isoAgo(26 * HOUR),
    },
    creditAccount: {
      availableMicrocredits: '4920500000',
      reservedMicrocredits: '100000000',
      lifetimeGrantedMicrocredits: '5000000000',
      lifetimeConsumedMicrocredits: '79500000',
      lifetimeExpiredMicrocredits: '0',
      updatedAt: isoAgo(26 * HOUR),
    },
    subscriptions: [
      {
        id: '9e4b7c02-1f83-4d56-b0a9-7c35e2f18d64',
        planKey: 'pro',
        billingInterval: 'monthly',
        status: 'past_due',
        currentPeriodStart: isoAgo(12 * DAY),
        currentPeriodEnd: isoAgo(-18 * DAY),
        cancelAtPeriodEnd: false,
        unitAmountCurrencyMicros: '60000000',
        currencyCode: 'USD',
      },
    ],
    autoReload: { enabled: false, planKey: null },
    partnerEntitlement: null,
    roleHistory: [],
  },
  [SUPPORT]: {
    profile: {
      userId: SUPPORT,
      email: 'rota@easyfield.test',
      platformRole: 'support',
      createdAt: isoAgo(30 * DAY),
      emailConfirmed: true,
      banned: false,
      deleted: false,
      lastSignInAt: isoAgo(5 * HOUR),
    },
    creditAccount: null,
    subscriptions: [],
    autoReload: null,
    partnerEntitlement: null,
    roleHistory: [],
  },
  [OWNER]: {
    profile: {
      userId: OWNER,
      email: 'owner@easyfield.test',
      platformRole: 'admin',
      createdAt: isoAgo(90 * DAY),
      emailConfirmed: true,
      banned: false,
      deleted: false,
      lastSignInAt: isoAgo(1 * HOUR),
    },
    creditAccount: null,
    subscriptions: [],
    autoReload: null,
    partnerEntitlement: null,
    roleHistory: [],
  },
  [CUSTOMER_C]: {
    profile: {
      userId: CUSTOMER_C,
      email: 'unverified@studio.test',
      platformRole: 'customer',
      createdAt: isoAgo(2 * DAY),
      emailConfirmed: false,
      banned: false,
      deleted: false,
      lastSignInAt: null,
    },
    creditAccount: null,
    subscriptions: [],
    autoReload: null,
    partnerEntitlement: null,
    roleHistory: [],
  },
}

const credits: Record<string, CreditDetail> = {
  [CUSTOMER_A]: {
    lots: [
      {
        id: 'a1e5c930-2f74-4b68-9d01-5c83a2e40b76',
        sourceType: 'subscription',
        totalMicrocredits: '2000000000',
        availableMicrocredits: '1483920000',
        grantedAt: isoAgo(11 * DAY),
        expiresAt: isoAgo(-19 * DAY),
      },
      {
        id: 'f7b2d418-6c93-4a05-8e27-1d94b6f03a5c',
        sourceType: 'subscription',
        totalMicrocredits: '2000000000',
        availableMicrocredits: '0',
        grantedAt: isoAgo(41 * DAY),
        expiresAt: isoAgo(11 * DAY),
      },
    ],
    ledger: [
      {
        id: '4821',
        entryType: 'capture',
        availableDeltaMicrocredits: '0',
        consumedDeltaMicrocredits: '18400000',
        referenceType: 'generation',
        createdAt: isoAgo(2 * HOUR),
      },
      {
        id: '4820',
        entryType: 'reserve',
        availableDeltaMicrocredits: '-20000000',
        consumedDeltaMicrocredits: '0',
        referenceType: 'generation',
        createdAt: isoAgo(2 * HOUR),
      },
      {
        id: '4102',
        entryType: 'grant',
        availableDeltaMicrocredits: '2000000000',
        consumedDeltaMicrocredits: '0',
        referenceType: 'subscription',
        createdAt: isoAgo(11 * DAY),
      },
    ],
  },
}

const incidents: Incidents = {
  ambiguousCheckouts: [
    {
      id: '6d3a9f21-4c85-4e70-b219-8f04c7d5a3e6',
      intentType: 'subscription',
      status: 'failed',
      updatedAt: isoAgo(4 * HOUR),
    },
    {
      id: '1b7e4c58-9a26-4d13-8f60-3c95e2a7b0d4',
      intentType: 'top-up',
      status: 'expired',
      updatedAt: isoAgo(2 * DAY),
    },
  ],
  openCheckouts: [
    {
      id: 'e2c60b17-5d38-4f94-a70b-6912d4c83f5a',
      intentType: 'subscription',
      status: 'open',
      createdAt: isoAgo(35 * 60_000),
    },
  ],
  unresolvedRenewals: [
    {
      id: '8f14b6d0-3e72-4c59-9a86-0b47e1f5c298',
      planKey: 'pro',
      state: 'charging',
      createdAt: isoAgo(50 * 60_000),
    },
  ],
  pendingGrants: [
    {
      id: '5a97e3c2-1b64-4f08-8d35-7e21a9c46b03',
      status: 'pending',
      grantNumber: 2,
      scheduledFor: isoAgo(-19 * DAY),
    },
  ],
}

const audit: AuditPage = {
  entries: [
    {
      id: '312',
      targetUserId: SUPPORT,
      targetEmail: 'rota@easyfield.test',
      actorUserId: OWNER,
      actorEmail: 'owner@easyfield.test',
      previousRole: 'customer',
      newRole: 'support',
      reason: 'Joining the billing support rota',
      createdAt: isoAgo(30 * DAY),
    },
    {
      id: '118',
      targetUserId: OWNER,
      targetEmail: 'owner@easyfield.test',
      actorUserId: null,
      actorEmail: null,
      previousRole: 'customer',
      newRole: 'admin',
      reason: 'One-time trusted database bootstrap by normalized auth email',
      createdAt: isoAgo(90 * DAY),
    },
  ],
}

export const FIXTURES = {
  actorUserId: OWNER,
  actorEmail: 'owner@easyfield.test',
  users,
  overview,
  details,
  credits,
  incidents,
  audit,
}

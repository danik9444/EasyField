/**
 * Routing a reversal webhook.
 *
 * The single most dangerous thing this code can get wrong is not the reversal
 * logic — it is which failures are acknowledged. A provider emits many topics
 * on one endpoint, so refusing an unrecognised one makes it retry forever. But
 * acknowledging a MALFORMED body of a topic we do handle tells the provider a
 * real payment was received and stops the retry, which is the only thing
 * standing between a customer and losing their money.
 *
 * Those two outcomes are opposite, so they are carried by different types, and
 * these tests pin that apart.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  parseBillingWebhook,
  parseReversalWebhook,
  UnhandledWebhookTopicError,
} from '../supabase/functions/_shared/account_api.ts'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const webhook = readFileSync(
  path.join(projectRoot, 'supabase/functions/easyfield-billing-webhook/index.ts'),
  'utf8',
)

const DELIVERY = 'delivery-1'

function reversalBody(overrides = {}) {
  return {
    type: 'payment.reversed',
    reversalReference: 'rv_1',
    reversedPaymentReference: 'pay_1',
    reversalType: 'chargeback',
    amount: { currency: 'USD', minorUnits: 99900, exponent: 2 },
    reason: 'Cardholder disputed the charge',
    ...overrides,
  }
}

test('a well-formed reversal normalises to the shape the RPC expects', () => {
  const parsed = parseReversalWebhook(reversalBody(), DELIVERY)
  assert.equal(parsed.reversalReference, 'rv_1')
  assert.equal(parsed.reversedPaymentReference, 'pay_1')
  assert.equal(parsed.reversalType, 'chargeback')
  assert.deepEqual(parsed.reversalPayload, {
    type: 'payment/reversed',
    id: 'rv_1',
    reversedPaymentReference: 'pay_1',
    reversalType: 'chargeback',
    reason: 'Cardholder disputed the charge',
    total: { currency: 'USD', minorUnits: 99900, exponent: 2 },
  })
})

test('an unhandled topic is a distinct type, not a parse failure', () => {
  // This is the whole mechanism. If it were a plain TypeError the caller could
  // not tell "we do not care about this" from "this is broken".
  assert.throws(
    () => parseBillingWebhook({ type: 'invoice.finalized' }, DELIVERY),
    (error) => error instanceof UnhandledWebhookTopicError && error.topic === 'invoice.finalized',
  )
  assert.throws(
    () => parseBillingWebhook({ nonsense: true }, DELIVERY),
    UnhandledWebhookTopicError,
  )
  // An UnhandledWebhookTopicError must never be mistaken for a TypeError.
  const error = new UnhandledWebhookTopicError('x')
  assert.ok(!(error instanceof TypeError))
})

test('a malformed body of a handled topic is a parse failure, never ignorable', () => {
  const malformed = [
    ['unknown reversal type', reversalBody({ reversalType: 'clawback' })],
    ['missing amount', reversalBody({ amount: undefined })],
    ['wrong exponent', reversalBody({ amount: { currency: 'USD', minorUnits: 1, exponent: 3 } })],
    ['zero amount', reversalBody({ amount: { currency: 'USD', minorUnits: 0, exponent: 2 } })],
    ['bad currency', reversalBody({ amount: { currency: 'usd', minorUnits: 1, exponent: 2 } })],
    ['empty reason', reversalBody({ reason: '  ' })],
    ['self-referencing', reversalBody({ reversedPaymentReference: 'rv_1' })],
    ['extra key', { ...reversalBody(), surprise: 1 }],
  ]

  for (const [label, body] of malformed) {
    assert.throws(
      () => parseBillingWebhook(body, DELIVERY),
      (error) => {
        assert.ok(
          !(error instanceof UnhandledWebhookTopicError),
          `${label}: a malformed handled topic would be silently acknowledged`,
        )
        return error instanceof TypeError
      },
      label,
    )
  }
})

test('a payment topic still routes to the payment parser', () => {
  const parsed = parseBillingWebhook({
    type: 'payment.completed',
    paymentReference: 'pay_1',
    operationReference: '5a5b3ad5-1f37-4f4c-9c34-6a3c7d5f0a11',
    amount: { currency: 'USD', minorUnits: 2400, exponent: 2 },
    subscriptionReference: null,
    periodStart: null,
    periodEnd: null,
  }, DELIVERY)
  assert.equal(parsed.kind, 'payment')
  assert.equal(parsed.payment.paymentReference, 'pay_1')
})

test('the edge function acknowledges an unhandled topic and refuses a broken one', () => {
  // Only the topic error may produce a 200. Everything else must reach the 400.
  assert.match(
    webhook,
    /if \(error instanceof UnhandledWebhookTopicError\) \{\s*return json\(\{ accepted: true, processed: false, ignored: true \}, 200\);\s*\}\s*throw new HttpError\(400, "Webhook body is invalid"\);/,
  )
  // The catch must not swallow everything into a 200.
  assert.doesNotMatch(webhook, /catch[\s\S]{0,120}return json\(\{ accepted: true, processed: true/)
})

test('a reversal reaches its own RPC, and a payment still reaches the payment RPC', () => {
  assert.match(webhook, /parsed\.kind === "reversal"/)
  assert.match(webhook, /reconcileEvent\(\s*"easyfield_account_reconcile_payment_reversal"/)
  assert.match(webhook, /reconcileEvent\(\s*"easyfield_account_reconcile_payment_event"/)

  // The RPC path is built from a closed union, so a caller cannot reach an
  // arbitrary function through this endpoint.
  assert.match(
    webhook,
    /rpc:\s*"easyfield_account_reconcile_payment_event"\s*\|\s*"easyfield_account_reconcile_payment_reversal"/,
  )

  // Signature verification still precedes any parsing. Matched on the call
  // sites, not the import block, where the names appear in a different order.
  const verify = webhook.indexOf('await verifyWebhookHmac(')
  const parse = webhook.indexOf('parseBillingWebhook(decoded')
  assert.ok(verify >= 0, 'the webhook no longer verifies its signature')
  assert.ok(parse >= 0, 'the webhook no longer parses through the dispatcher')
  assert.ok(verify < parse, 'the body is parsed before it is verified')
  // An unverified body must never reach a reconciliation RPC. Matched on the
  // awaited call, not `async function reconcileEvent(`, which is declared
  // above the handler.
  assert.ok(verify < webhook.indexOf('await reconcileEvent('))
})

test('the shared module stays strippable by the Node test runner', () => {
  // A constructor parameter property needs codegen, which strip-only mode does
  // not do; using one here breaks every test that imports this module.
  const accountApi = readFileSync(
    path.join(projectRoot, 'supabase/functions/_shared/account_api.ts'),
    'utf8',
  )
  assert.doesNotMatch(accountApi, /constructor\([^)]*\b(readonly|private|public|protected)\s/)
})

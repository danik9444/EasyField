import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  MethodNotAllowed,
  parseBearerToken,
  parseListQuery,
  parseRoleChangeInput,
  redactSavedPaymentMethod,
  resolveAdminRoute,
  RouteNotFound,
  safeMicros,
} from "./admin_api.ts";

declare const Deno: {
  test(name: string, fn: () => void | Promise<void>): void;
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown, message?: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(message ?? `Expected ${b}, received ${a}`);
}

function assertThrows(fn: () => unknown, message: string): void {
  try {
    fn();
  } catch {
    return;
  }
  throw new Error(message);
}

const TARGET = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const REQUEST = "a1b2c3d4-1111-4222-8333-444455556666";

Deno.test("a role change requires a UUID target, a known role and a bounded reason", () => {
  const parsed = parseRoleChangeInput({
    requestId: REQUEST,
    targetUserId: TARGET,
    newRole: "support",
    reason: "  Promoting for the billing rota  ",
  });
  assertEquals(parsed.targetUserId, TARGET);
  assertEquals(parsed.newRole, "support");
  assertEquals(parsed.reason, "Promoting for the billing rota", "reason must be trimmed");

  assertThrows(
    () => parseRoleChangeInput({ requestId: REQUEST, targetUserId: "nope", newRole: "admin", reason: "valid reason" }),
    "a non-UUID target must be rejected",
  );
  assertThrows(
    () => parseRoleChangeInput({ requestId: REQUEST, targetUserId: TARGET, newRole: "root", reason: "valid reason" }),
    "an unknown role must be rejected",
  );
});

Deno.test("the reason bounds mirror the database constraint on both edges", () => {
  // billing_private.set_platform_role rejects anything outside 3..500 after
  // btrim. Whitespace must not be able to buy length past either edge.
  assertThrows(
    () => parseRoleChangeInput({ requestId: REQUEST, targetUserId: TARGET, newRole: "admin", reason: "  a  " }),
    "a two-character reason must be rejected after trimming",
  );
  assertThrows(
    () =>
      parseRoleChangeInput({
        requestId: REQUEST,
        targetUserId: TARGET,
        newRole: "admin",
        reason: "x".repeat(501),
      }),
    "a 501-character reason must be rejected",
  );

  const atLowerBound = parseRoleChangeInput({
    requestId: REQUEST,
    targetUserId: TARGET,
    newRole: "admin",
    reason: "abc",
  });
  assertEquals(atLowerBound.reason.length, 3);

  const atUpperBound = parseRoleChangeInput({
    requestId: REQUEST,
    targetUserId: TARGET,
    newRole: "admin",
    reason: "y".repeat(500),
  });
  assertEquals(atUpperBound.reason.length, 500);
});

Deno.test("a role change rejects unknown fields instead of ignoring them", () => {
  // Silently dropping an unrecognised field is how a later version starts
  // honouring something the caller never had permission to set.
  assertThrows(
    () =>
      parseRoleChangeInput({
        requestId: REQUEST,
        targetUserId: TARGET,
        newRole: "admin",
        reason: "valid reason",
        actorUserId: TARGET,
      }),
    "an actor supplied by the client must be rejected outright",
  );
});

Deno.test("list queries bound the page size and reject malformed parameters", () => {
  const empty = parseListQuery(new URLSearchParams());
  assertEquals(empty.limit, DEFAULT_PAGE_SIZE);
  assertEquals(empty.cursor, null);
  assertEquals(empty.search, null);
  assertEquals(empty.role, null);

  assertEquals(parseListQuery(new URLSearchParams("limit=100")).limit, MAX_PAGE_SIZE);
  assertThrows(() => parseListQuery(new URLSearchParams("limit=101")), "limit above the cap must be rejected");
  assertThrows(() => parseListQuery(new URLSearchParams("limit=0")), "a zero limit must be rejected");
  assertThrows(() => parseListQuery(new URLSearchParams("limit=-1")), "a negative limit must be rejected");
  assertThrows(() => parseListQuery(new URLSearchParams("limit=abc")), "a non-numeric limit must be rejected");
  assertThrows(() => parseListQuery(new URLSearchParams("role=root")), "an unknown role filter must be rejected");
  assertThrows(() => parseListQuery(new URLSearchParams("sort=email")), "an unknown parameter must be rejected");
});

Deno.test("a blank search collapses to null rather than matching everything", () => {
  assertEquals(parseListQuery(new URLSearchParams("search=%20%20")).search, null);
  assertEquals(parseListQuery(new URLSearchParams("search=%20dan%20")).search, "dan");
  assertThrows(
    () => parseListQuery(new URLSearchParams(`search=${"x".repeat(201)}`)),
    "an overlong search must be rejected",
  );
});

Deno.test("routes are an allowlist: unknown paths 404 and wrong verbs 405", () => {
  assertEquals(resolveAdminRoute("GET", "/overview").name, "overview");
  assertEquals(resolveAdminRoute("GET", "/easyfield-admin/overview").name, "overview");
  assertEquals(resolveAdminRoute("GET", "/users").name, "users");
  assertEquals(resolveAdminRoute("POST", "/roles").name, "set-role");
  assertEquals(resolveAdminRoute("GET", "/audit").name, "audit");
  assertEquals(resolveAdminRoute("GET", "/incidents").name, "incidents");

  const detail = resolveAdminRoute("GET", `/users/${TARGET}`);
  assertEquals(detail.name, "user-detail");
  assertEquals(detail.userId, TARGET);

  const credits = resolveAdminRoute("GET", `/users/${TARGET}/credits`);
  assertEquals(credits.name, "credits");
  assertEquals(credits.userId, TARGET);

  let notFound = false;
  try {
    resolveAdminRoute("GET", "/sql");
  } catch (error) {
    notFound = error instanceof RouteNotFound;
  }
  assert(notFound, "an unknown route must raise RouteNotFound");

  let notAllowed = false;
  try {
    resolveAdminRoute("DELETE", "/users");
  } catch (error) {
    notAllowed = error instanceof MethodNotAllowed;
  }
  assert(notAllowed, "a known route with the wrong verb must raise MethodNotAllowed");

  // A mutation must never be reachable by a method that caches or prefetches.
  let roleGetRejected = false;
  try {
    resolveAdminRoute("GET", "/roles");
  } catch (error) {
    roleGetRejected = error instanceof MethodNotAllowed;
  }
  assert(roleGetRejected, "the role mutation must not be reachable over GET");
});

Deno.test("a non-UUID user segment cannot reach a handler", () => {
  assertThrows(() => resolveAdminRoute("GET", "/users/../../etc/passwd"), "path traversal must not resolve");
  assertThrows(() => resolveAdminRoute("GET", "/users/1"), "a non-UUID id must be rejected");
});

Deno.test("saved payment methods expose display fields only", () => {
  const redacted = redactSavedPaymentMethod({
    id: "pm-1",
    brand: "visa",
    last4: "4242",
    exp_month: 12,
    exp_year: 2030,
    status: "active",
    created_at: "2026-07-29T00:00:00Z",
    provider_payment_method_id: "pm_live_secret_reference",
    provider_customer_id: "cus_live_secret",
    raw_payload: { pan: "4242424242424242" },
  });

  assertEquals(redacted.last4, "4242");
  assertEquals(redacted.brand, "visa");
  assert(!("provider_payment_method_id" in redacted), "provider reference must not survive redaction");
  assert(!("provider_customer_id" in redacted), "provider customer id must not survive redaction");
  assert(!("raw_payload" in redacted), "raw provider payload must not survive redaction");
  assertEquals(Object.keys(redacted).length, 7, "redaction must be an allowlist, not a delete list");
});

Deno.test("micro-units survive only as safe integers", () => {
  assertEquals(safeMicros(240_000_000), 240_000_000);
  assertEquals(safeMicros("240000000"), 240_000_000);
  assertEquals(safeMicros(-1_000), -1_000);
  assertEquals(safeMicros(1.5), null, "a fractional micro amount is a bug, not a value");
  assertEquals(safeMicros(Number.MAX_SAFE_INTEGER + 2), null);
  assertEquals(safeMicros("12.5"), null);
  assertEquals(safeMicros(null), null);
  assertEquals(safeMicros("nope"), null);
});

Deno.test("bearer tokens are parsed strictly", () => {
  assertEquals(parseBearerToken("Bearer abc.def-ghi~jkl_mno"), "abc.def-ghi~jkl_mno");
  assertThrows(() => parseBearerToken(null), "a missing header must be rejected");
  assertThrows(() => parseBearerToken("bearer abc"), "a lowercase scheme must be rejected");
  assertThrows(() => parseBearerToken("Bearer "), "an empty token must be rejected");
  assertThrows(() => parseBearerToken("Bearer abc def"), "a token with a space must be rejected");
  assertThrows(() => parseBearerToken(`Bearer ${"a".repeat(16_385)}`), "an oversized token must be rejected");
});

/**
 * Pure validation and shaping helpers for the EasyField admin edge function.
 *
 * Like account_api.ts this module intentionally carries no Deno runtime,
 * credential, or provider dependency, so the whole request contract can be
 * tested with plain `node --test`.
 *
 * The schema states the rule this module exists to serve
 * (202607140001_subscription_billing.sql, line 3584): a platform_role never
 * bypasses RLS from the client, and support/admin tooling must authenticate to
 * a trusted server using service_role. So an admin is not a privileged database
 * client — they are an ordinary authenticated user that a trusted server
 * recognises. Everything here runs on that server, never in a browser.
 */

export const MAX_ADMIN_REQUEST_BYTES = 16 * 1024;

/** Bounds every list response so one request can never stream the whole table. */
export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 25;

/** Mirrors the profiles.platform_role check constraint. */
export const PLATFORM_ROLES = ["customer", "support", "admin"] as const;
export type PlatformRole = (typeof PLATFORM_ROLES)[number];

/**
 * billing_private.set_platform_role rejects a reason outside 3..500 characters
 * after btrim. Mirrored here so the operator gets a useful message before the
 * round trip; the database remains the authority if the two ever diverge.
 */
export const MIN_ROLE_REASON_LENGTH = 3;
export const MAX_ROLE_REASON_LENGTH = 500;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CURSOR_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,299}$/;
const ROLE_SET: ReadonlySet<string> = new Set(PLATFORM_ROLES);

export interface RoleChangeInput {
  readonly requestId: string;
  readonly targetUserId: string;
  readonly newRole: PlatformRole;
  readonly reason: string;
}

export interface ListQuery {
  readonly limit: number;
  readonly cursor: string | null;
  readonly search: string | null;
  readonly role: PlatformRole | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const expected = new Set(allowed);
  return Object.keys(value).every((key) => expected.has(key));
}

function requireUuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a UUID`);
  }
  return value.toLowerCase();
}

export function parseBearerToken(header: string | null): string {
  const match = /^Bearer ([A-Za-z0-9._~-]+)$/.exec(header ?? "");
  if (!match || match[1].length > 16_384) throw new TypeError("Missing or invalid bearer token");
  return match[1];
}

/**
 * Rejects unknown fields rather than ignoring them. A request that carries a
 * field this version does not understand is a request written against a
 * different contract, and silently dropping it is how a later version starts
 * honouring something the caller never had permission to set.
 */
export function parseRoleChangeInput(value: unknown): RoleChangeInput {
  if (!isRecord(value)) throw new TypeError("Role change request must be an object");
  if (!exactKeys(value, ["requestId", "targetUserId", "newRole", "reason"])) {
    throw new TypeError("Role change request contains unknown fields");
  }

  const requestId = requireUuid(value.requestId, "requestId");
  const targetUserId = requireUuid(value.targetUserId, "targetUserId");

  if (typeof value.newRole !== "string" || !ROLE_SET.has(value.newRole)) {
    throw new TypeError("newRole must be one of customer, support, admin");
  }

  if (typeof value.reason !== "string") throw new TypeError("reason must be a string");
  const reason = value.reason.trim();
  if (reason.length < MIN_ROLE_REASON_LENGTH || reason.length > MAX_ROLE_REASON_LENGTH) {
    throw new TypeError(
      `reason must be between ${MIN_ROLE_REASON_LENGTH} and ${MAX_ROLE_REASON_LENGTH} characters`,
    );
  }

  return { requestId, targetUserId, newRole: value.newRole as PlatformRole, reason };
}

/**
 * List parameters come from a URL, where every value is a string and every
 * value is attacker-controlled. An absent parameter is a default; a present but
 * malformed one is an error, because silently substituting a default there
 * hides a broken caller.
 */
export function parseListQuery(params: URLSearchParams): ListQuery {
  const allowed = new Set(["limit", "cursor", "search", "role"]);
  for (const key of params.keys()) {
    if (!allowed.has(key)) throw new TypeError(`Unknown query parameter: ${key}`);
  }

  let limit = DEFAULT_PAGE_SIZE;
  const rawLimit = params.get("limit");
  if (rawLimit !== null) {
    if (!/^[0-9]{1,3}$/.test(rawLimit)) throw new TypeError("limit must be a positive integer");
    limit = Number(rawLimit);
    if (limit < 1 || limit > MAX_PAGE_SIZE) {
      throw new TypeError(`limit must be between 1 and ${MAX_PAGE_SIZE}`);
    }
  }

  const rawCursor = params.get("cursor");
  if (rawCursor !== null && !CURSOR_PATTERN.test(rawCursor)) {
    throw new TypeError("cursor is invalid");
  }

  const rawSearch = params.get("search");
  let search: string | null = null;
  if (rawSearch !== null) {
    search = rawSearch.trim();
    if (search.length === 0) search = null;
    else if (search.length > 200) throw new TypeError("search is too long");
  }

  const rawRole = params.get("role");
  if (rawRole !== null && !ROLE_SET.has(rawRole)) {
    throw new TypeError("role must be one of customer, support, admin");
  }

  return { limit, cursor: rawCursor, search, role: (rawRole as PlatformRole | null) ?? null };
}

/**
 * Saved payment methods carry provider references that identify a real payment
 * instrument. An operator needs to recognise a card, not to be handed something
 * that could be replayed, so only display fields survive into a response.
 */
export function redactSavedPaymentMethod(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id ?? null,
    brand: row.brand ?? null,
    last4: row.last4 ?? null,
    expMonth: row.exp_month ?? null,
    expYear: row.exp_year ?? null,
    status: row.status ?? null,
    createdAt: row.created_at ?? null,
  };
}

/**
 * Money and credits are integer micro-units end to end. Anything that is not a
 * safe integer is a bug somewhere upstream, and rendering it as a number would
 * launder that bug into the UI, so it surfaces as null instead.
 */
export function safeMicros(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && /^-?[0-9]{1,15}$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

export interface AdminRoute {
  readonly name:
    | "overview"
    | "users"
    | "user-detail"
    | "credits"
    | "incidents"
    | "audit"
    | "set-role";
  readonly method: "GET" | "POST";
  readonly userId?: string;
}

/**
 * An explicit allowlist. Anything unmatched is a 404 rather than an attempt to
 * be helpful, and a known path reached with the wrong verb is a 405, so a
 * mistyped client never falls through to a handler that happens to accept it.
 */
export function resolveAdminRoute(method: string, pathname: string): AdminRoute {
  const segments = pathname.replace(/^\/+|\/+$/g, "").split("/");
  const base = segments[0] === "easyfield-admin" ? segments.slice(1) : segments;

  const get = method === "GET";
  const post = method === "POST";

  if (base.length === 1) {
    switch (base[0]) {
      case "overview":
        if (!get) throw new MethodNotAllowed();
        return { name: "overview", method: "GET" };
      case "users":
        if (!get) throw new MethodNotAllowed();
        return { name: "users", method: "GET" };
      case "incidents":
        if (!get) throw new MethodNotAllowed();
        return { name: "incidents", method: "GET" };
      case "audit":
        if (!get) throw new MethodNotAllowed();
        return { name: "audit", method: "GET" };
      case "roles":
        if (!post) throw new MethodNotAllowed();
        return { name: "set-role", method: "POST" };
      default:
        throw new RouteNotFound();
    }
  }

  if (base.length === 2 && base[0] === "users") {
    if (!get) throw new MethodNotAllowed();
    return { name: "user-detail", method: "GET", userId: requireUuid(base[1], "userId") };
  }

  if (base.length === 3 && base[0] === "users" && base[2] === "credits") {
    if (!get) throw new MethodNotAllowed();
    return { name: "credits", method: "GET", userId: requireUuid(base[1], "userId") };
  }

  throw new RouteNotFound();
}

export class RouteNotFound extends Error {
  constructor() {
    super("Not found");
    this.name = "RouteNotFound";
  }
}

export class MethodNotAllowed extends Error {
  constructor() {
    super("Method not allowed");
    this.name = "MethodNotAllowed";
  }
}

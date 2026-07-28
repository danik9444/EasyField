/**
 * EasyField admin console API.
 *
 * This is the "trusted server" the schema's row-level security section requires
 * (202607140001_subscription_billing.sql, line 3584). It is the only place a
 * platform admin's intent is turned into privileged database access, and the
 * only place the service-role key is ever held.
 *
 * Two independent facts are established on every single request:
 *   1. the caller holds a valid, verified Supabase Auth session, and
 *   2. that same user still satisfies billing_private.is_active_admin.
 *
 * The second check is performed inside each SQL wrapper rather than cached here,
 * so an admin who is demoted, banned or deleted loses access on their next call
 * instead of at the end of some session window.
 */

import {
  MAX_ADMIN_REQUEST_BYTES,
  MethodNotAllowed,
  parseBearerToken,
  parseListQuery,
  parseRoleChangeInput,
  resolveAdminRoute,
  RouteNotFound,
} from "../_shared/admin_api.ts";

declare const Deno: {
  env: { get(name: string): string | undefined };
  serve(handler: (request: Request) => Response | Promise<Response>): void;
};

type JsonRecord = Record<string, unknown>;

interface AuthUser {
  readonly id: string;
  readonly email: string;
  readonly email_confirmed_at?: string | null;
  readonly confirmed_at?: string | null;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "HttpError";
  }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      // An admin response is never cacheable: it is per-operator, privileged,
      // and stale data on this screen is worse than no data.
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredEnv(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new HttpError(503, "Admin service is not configured");
  return value;
}

function supabaseBaseUrl(): string {
  const value = requiredEnv("SUPABASE_URL");
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:"
      && parsed.hostname !== "127.0.0.1"
      && parsed.hostname !== "localhost"
    ) throw new Error();
    return parsed.toString().replace(/\/$/, "");
  } catch {
    throw new HttpError(503, "Admin service is not configured");
  }
}

async function limitedJson(response: Response, limit = 2 * 1024 * 1024): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) throw new Error("response-too-large");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > limit) throw new Error("response-too-large");
  if (bytes.byteLength === 0) return null;
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
}

async function readJson(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_ADMIN_REQUEST_BYTES) {
    throw new HttpError(413, "Request is too large");
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > MAX_ADMIN_REQUEST_BYTES) throw new HttpError(413, "Request is too large");
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new HttpError(400, "Request body must be valid JSON");
  }
}

async function authenticate(request: Request): Promise<AuthUser> {
  let token: string;
  try {
    token = parseBearerToken(request.headers.get("authorization"));
  } catch {
    throw new HttpError(401, "Authentication required");
  }
  const anonKey = requiredEnv("SUPABASE_ANON_KEY");
  let response: Response;
  try {
    response = await fetch(`${supabaseBaseUrl()}/auth/v1/user`, {
      headers: { authorization: `Bearer ${token}`, apikey: anonKey, accept: "application/json" },
      redirect: "error",
    });
  } catch {
    throw new HttpError(503, "Admin service is unavailable");
  }
  if (!response.ok) throw new HttpError(401, "Authentication required");
  const payload = await limitedJson(response);
  if (
    !isRecord(payload)
    || typeof payload.id !== "string"
    || typeof payload.email !== "string"
    || !(payload.email_confirmed_at || payload.confirmed_at)
  ) throw new HttpError(403, "A verified account is required");
  return payload as unknown as AuthUser;
}

/**
 * Calls an admin SQL wrapper with the service-role key. The actor id is taken
 * from the verified session, never from the request body, so a caller cannot
 * nominate whose authority the query runs under.
 */
async function adminRpc<T>(name: string, body: JsonRecord): Promise<T> {
  const serviceKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
  let response: Response;
  try {
    response = await fetch(`${supabaseBaseUrl()}/rest/v1/rpc/${name}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${serviceKey}`,
        apikey: serviceKey,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(body),
      redirect: "error",
    });
  } catch {
    throw new HttpError(503, "Admin service is unavailable");
  }

  const payload = await limitedJson(response);
  if (!response.ok) {
    // Database detail is never reflected to the client. The one distinction
    // worth keeping is authorization, because the console must be able to tell
    // "you are not an admin" apart from "that request was malformed".
    const code = isRecord(payload) && typeof payload.code === "string" ? payload.code : "";
    if (response.status === 403 || code === "42501") {
      throw new HttpError(403, "Platform admin access is required");
    }
    if (response.status === 404 || code === "23503") throw new HttpError(404, "Not found");
    if (response.status === 400 || response.status === 409 || code === "22023") {
      throw new HttpError(400, "The admin request is not valid");
    }
    throw new HttpError(502, "Admin service is unavailable");
  }
  return payload as T;
}

async function handle(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const route = resolveAdminRoute(request.method, url.pathname);

  // Authentication happens after routing so an unknown path cannot be used to
  // probe token validity, but before any handler touches the database.
  const user = await authenticate(request);

  switch (route.name) {
    case "overview":
      return json(await adminRpc("easyfield_admin_overview", { p_actor_user_id: user.id }));

    case "users": {
      const query = parseListQuery(url.searchParams);
      return json(await adminRpc("easyfield_admin_users", {
        p_actor_user_id: user.id,
        p_search: query.search,
        p_role: query.role,
        p_limit: query.limit,
        p_cursor_created_at: null,
        p_cursor_user_id: null,
      }));
    }

    case "user-detail":
      return json(await adminRpc("easyfield_admin_user_detail", {
        p_actor_user_id: user.id,
        p_user_id: route.userId,
      }));

    case "credits": {
      const query = parseListQuery(url.searchParams);
      return json(await adminRpc("easyfield_admin_credits", {
        p_actor_user_id: user.id,
        p_user_id: route.userId,
        p_limit: query.limit,
        p_cursor_id: null,
      }));
    }

    case "incidents": {
      const query = parseListQuery(url.searchParams);
      return json(await adminRpc("easyfield_admin_incidents", {
        p_actor_user_id: user.id,
        p_limit: query.limit,
      }));
    }

    case "audit": {
      const query = parseListQuery(url.searchParams);
      return json(await adminRpc("easyfield_admin_audit", {
        p_actor_user_id: user.id,
        p_limit: query.limit,
        p_cursor_id: null,
      }));
    }

    case "set-role": {
      const input = parseRoleChangeInput(await readJson(request));
      // A self-demotion is refused here as well as by the last-admin guard in
      // set_platform_role, because losing your own access by accident is a
      // different mistake from removing the final admin.
      if (input.targetUserId === user.id.toLowerCase() && input.newRole !== "admin") {
        throw new HttpError(400, "An admin cannot remove their own admin access");
      }
      return json(await adminRpc("easyfield_admin_set_role", {
        p_actor_user_id: user.id,
        p_target_user_id: input.targetUserId,
        p_new_role: input.newRole,
        p_reason: input.reason,
      }));
    }
  }
}

Deno.serve(async (request: Request): Promise<Response> => {
  try {
    return await handle(request);
  } catch (error) {
    if (error instanceof HttpError) return json({ error: error.message }, error.status);
    if (error instanceof RouteNotFound) return json({ error: "Not found" }, 404);
    if (error instanceof MethodNotAllowed) return json({ error: "Method not allowed" }, 405);
    if (error instanceof TypeError) return json({ error: error.message }, 400);
    // Anything unclassified is reported without detail. An admin console is a
    // high-value target and stack shapes are a useful oracle.
    return json({ error: "Unexpected admin service error" }, 500);
  }
});

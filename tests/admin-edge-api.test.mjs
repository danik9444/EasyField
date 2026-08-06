import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const denoTests = [];
globalThis.Deno = {
  test(name, fn) {
    denoTests.push({ name, fn });
  },
};

await import("../supabase/functions/_shared/admin_api_test.ts");
for (const item of denoTests) test(item.name, item.fn);

const migrationUrl = new URL(
  "../supabase/migrations/202607290003_admin_console_api.sql",
  import.meta.url,
);
const functionUrl = new URL("../supabase/functions/easyfield-admin/index.ts", import.meta.url);

function withoutComments(value) {
  return value.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\r\n]*/g, " ");
}

test("every admin SQL entry point re-checks the actor inside the database", async () => {
  // The edge function also checks, but a bug there must not be sufficient on its
  // own. Enumerating the functions rather than spot-checking means a new admin
  // endpoint added without the guard fails here instead of shipping open.
  const sql = withoutComments(await readFile(migrationUrl, "utf8"));
  const bodies = [
    ...sql.matchAll(
      /create or replace function (public\.easyfield_admin_[a-z_]+)\([\s\S]*?\n\$\$;/g,
    ),
  ];
  assert.ok(bodies.length >= 7, `expected the admin API surface, found ${bodies.length}`);

  for (const [body, name] of bodies) {
    assert.match(
      body,
      /perform billing_private\.require_active_admin\(p_actor_user_id\);/,
      `${name} must re-check the actor before touching data`,
    );
  }
});

test("the actor guard treats every rejection reason identically", async () => {
  const sql = withoutComments(await readFile(migrationUrl, "utf8"));
  const guard = /create or replace function billing_private\.require_active_admin[\s\S]*?\n\$\$;/
    .exec(sql);
  assert.ok(guard, "the shared guard must exist");
  // Distinguishing "not an admin" from "banned" would let a caller probe the
  // state of accounts they have no access to.
  const raises = [...guard[0].matchAll(/raise exception '([^']+)'/g)].map((match) => match[1]);
  assert.deepEqual(raises, ["Actor is not a platform admin"]);
  assert.match(guard[0], /errcode = '42501'/);
});

test("admin SQL functions are unreachable by an ordinary authenticated session", async () => {
  const sql = withoutComments(await readFile(migrationUrl, "utf8"));
  const declared = [
    ...sql.matchAll(/create or replace function (public\.easyfield_admin_[a-z_]+)\(/g),
  ].map((match) => match[1]);
  assert.ok(declared.length >= 7);

  for (const name of new Set(declared)) {
    const escaped = name.replace(".", "\\.");
    assert.match(
      sql,
      new RegExp(`revoke all on function ${escaped}\\([^)]*\\) from public, anon, authenticated;`),
      `${name} must be revoked from anon and authenticated`,
    );
    assert.match(
      sql,
      new RegExp(`grant execute on function ${escaped}\\([^)]*\\) to service_role;`),
      `${name} must be executable only by service_role`,
    );
  }

  // A browser holding an operator's own JWT reaches PostgREST as `authenticated`.
  // Granting these to that role would make the whole trusted-server design moot.
  assert.doesNotMatch(sql, /grant execute on function public\.easyfield_admin_[a-z_]+\([^)]*\) to (anon|authenticated)/);
});

test("the admin API exposes exactly one write, and delegates it", async () => {
  const sql = withoutComments(await readFile(migrationUrl, "utf8"));

  // Reimplementing the role rules here would create a second copy that can
  // drift from billing_private.set_platform_role.
  assert.match(sql, /v_profile := billing_private\.set_platform_role\(/);

  // No admin function may write to a table directly.
  const writes = [...sql.matchAll(/\b(insert into|update|delete from)\s+((?:public|billing_private)\.[a-z_]+)/g)]
    .map((match) => match[2]);
  assert.deepEqual(writes, [], `admin SQL must not write tables directly, found: ${writes.join(", ")}`);

  // The ledger and the role audit are append-only and protected by triggers.
  // The console reads them as evidence and must never attempt to change them.
  assert.doesNotMatch(sql, /update\s+public\.credit_ledger/);
  assert.doesNotMatch(sql, /update\s+public\.platform_role_audit/);
});

test("read-only admin functions are declared stable, and the mutation is not", async () => {
  const sql = withoutComments(await readFile(migrationUrl, "utf8"));
  const readOnly = ["overview", "users", "user_detail", "credits", "incidents", "audit"];
  for (const name of readOnly) {
    const body = new RegExp(
      `create or replace function public\\.easyfield_admin_${name}\\([\\s\\S]*?as \\$\\$`,
    ).exec(sql);
    assert.ok(body, `easyfield_admin_${name} must exist`);
    assert.match(body[0], /\bstable\b/, `easyfield_admin_${name} must be declared stable`);
  }
  const mutation = /create or replace function public\.easyfield_admin_set_role\([\s\S]*?as \$\$/
    .exec(sql);
  assert.ok(mutation);
  assert.doesNotMatch(mutation[0], /\bstable\b/, "a write must not claim to be stable");
});

test("every admin function pins an empty search_path under security definer", async () => {
  const sql = withoutComments(await readFile(migrationUrl, "utf8"));
  const bodies = [
    ...sql.matchAll(
      /create or replace function ((?:public|billing_private)\.[a-z_]+)\([\s\S]*?as \$\$/g,
    ),
  ];
  for (const [body, name] of bodies) {
    if (name === "billing_private.clamp_admin_limit") continue; // pure arithmetic, no lookups
    assert.match(body, /security definer/, `${name} must be security definer`);
    assert.match(body, /set search_path = ''/, `${name} must pin an empty search_path`);
  }
});

test("the edge function authenticates before any database access", async () => {
  const source = await readFile(functionUrl, "utf8");
  const handle = /async function handle\(request: Request\)[\s\S]*?\n}/.exec(source);
  assert.ok(handle, "the request handler must exist");

  const authIndex = handle[0].indexOf("await authenticate(request)");
  const rpcIndex = handle[0].indexOf("adminRpc(");
  assert.ok(authIndex > 0, "the handler must authenticate");
  assert.ok(rpcIndex > authIndex, "no database call may precede authentication");
});

test("the actor is taken from the verified session, never from the request", async () => {
  const source = await readFile(functionUrl, "utf8");
  // Every RPC call must pass the authenticated user's id as the actor.
  // Anchored to an identifier so a trailing brace on a single-line call cannot
  // be swept into the capture.
  const actors = [...source.matchAll(/p_actor_user_id:\s*([A-Za-z_$][\w$.]*)/g)]
    .map((match) => match[1]);
  assert.ok(actors.length >= 7, `expected an actor on every call, found ${actors.length}`);
  for (const actor of actors) {
    assert.equal(actor, "user.id", "the actor must come from the verified session");
  }
  // A client-supplied actor field is rejected by the parser, not ignored.
  const contract = await readFile(
    new URL("../supabase/functions/_shared/admin_api.ts", import.meta.url),
    "utf8",
  );
  assert.match(contract, /exactKeys\(value, \["requestId", "targetUserId", "newRole", "reason"\]\)/);
});

test("the edge function never embeds a credential and never reflects database detail", async () => {
  const source = await readFile(functionUrl, "utf8");
  assert.match(source, /Deno\.env\.get\("SUPABASE_SERVICE_ROLE_KEY"\)|requiredEnv\("SUPABASE_SERVICE_ROLE_KEY"\)/);

  // A service-role key is a JWT; any literal one in source would be a leak.
  assert.doesNotMatch(source, /eyJ[A-Za-z0-9_-]{20,}/, "no JWT literal may appear in source");

  // Error paths must not pass a database payload back to the caller.
  assert.doesNotMatch(source, /JSON\.stringify\(payload\)/);
  assert.match(source, /"Admin service is unavailable"/);
  assert.match(source, /"Unexpected admin service error"/);
});

test("admin responses are never cacheable", async () => {
  const source = await readFile(functionUrl, "utf8");
  assert.match(source, /"cache-control": "no-store"/);
  assert.match(source, /"x-content-type-options": "nosniff"/);
  assert.match(source, /"referrer-policy": "no-referrer"/);
});

test("an admin cannot remove their own access by accident", async () => {
  const source = await readFile(functionUrl, "utf8");
  assert.match(
    source,
    /input\.targetUserId === user\.id\.toLowerCase\(\) && input\.newRole !== "admin"/,
    "self-demotion must be refused before reaching the database",
  );
});

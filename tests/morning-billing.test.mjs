import { test } from "node:test";

const previousDeno = globalThis.Deno;

globalThis.Deno = { test };

try {
  await import("../supabase/functions/_shared/morning_test.ts");
} finally {
  if (previousDeno === undefined) {
    delete globalThis.Deno;
  } else {
    globalThis.Deno = previousDeno;
  }
}

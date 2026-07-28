import {
  classifyGenerationGatewayRequest,
  requireGenerationOperationId,
} from "./generation_gateway.ts";

declare const Deno: { test(name: string, fn: () => void | Promise<void>): void };

function equal(actual: unknown, expected: unknown): void {
  if (actual !== expected) throw new Error(`Expected ${String(expected)}, received ${String(actual)}`);
}

function throws(fn: () => unknown): void {
  let didThrow = false;
  try { fn(); } catch { didThrow = true; }
  if (!didThrow) throw new Error("Expected function to throw");
}

Deno.test("generation operation identities are bounded opaque values", () => {
  equal(requireGenerationOperationId("job-123456:child:1"), "job-123456:child:1");
  throws(() => requireGenerationOperationId("short"));
  throws(() => requireGenerationOperationId(" job-123456"));
  throws(() => requireGenerationOperationId(`job-${"x".repeat(200)}`));
});

Deno.test("generation creates accept only allowlisted routes with a durable identity", () => {
  const route = classifyGenerationGatewayRequest(new Request(
    "https://account.example/gateway/provider/api/v1/jobs/createTask",
    { method: "POST", headers: { "x-easyfield-operation-id": "job-123456:child:1" } },
  ), "/gateway/provider/api/v1/jobs/createTask");
  equal(route.kind, "create");
  if (route.kind === "create") {
    equal(route.family, "jobs");
    equal(route.pollPath, "/api/v1/jobs/recordInfo");
  }

  throws(() => classifyGenerationGatewayRequest(new Request(
    "https://account.example/gateway/provider/api/v1/jobs/createTask",
    { method: "POST" },
  ), "/gateway/provider/api/v1/jobs/createTask"));
  throws(() => classifyGenerationGatewayRequest(new Request(
    "https://account.example/gateway/provider/internal/admin",
    { method: "POST", headers: { "x-easyfield-operation-id": "job-123456" } },
  ), "/gateway/provider/internal/admin"));
});

Deno.test("polling accepts one bounded task id and rejects query smuggling", () => {
  const route = classifyGenerationGatewayRequest(new Request(
    "https://account.example/gateway/provider/api/v1/jobs/recordInfo?taskId=task-123",
  ), "/gateway/provider/api/v1/jobs/recordInfo");
  equal(route.kind, "poll");
  if (route.kind === "poll") equal(route.taskId, "task-123");

  throws(() => classifyGenerationGatewayRequest(new Request(
    "https://account.example/gateway/provider/api/v1/jobs/recordInfo?taskId=task-123&taskId=foreign",
  ), "/gateway/provider/api/v1/jobs/recordInfo"));
  throws(() => classifyGenerationGatewayRequest(new Request(
    "https://account.example/gateway/provider/api/v1/jobs/recordInfo?taskId=task-123&next=https://evil.example",
  ), "/gateway/provider/api/v1/jobs/recordInfo"));
});

Deno.test("upload route is exact and cannot carry a target URL", () => {
  equal(classifyGenerationGatewayRequest(new Request(
    "https://account.example/gateway/provider-upload/api/file-base64-upload",
    { method: "POST" },
  ), "/gateway/provider-upload/api/file-base64-upload").kind, "upload");
  throws(() => classifyGenerationGatewayRequest(new Request(
    "https://account.example/gateway/provider-upload/api/file-base64-upload?target=https://evil.example",
    { method: "POST" },
  ), "/gateway/provider-upload/api/file-base64-upload"));
});

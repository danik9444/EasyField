/** Pure route and identity validation for the metered generation boundary. */

const OPERATION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/;
const TASK_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,499}$/;

export type GenerationFamily = "jobs" | "veo" | "runway" | "aleph" | "suno" | "sounds";

export type GenerationGatewayRoute =
  | {
      readonly kind: "create";
      readonly family: GenerationFamily;
      readonly createPath: string;
      readonly pollPath: string;
      readonly operationId: string;
    }
  | {
      readonly kind: "poll";
      readonly family: GenerationFamily;
      readonly pollPath: string;
      readonly taskId: string;
    }
  | { readonly kind: "credits" }
  | { readonly kind: "upload" };

const CREATE_ROUTES = Object.freeze(new Map<string, {
  readonly family: GenerationFamily;
  readonly pollPath: string;
}>([
  ["/api/v1/jobs/createTask", { family: "jobs", pollPath: "/api/v1/jobs/recordInfo" }],
  ["/api/v1/veo/generate", { family: "veo", pollPath: "/api/v1/veo/record-info" }],
  ["/api/v1/runway/generate", { family: "runway", pollPath: "/api/v1/runway/record-detail" }],
  ["/api/v1/aleph/generate", { family: "aleph", pollPath: "/api/v1/aleph/record-info" }],
  ["/api/v1/generate", { family: "suno", pollPath: "/api/v1/generate/record-info" }],
  ["/api/v1/generate/sounds", { family: "sounds", pollPath: "/api/v1/generate/record-info" }],
]));

const POLL_ROUTES = Object.freeze(new Map<string, GenerationFamily[]>([
  ["/api/v1/jobs/recordInfo", ["jobs"]],
  ["/api/v1/veo/record-info", ["veo"]],
  ["/api/v1/runway/record-detail", ["runway"]],
  ["/api/v1/aleph/record-info", ["aleph"]],
  ["/api/v1/generate/record-info", ["suno", "sounds"]],
]));

function method(request: Request, expected: string): void {
  if (request.method !== expected) throw new TypeError("method-not-allowed");
}

function singleTaskId(url: URL): string {
  const entries = [...url.searchParams.entries()];
  if (entries.length !== 1 || entries[0][0] !== "taskId" || !TASK_PATTERN.test(entries[0][1])) {
    throw new TypeError("invalid-task-id");
  }
  return entries[0][1];
}

export function requireGenerationOperationId(value: string | null): string {
  if (!value || value !== value.trim() || !OPERATION_PATTERN.test(value)) {
    throw new TypeError("invalid-operation-id");
  }
  return value;
}

/**
 * Accept only the endpoint/method/query combinations used by verified desktop
 * adapters. An authenticated user cannot turn the gateway into an arbitrary
 * server-side request proxy.
 */
export function classifyGenerationGatewayRequest(
  request: Request,
  gatewayPath: string,
): GenerationGatewayRoute {
  const url = new URL(request.url);
  const normalized = gatewayPath.replace(/\/+$/, "") || "/";
  const uploadPrefix = "/gateway/provider-upload";
  const providerPrefix = "/gateway/provider";

  if (normalized === `${uploadPrefix}/api/file-base64-upload`) {
    method(request, "POST");
    if (url.search) throw new TypeError("invalid-upload-query");
    return { kind: "upload" };
  }
  if (!normalized.startsWith(`${providerPrefix}/`)) throw new TypeError("route-not-found");
  const path = normalized.slice(providerPrefix.length);

  if (path === "/api/v1/chat/credit") {
    method(request, "GET");
    if (url.search) throw new TypeError("invalid-credit-query");
    return { kind: "credits" };
  }

  const create = CREATE_ROUTES.get(path);
  if (create) {
    method(request, "POST");
    if (url.search) throw new TypeError("invalid-create-query");
    return {
      kind: "create",
      family: create.family,
      createPath: path,
      pollPath: create.pollPath,
      operationId: requireGenerationOperationId(request.headers.get("x-easyfield-operation-id")),
    };
  }

  const families = POLL_ROUTES.get(path);
  if (families) {
    method(request, "GET");
    const taskId = singleTaskId(url);
    // Suno and Sounds share a polling route. The durable task binding, not a
    // client-controlled query value, resolves which family owns the task.
    return { kind: "poll", family: families[0], pollPath: path, taskId };
  }

  throw new TypeError("route-not-found");
}

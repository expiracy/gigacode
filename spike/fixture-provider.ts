/**
 * Deterministic, loopback-only provider used by the OpenCode 2 compatibility spike.
 * It exercises the host's real provider parser and tool runner without a paid model.
 * Wire format is pinned to OpenCode b44eea9e204024db2b480a136ece29d790d5f593:
 * packages/ai/src/protocols/{openai-compatible-chat,openai-chat}.ts.
 */

export type FixtureUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
};

export type FixtureToolCall = {
  id?: string;
  name: string;
  arguments: Record<string, unknown> | string;
};

export type FixtureRequest = {
  id: number;
  receivedAt: string;
  method: string;
  path: string;
  model: string;
  stream: boolean;
  /** Headers are deliberately never recorded. Known credential fields are redacted. */
  body: Record<string, unknown>;
  messages: Record<string, unknown>[];
  status: "pending" | "held" | "completed" | "aborted" | "failed";
  matchedPlan?: string;
  unexpected: boolean;
  finishedAt?: string;
};

export type FixturePlan = {
  id?: string;
  /** Exact model ID, if supplied. The first matching queued plan is consumed. */
  model?: string;
  /** Matches a substring in the complete message history, including tool results. */
  marker?: string;
  /** Additional predicate runs against the sanitized request record. */
  match?: (request: FixtureRequest) => boolean;
  text?: string;
  toolCalls?: FixtureToolCall[];
  /** Release explicitly with provider.release(key), or abort the client request. */
  hold?: string;
  /** Split streamed arguments to exercise the host's incremental JSON parser. */
  chunkSize?: number;
  usage?: FixtureUsage;
  error?: { status: number; message: string; code?: string };
};

export type FixtureProvider = {
  /** Includes /v1; OpenCode appends /chat/completions. */
  baseURL: string;
  requests: FixtureRequest[];
  enqueue(plan: FixturePlan): string;
  hold(key: string): void;
  release(key: string): void;
  stop(): Promise<void>;
};

type Gate = { released: boolean; waiters: Set<() => void> };
type QueuedPlan = FixturePlan & { id: string };

const encoder = new TextEncoder();
const defaultUsage: FixtureUsage = { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 };
const sensitiveKey = /^(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|credentials?)$/i;

function redact(value: unknown): unknown {
  if (typeof value === "string") {
    return value
      .replace(/\bBearer\s+[^\s"'<>]+/gi, "Bearer [REDACTED]")
      .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "[REDACTED]");
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, sensitiveKey.test(key) ? "[REDACTED]" : redact(nested)]),
    );
  }
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function slices(value: string, size: number): string[] {
  const result: string[] = [];
  for (let offset = 0; offset < value.length; offset += size) result.push(value.slice(offset, offset + size));
  return result;
}

function waitForGate(gate: Gate, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  if (gate.released) return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = (released: boolean) => {
      gate.waiters.delete(onRelease);
      signal.removeEventListener("abort", onAbort);
      resolve(released);
    };
    const onRelease = () => finish(true);
    const onAbort = () => finish(false);
    gate.waiters.add(onRelease);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function createFixtureProvider(options: { port?: number; fallbackText?: string } = {}): FixtureProvider {
  const requests: FixtureRequest[] = [];
  const plans: QueuedPlan[] = [];
  const gates = new Map<string, Gate>();
  const active = new Set<AbortController>();
  let planSequence = 0;
  let stopped = false;

  const getGate = (key: string): Gate => {
    let gate = gates.get(key);
    if (!gate) {
      gate = { released: false, waiters: new Set() };
      gates.set(key, gate);
    }
    return gate;
  };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port ?? 0,
    idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/health") return Response.json({ ok: true });
      if (request.method !== "POST" || !["/v1/chat/completions", "/chat/completions"].includes(url.pathname)) {
        return Response.json({ error: { message: "Unknown fixture endpoint" } }, { status: 404 });
      }
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return Response.json({ error: { message: "Expected a JSON request" } }, { status: 400 });
      }
      if (!isObject(body) || typeof body.model !== "string" || !Array.isArray(body.messages)) {
        return Response.json({ error: { message: "Expected model and messages" } }, { status: 400 });
      }

      const sanitized = redact(body) as Record<string, unknown>;
      const record: FixtureRequest = {
        id: requests.length + 1,
        receivedAt: new Date().toISOString(),
        method: request.method,
        path: url.pathname,
        model: body.model,
        stream: body.stream === true,
        body: sanitized,
        messages: (sanitized.messages as unknown[]).filter(isObject),
        status: "pending",
        unexpected: false,
      };
      requests.push(record);
      const messageHistory = JSON.stringify(body.messages);
      const index = plans.findIndex(
        (plan) =>
          (plan.model === undefined || plan.model === record.model) &&
          (plan.marker === undefined || messageHistory.includes(plan.marker)) &&
          (plan.match === undefined || plan.match(record)),
      );
      const plan: FixturePlan =
        index >= 0 ? plans.splice(index, 1)[0]! : { text: options.fallbackText ?? "Fixture response completed." };
      record.matchedPlan = plan.id;
      record.unexpected = index < 0;

      const abort = new AbortController();
      active.add(abort);
      const finish = (status: FixtureRequest["status"]) => {
        if (record.finishedAt) return;
        record.status = status;
        record.finishedAt = new Date().toISOString();
        request.signal.removeEventListener("abort", onRequestAbort);
        active.delete(abort);
      };
      const onRequestAbort = () => abort.abort();
      request.signal.addEventListener("abort", onRequestAbort, { once: true });
      abort.signal.addEventListener("abort", () => finish("aborted"), { once: true });
      if (request.signal.aborted || stopped) abort.abort();

      const wait = async () => {
        if (abort.signal.aborted) return false;
        if (!plan.hold) return !abort.signal.aborted;
        record.status = "held";
        return waitForGate(getGate(plan.hold), abort.signal);
      };
      const usage = plan.usage ?? defaultUsage;
      const calls = (plan.toolCalls ?? []).map((call, callIndex) => ({
        id: call.id ?? `fixture_call_${record.id}_${callIndex}`,
        type: "function" as const,
        function: {
          name: call.name,
          arguments: typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments),
        },
      }));
      const id = `chatcmpl-fixture-${record.id}`;
      const created = Math.floor(Date.now() / 1000);
      const reason = calls.length > 0 ? "tool_calls" : "stop";

      if (plan.error) {
        if (!(await wait())) return new Response(null, { status: 499 });
        finish("failed");
        return Response.json({ error: { message: plan.error.message, code: plan.error.code } }, { status: plan.error.status });
      }
      if (!record.stream) {
        if (!(await wait())) return new Response(null, { status: 499 });
        finish("completed");
        return Response.json({
          id,
          object: "chat.completion",
          created,
          model: record.model,
          choices: [{ index: 0, message: { role: "assistant", content: plan.text ?? (calls.length ? null : ""), ...(calls.length ? { tool_calls: calls } : {}) }, finish_reason: reason }],
          usage,
        });
      }

      // Return headers immediately. A held SSE body can be cancelled by its client;
      // holding the fetch handler itself would conceal disconnects on some hosts.
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const frame = (payload: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
          const chunk = (delta: unknown, finish_reason: string | null = null) =>
            frame({ id, object: "chat.completion.chunk", created, model: record.model, choices: [{ index: 0, delta, finish_reason }] });
          chunk({ role: "assistant" });
          void (async () => {
            try {
              if (!(await wait())) {
                try { controller.close(); } catch { /* The consumer already cancelled. */ }
                return;
              }
              const size = Math.max(1, Math.floor(plan.chunkSize ?? 8));
              if (plan.text) for (const content of slices(plan.text, size)) chunk({ content });
              for (const [callIndex, call] of calls.entries()) {
                chunk({ tool_calls: [{ index: callIndex, id: call.id, type: "function", function: { name: call.function.name, arguments: "" } }] });
                for (const argumentsPart of slices(call.function.arguments, size)) {
                  chunk({ tool_calls: [{ index: callIndex, function: { arguments: argumentsPart } }] });
                }
              }
              chunk({}, reason);
              frame({ id, object: "chat.completion.chunk", created, model: record.model, choices: [], usage });
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              controller.close();
              finish("completed");
            } catch (error) {
              finish(abort.signal.aborted ? "aborted" : "failed");
              try { controller.error(error); } catch { /* The consumer already cancelled. */ }
            }
          })();
        },
        cancel() { abort.abort(); },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
    },
  });

  return {
    baseURL: `http://127.0.0.1:${server.port}/v1`,
    requests,
    enqueue(plan) {
      if (stopped) throw new Error("Fixture provider is stopped");
      if (plan.chunkSize !== undefined && (!Number.isFinite(plan.chunkSize) || plan.chunkSize < 1)) {
        throw new Error("chunkSize must be a positive finite number");
      }
      const id = plan.id ?? `fixture_plan_${++planSequence}`;
      if (plans.some((queued) => queued.id === id)) throw new Error(`Duplicate queued fixture plan: ${id}`);
      if (plan.hold) getGate(plan.hold);
      plans.push({ ...structuredClone({ ...plan, match: undefined }), match: plan.match, id });
      return id;
    },
    hold(key) {
      const gate = getGate(key);
      if (gate.waiters.size) throw new Error(`Cannot reset an active fixture hold: ${key}`);
      gate.released = false;
    },
    release(key) {
      const gate = getGate(key);
      gate.released = true;
      for (const resolve of [...gate.waiters]) resolve();
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      for (const controller of active) controller.abort();
      await server.stop(true);
    },
  };
}

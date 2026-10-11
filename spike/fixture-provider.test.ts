import { afterEach, describe, expect, test } from "bun:test";
import { createFixtureProvider, type FixtureProvider } from "./fixture-provider";

const providers: FixtureProvider[] = [];
afterEach(async () => {
  await Promise.all(providers.splice(0).map((provider) => provider.stop()));
});

function fixture() {
  const provider = createFixtureProvider();
  providers.push(provider);
  return provider;
}

function send(provider: FixtureProvider, body: Record<string, unknown>, signal?: AbortSignal) {
  return fetch(`${provider.baseURL}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer this-must-never-be-recorded" },
    body: JSON.stringify(body),
    signal,
  });
}

function events(text: string) {
  return text.split("\n\n").filter(Boolean).map((frame) => {
    const payload = frame.replace(/^data: /, "");
    return payload === "[DONE]" ? payload : JSON.parse(payload);
  });
}

async function until(predicate: () => boolean, timeout = 1000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error("Timed out waiting for fixture state");
    await Bun.sleep(5);
  }
}

describe("local OpenCode provider fixture", () => {
  test("selects queued stages by model and marker, and records sanitized requests", async () => {
    const provider = fixture();
    provider.enqueue({ id: "worker", model: "worker-model", marker: "WORKER", text: "worker finished" });
    provider.enqueue({ id: "planner", model: "planner-model", marker: "PLAN", text: "plan finished" });
    const response = await send(provider, {
      model: "planner-model",
      messages: [{ role: "user", content: "PLAN", api_key: "private-key" }],
      apiKey: "another-private-key",
    });
    const body = await response.json() as any;
    expect(body.choices[0].message.content).toBe("plan finished");
    expect(body.usage.total_tokens).toBe(18);
    expect(provider.requests[0]?.matchedPlan).toBe("planner");
    expect(provider.requests[0]?.body.apiKey).toBe("[REDACTED]");
    expect(provider.requests[0]?.messages[0]?.api_key).toBe("[REDACTED]");
    expect(JSON.stringify(provider.requests)).not.toContain("this-must-never-be-recorded");
    const worker = await send(provider, { model: "worker-model", messages: [{ role: "user", content: "WORKER" }] });
    expect((await worker.json() as any).choices[0].message.content).toBe("worker finished");
    expect(provider.requests.every((request) => request.status === "completed" && !request.unexpected)).toBe(true);
  });

  test("streams fragmented parallel tool inputs followed by finish, usage, and DONE", async () => {
    const provider = fixture();
    provider.enqueue({
      toolCalls: [
        { id: "call_subagent", name: "subagent", arguments: { agent: "supervisor", prompt: "WORKER", background: true } },
        { id: "call_shell", name: "shell", arguments: { command: "echo fixture" } },
      ],
      chunkSize: 3,
      usage: { prompt_tokens: 19, completion_tokens: 23, total_tokens: 42 },
    });
    const response = await send(provider, { model: "fixture-model", stream: true, messages: [{ role: "user", content: "parent" }] });
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const frames = events(await response.text());
    const toolDeltas = frames.flatMap((frame) => typeof frame === "string" ? [] : frame.choices?.[0]?.delta?.tool_calls ?? []);
    const args = (index: number) => toolDeltas.filter((call: any) => call.index === index).map((call: any) => call.function.arguments).join("");
    expect(JSON.parse(args(0))).toEqual({ agent: "supervisor", prompt: "WORKER", background: true });
    expect(JSON.parse(args(1))).toEqual({ command: "echo fixture" });
    expect(toolDeltas[0].id).toBe("call_subagent");
    expect(frames.at(-3).choices[0].finish_reason).toBe("tool_calls");
    expect(frames.at(-2).usage.total_tokens).toBe(42);
    expect(frames.at(-1)).toBe("[DONE]");
  });

  test("matches the tool-result phase independently of the original prompt", async () => {
    const provider = fixture();
    provider.enqueue({ marker: "DENIED", match: (request) => request.messages.at(-1)?.role === "tool", text: "blocked action recorded" });
    const response = await send(provider, {
      model: "verifier",
      messages: [{ role: "user", content: "attempt edit" }, { role: "tool", tool_call_id: "call_edit", content: "DENIED by policy" }],
    });
    expect((await response.json() as any).choices[0].message.content).toBe("blocked action recorded");
  });

  test("holds streaming completion until released", async () => {
    const provider = fixture();
    provider.hold("worker");
    provider.enqueue({ hold: "worker", text: "settled" });
    const response = await send(provider, { model: "worker", stream: true, messages: [] });
    const output = response.text();
    expect(provider.requests[0]?.status).toBe("held");
    provider.release("worker");
    expect(events(await output).at(-3).choices[0].finish_reason).toBe("stop");
    expect(provider.requests[0]?.status).toBe("completed");
  });

  test("records cancellation of a held streaming request", async () => {
    const provider = fixture();
    provider.enqueue({ hold: "cancelled", text: "must not complete" });
    const controller = new AbortController();
    const response = await send(provider, { model: "worker", stream: true, messages: [] }, controller.signal);
    const output = response.text().catch(() => "aborted");
    controller.abort();
    await output;
    await until(() => provider.requests[0]?.status === "aborted");
    provider.release("cancelled");
    expect(provider.requests[0]?.status).toBe("aborted");
  });

  test("exposes unexpected requests and controlled provider errors", async () => {
    const provider = fixture();
    const response = await send(provider, { model: "unplanned", messages: [] });
    await response.json();
    expect(provider.requests[0]?.unexpected).toBe(true);
    provider.enqueue({ error: { status: 503, message: "fixture unavailable", code: "fixture_error" } });
    const failure = await send(provider, { model: "unplanned", messages: [] });
    expect(failure.status).toBe(503);
    expect((await failure.json() as any).error.code).toBe("fixture_error");
    expect(provider.requests[1]?.status).toBe("failed");
  });

  test("stop aborts held requests and is idempotent", async () => {
    const provider = fixture();
    provider.enqueue({ hold: "stop", text: "must not complete" });
    const response = await send(provider, { model: "worker", stream: true, messages: [] });
    const output = response.text().catch(() => "aborted");
    await provider.stop();
    await output;
    expect(provider.requests[0]?.status).toBe("aborted");
    await provider.stop();
    expect(() => provider.enqueue({ text: "after shutdown" })).toThrow("stopped");
  });
});

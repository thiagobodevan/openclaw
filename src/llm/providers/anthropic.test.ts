import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Context, Model, Tool } from "../types.js";

const anthropicMockState = vi.hoisted(() => ({
  configs: [] as unknown[],
}));

vi.mock("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    messages = {
      create: vi.fn(() => {
        throw new Error("stop after constructor");
      }),
    };

    constructor(config: unknown) {
      anthropicMockState.configs.push(config);
    }
  },
}));

import { streamAnthropic, streamSimpleAnthropic } from "./anthropic.js";

function createSseResponse(events: Record<string, unknown>[] = []): Response {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function makeAnthropicModel(overrides: Partial<Model<"anthropic-messages">> = {}) {
  return {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    provider: "anthropic",
    api: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 4096,
    ...overrides,
  } satisfies Model<"anthropic-messages">;
}

describe("Anthropic provider", () => {
  beforeEach(() => {
    anthropicMockState.configs = [];
  });

  it("keeps Cloudflare AI Gateway upstream provider auth on the Anthropic API key", async () => {
    const model = makeAnthropicModel({
      provider: "cloudflare-ai-gateway",
      baseUrl: "https://gateway.ai.cloudflare.com/v1/account/gateway/anthropic/v1/messages",
      headers: {
        "cf-aig-authorization": "Bearer gateway-token",
      },
    });
    const context = {
      messages: [{ role: "user", content: "hello", timestamp: 1 }],
    } satisfies Context;

    streamAnthropic(model, context, {
      apiKey: "sk-ant-provider",
    });

    await vi.waitFor(() => expect(anthropicMockState.configs).toHaveLength(1));
    const config = anthropicMockState.configs[0] as {
      apiKey?: string | null;
      authToken?: string | null;
      defaultHeaders?: Record<string, string | null>;
    };

    expect(config.apiKey).toBe("sk-ant-provider");
    expect(config.authToken).toBeNull();
    expect(config.defaultHeaders?.["x-api-key"]).toBeUndefined();
    expect(config.defaultHeaders?.["cf-aig-authorization"]).toBe("Bearer gateway-token");
  });

  it("preserves provider-signed Anthropic thinking text on replay", async () => {
    const highSurrogate = String.fromCharCode(0xd83d);
    const signedThinking = `keep${highSurrogate}signed`;
    let capturedPayload: unknown;
    const client = {
      messages: {
        create: vi.fn(() => ({
          asResponse: () =>
            Promise.resolve(
              createSseResponse([
                {
                  type: "message_start",
                  message: { id: "msg_1", usage: { input_tokens: 1, output_tokens: 0 } },
                },
                {
                  type: "message_delta",
                  delta: { stop_reason: "end_turn" },
                  usage: { input_tokens: 1, output_tokens: 1 },
                },
                { type: "message_stop" },
              ]),
            ),
        })),
      },
    };

    const stream = streamAnthropic(
      makeAnthropicModel(),
      {
        messages: [
          { role: "user", content: "hello", timestamp: 0 },
          {
            role: "assistant",
            provider: "anthropic",
            api: "anthropic-messages",
            model: "claude-sonnet-4-6",
            stopReason: "stop",
            timestamp: 0,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            content: [
              {
                type: "thinking",
                thinking: signedThinking,
                thinkingSignature: "sig_1",
              },
              {
                type: "thinking",
                thinking: `sanitize${highSurrogate}synthetic`,
                thinkingSignature: "reasoning_content",
              },
            ],
          },
          { role: "user", content: "again", timestamp: 0 },
        ],
      },
      {
        apiKey: "sk-ant-provider",
        client: client as never,
        onPayload: (payload) => {
          capturedPayload = payload;
        },
      },
    );

    await stream.result();

    const payload = capturedPayload as { messages: Array<{ role: string; content: unknown[] }> };
    const assistantMessage = payload.messages.find((message) => message.role === "assistant");
    expect(assistantMessage?.content).toEqual([
      {
        type: "thinking",
        thinking: signedThinking,
        signature: "sig_1",
      },
      {
        type: "thinking",
        thinking: "sanitizesynthetic",
        signature: "reasoning_content",
      },
    ]);
  });

  it("clamps max adaptive effort when the Claude model does not advertise it", async () => {
    let capturedPayload: unknown;
    const stream = streamSimpleAnthropic(
      makeAnthropicModel({
        id: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.6",
      }),
      {
        messages: [{ role: "user", content: "hello", timestamp: 0 }],
      },
      {
        apiKey: "sk-ant-provider",
        reasoning: "max",
        onPayload: (payload) => {
          capturedPayload = payload;
        },
      },
    );

    await stream.result();

    expect((capturedPayload as { output_config?: unknown }).output_config).toEqual({
      effort: "high",
    });
  });

  it("forwards simple stop sequences to Anthropic stop_sequences", async () => {
    let capturedPayload: unknown;
    const stream = streamAnthropic(
      makeAnthropicModel(),
      {
        messages: [{ role: "user", content: "hello", timestamp: 0 }],
      },
      {
        apiKey: "sk-ant-provider",
        stop: ["STOP"],
        onPayload: (payload) => {
          capturedPayload = payload;
          throw new Error("stop before network");
        },
      },
    );

    const result = await stream.result();

    expect(result.stopReason).toBe("error");
    expect((capturedPayload as { stop_sequences?: unknown }).stop_sequences).toEqual(["STOP"]);
  });

  it("quarantines unreadable Anthropic provider tools before payload projection", async () => {
    let capturedPayload: unknown;
    const unreadableTool = {
      name: "bad_plugin_tool",
      description: "bad schema",
      get parameters(): Tool["parameters"] {
        throw new Error("fuzz parameters getter exploded");
      },
    } as Tool;
    const stream = streamAnthropic(
      makeAnthropicModel(),
      {
        messages: [{ role: "user", content: "hello", timestamp: 0 }],
        tools: [
          unreadableTool,
          {
            name: "good_plugin_tool",
            description: "good schema",
            parameters: {
              type: "object",
              properties: {
                query: { type: "string" },
              },
            },
          } as Tool,
        ],
      },
      {
        apiKey: "sk-ant-provider",
        toolChoice: { type: "tool", name: "bad_plugin_tool" },
        onPayload: (payload) => {
          capturedPayload = payload;
          throw new Error("stop before network");
        },
      },
    );

    const result = await stream.result();

    expect(result.stopReason).toBe("error");
    const payload = capturedPayload as {
      tools?: Array<{ name?: string; input_schema?: unknown }>;
      tool_choice?: unknown;
    };
    expect(payload.tools?.map((tool) => tool.name)).toEqual(["good_plugin_tool"]);
    expect(payload.tools?.[0]?.input_schema).toMatchObject({
      properties: { query: { type: "string" } },
    });
    expect(payload.tool_choice).toEqual({ type: "none" });
  });

  it("preserves Anthropic provider OAuth pinned tool_choice against wire tool names", async () => {
    let capturedPayload: unknown;
    const stream = streamAnthropic(
      makeAnthropicModel(),
      {
        messages: [{ role: "user", content: "hello", timestamp: 0 }],
        tools: [
          {
            name: "read",
            description: "Read a file",
            parameters: {
              type: "object",
              properties: {
                path: { type: "string" },
              },
              required: ["path"],
            },
          } as Tool,
        ],
      },
      {
        apiKey: "sk-ant-oat-provider",
        toolChoice: { type: "tool", name: "Read" },
        onPayload: (payload) => {
          capturedPayload = payload;
          throw new Error("stop before network");
        },
      },
    );

    const result = await stream.result();

    expect(result.stopReason).toBe("error");
    const payload = capturedPayload as {
      tools?: Array<{ name?: string }>;
      tool_choice?: unknown;
    };
    expect(payload.tools?.map((tool) => tool.name)).toEqual(["Read"]);
    expect(payload.tool_choice).toEqual({ type: "tool", name: "Read" });
  });
});

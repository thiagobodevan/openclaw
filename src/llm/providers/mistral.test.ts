// Mistral provider tests cover request mapping and stream conversion.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Context, Model } from "../types.js";

const mistralMockState = vi.hoisted(() => ({
  payloads: [] as unknown[],
}));

vi.mock("@mistralai/mistralai", () => ({
  Mistral: class MockMistral {
    chat = {
      stream: vi.fn(async (payload: unknown) => {
        mistralMockState.payloads.push(payload);
        throw new Error("stop before network");
      }),
    };
  },
}));

import { streamMistral, streamSimpleMistral } from "./mistral.js";

function makeMistralModel(): Model<"mistral-conversations"> {
  return {
    id: "mistral-large-latest",
    name: "Mistral Large",
    api: "mistral-conversations",
    provider: "mistral",
    baseUrl: "https://api.mistral.ai",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8192,
  };
}

const context = {
  messages: [{ role: "user", content: "hello", timestamp: 0 }],
} satisfies Context;

describe("Mistral provider", () => {
  beforeEach(() => {
    mistralMockState.payloads = [];
  });

  it("forwards simple stop sequences to Mistral stop", async () => {
    const stream = streamSimpleMistral(makeMistralModel(), context, {
      apiKey: "sk-mistral-provider",
      stop: ["STOP"],
    });

    const result = await stream.result();

    expect(result.stopReason).toBe("error");
    expect((mistralMockState.payloads[0] as { stop?: unknown }).stop).toEqual(["STOP"]);
  });

  it("skips unreadable tools when building Mistral request payloads", async () => {
    const revokedTool = Object.create(null) as {
      name: string;
      description: string;
      parameters: Record<string, unknown>;
    };
    Object.defineProperty(revokedTool, "name", {
      enumerable: true,
      get() {
        throw new Error("tool revoked");
      },
    });
    Object.defineProperty(revokedTool, "description", {
      enumerable: true,
      value: "broken",
    });
    Object.defineProperty(revokedTool, "parameters", {
      enumerable: true,
      value: { type: "object", properties: {} },
    });
    const poisonedSchema = {
      type: "object",
      properties: {},
    };
    Object.defineProperty(poisonedSchema.properties, "query", {
      enumerable: true,
      get() {
        throw new Error("schema revoked");
      },
    });
    const poisonedSchemaTool = {
      name: "poisoned_schema",
      description: "Broken nested schema",
      parameters: poisonedSchema,
    };
    const proxySchemaTool = {
      name: "proxy_schema",
      description: "Broken proxy schema",
      parameters: new Proxy(
        { type: "object", properties: {} },
        {
          ownKeys() {
            throw new Error("schema keys revoked");
          },
        },
      ),
    };
    const revokedSchema = Proxy.revocable({ type: "object", properties: {} }, {});
    revokedSchema.revoke();
    const revokedSchemaTool = {
      name: "revoked_schema",
      description: "Revoked schema proxy",
      parameters: revokedSchema.proxy,
    };
    const healthyTool = {
      name: "healthy_tool",
      description: "Still available",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
        },
        required: ["query"],
      },
    };

    const stream = streamSimpleMistral(
      makeMistralModel(),
      {
        ...context,
        tools: [revokedTool, poisonedSchemaTool, proxySchemaTool, revokedSchemaTool, healthyTool],
      },
      {
        apiKey: "sk-mistral-provider",
      },
    );

    const result = await stream.result();

    expect(result.stopReason).toBe("error");
    expect(mistralMockState.payloads).toHaveLength(1);
    expect(
      (
        mistralMockState.payloads[0] as {
          tools?: Array<{ function?: { name?: string; parameters?: unknown } }>;
        }
      ).tools,
    ).toEqual([
      {
        type: "function",
        function: {
          name: "healthy_tool",
          description: "Still available",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string" },
            },
            required: ["query"],
          },
          strict: false,
        },
      },
    ]);
  });

  it("fails closed when forced Mistral tool choice is filtered out", async () => {
    const revokedSchema = Proxy.revocable({ type: "object", properties: {} }, {});
    revokedSchema.revoke();

    const stream = streamMistral(
      makeMistralModel(),
      {
        ...context,
        tools: [
          {
            name: "revoked_schema",
            description: "Revoked schema proxy",
            parameters: revokedSchema.proxy,
          },
          {
            name: "healthy_tool",
            description: "Still available",
            parameters: { type: "object", properties: {} },
          },
        ],
      },
      {
        apiKey: "sk-mistral-provider",
        toolChoice: { type: "function", function: { name: "revoked_schema" } },
      },
    );

    const result = await stream.result();

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain(
      'Mistral forced toolChoice "revoked_schema" is unavailable after tool schema filtering',
    );
    expect(mistralMockState.payloads).toHaveLength(0);
  });
});

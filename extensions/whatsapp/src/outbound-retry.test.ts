// WhatsApp tests cover outbound retry behavior.
import { describe, expect, it, vi } from "vitest";
import { sendWhatsAppOutboundWithRetry } from "./outbound-retry.js";
import { WhatsAppSocketOperationTimeoutError } from "./socket-timing.js";

async function runWithFakeTimers<T>(run: () => Promise<T>): Promise<T> {
  vi.useFakeTimers();
  try {
    const promise = run();
    await vi.runAllTimersAsync();
    return await promise;
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
  }
}

describe("sendWhatsAppOutboundWithRetry", () => {
  it.each([
    new Error("connection closed"),
    { error: { code: "ECONNRESET" } },
    new Error("request failed", { cause: new Error("socket disconnected") }),
  ])("retries a retryable error graph", async (error) => {
    const send = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(error)
      .mockResolvedValue("ok");

    await expect(runWithFakeTimers(() => sendWhatsAppOutboundWithRetry({ send }))).resolves.toBe(
      "ok",
    );

    expect(send).toHaveBeenCalledTimes(2);
  });

  it("does not retry a non-retryable error", async () => {
    const error = new Error("invalid recipient");
    const send = vi.fn<() => Promise<string>>().mockRejectedValue(error);
    const onRetry = vi.fn();

    const failure = await sendWhatsAppOutboundWithRetry({ send, onRetry }).catch(
      (caught: unknown) => caught,
    );

    expect(failure).toBe(error);
    expect(send).toHaveBeenCalledOnce();
    expect(onRetry).not.toHaveBeenCalled();
  });

  it.each([
    (timeout: WhatsAppSocketOperationTimeoutError) => timeout,
    (timeout: WhatsAppSocketOperationTimeoutError) => ({ error: timeout }),
    (timeout: WhatsAppSocketOperationTimeoutError) => ({
      lastDisconnect: { error: timeout },
    }),
  ])("does not retry an unknown-delivery socket timeout", async (wrap) => {
    const timeout = new WhatsAppSocketOperationTimeoutError("sendMessage", 60_000);
    const error = wrap(timeout);
    const send = vi.fn<() => Promise<string>>().mockRejectedValue(error);
    const onRetry = vi.fn();

    const failure = await sendWhatsAppOutboundWithRetry({ send, onRetry }).catch(
      (caught: unknown) => caught,
    );

    expect(failure).toBe(error);
    expect(send).toHaveBeenCalledOnce();
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("preserves attempts, delays, callback fields, and terminal error identity", async () => {
    const firstError = {
      error: {
        output: {
          statusCode: 503,
          payload: {
            statusCode: 503,
            error: "Service Unavailable",
            message: "connection closed",
          },
        },
      },
    };
    const secondError = new Error("socket reset");
    const terminalError = { code: "ECONNRESET", marker: "terminal" };
    const send = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(firstError)
      .mockRejectedValueOnce(secondError)
      .mockRejectedValueOnce(terminalError);
    const onRetry = vi.fn();

    const failure = await runWithFakeTimers(() =>
      sendWhatsAppOutboundWithRetry({ send, onRetry }).catch((caught: unknown) => caught),
    );

    expect(failure).toBe(terminalError);
    expect(send).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenNthCalledWith(1, {
      attempt: 1,
      maxAttempts: 3,
      backoffMs: 500,
      error: firstError,
      errorText: "status=503 Service Unavailable connection closed",
    });
    expect(onRetry).toHaveBeenNthCalledWith(2, {
      attempt: 2,
      maxAttempts: 3,
      backoffMs: 1_000,
      error: secondError,
      errorText: "socket reset",
    });
  });
});

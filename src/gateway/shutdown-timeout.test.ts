import { describe, expect, it, vi } from "vitest";
import { runShutdownStepWithTimeout } from "./shutdown-timeout.js";

describe("runShutdownStepWithTimeout", () => {
  it("reports completed steps", async () => {
    await expect(
      runShutdownStepWithTimeout({
        run: async () => undefined,
        timeoutMs: 100,
      }),
    ).resolves.toEqual({ status: "completed" });
  });

  it("reports failures before timeout", async () => {
    const error = new Error("stop failed");

    await expect(
      runShutdownStepWithTimeout({
        run: async () => {
          throw error;
        },
        timeoutMs: 100,
      }),
    ).resolves.toEqual({ status: "failed", error });
  });

  it("reports timeouts and consumes later rejections", async () => {
    vi.useFakeTimers();
    const onLateFailure = vi.fn();
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandledRejection);
    try {
      let rejectStep!: (error: Error) => void;
      const resultPromise = runShutdownStepWithTimeout({
        run: () =>
          new Promise<void>((_resolve, reject) => {
            rejectStep = reject;
          }),
        timeoutMs: 100,
        onLateFailure,
      });

      await vi.advanceTimersByTimeAsync(100);
      await expect(resultPromise).resolves.toEqual({ status: "timed-out" });

      const lateError = new Error("late failure");
      rejectStep(lateError);
      await vi.runAllTicks();
      await vi.advanceTimersByTimeAsync(0);

      expect(onLateFailure).toHaveBeenCalledWith(lateError);
      expect(unhandledRejections).toStrictEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
      vi.useRealTimers();
    }
  });
});

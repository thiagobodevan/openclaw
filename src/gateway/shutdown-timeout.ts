export type ShutdownTimeoutResult =
  | { status: "completed" }
  | { status: "failed"; error: unknown }
  | { status: "timed-out" };

export async function runShutdownStepWithTimeout(params: {
  run: () => Promise<void> | void;
  timeoutMs: number;
  onLateFailure?: (error: unknown) => void;
}): Promise<ShutdownTimeoutResult> {
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stepPromise = Promise.resolve().then(params.run);
  void stepPromise.catch((error: unknown) => {
    if (timedOut) {
      params.onLateFailure?.(error);
    }
  });

  try {
    return await Promise.race<ShutdownTimeoutResult>([
      stepPromise.then(
        () => ({ status: "completed" }),
        (error: unknown) => ({ status: "failed", error }),
      ),
      new Promise<{ status: "timed-out" }>((resolve) => {
        timer = setTimeout(
          () => {
            timedOut = true;
            resolve({ status: "timed-out" });
          },
          Math.max(0, Math.floor(params.timeoutMs)),
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

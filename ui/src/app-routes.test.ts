import { afterEach, describe, expect, it, vi } from "vitest";
import { appRouter, startAppRouter, type RouteLoadContext } from "./app-routes.ts";
import type { RouteLocation, RouterHistory } from "./router/index.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("startAppRouter", () => {
  it("publishes the initial location before its route starts loading", async () => {
    const initialLocation: RouteLocation = {
      pathname: "/chat",
      search: "?session=agent%3Asupport%3Amain",
      hash: "",
    };
    const history: RouterHistory = {
      location: () => initialLocation,
      push: vi.fn(),
      replace: vi.fn(),
      listen: vi.fn(() => vi.fn()),
    };
    const onLocation = vi.fn();
    vi.spyOn(appRouter, "start").mockImplementation(async (resolvedHistory) => {
      expect(onLocation).toHaveBeenCalledWith(initialLocation);
      expect(resolvedHistory.location()).toEqual(initialLocation);
    });

    await startAppRouter(history, "", {} as RouteLoadContext, onLocation);

    expect(onLocation).toHaveBeenCalledOnce();
  });
});

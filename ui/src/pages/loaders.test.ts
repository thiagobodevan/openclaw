import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SettingsHost } from "../app/app-host.ts";
import { loadChannels } from "../ui/controllers/channels.ts";
import { loadCronJobsPage, loadCronRuns, loadCronStatus } from "../ui/controllers/cron.ts";
import { loadCron, loadCronPage } from "./loaders.ts";

vi.mock("../ui/controllers/channels.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ui/controllers/channels.ts")>()),
  loadChannels: vi.fn(async () => undefined),
}));

vi.mock("../ui/controllers/cron.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ui/controllers/cron.ts")>()),
  loadCronJobsPage: vi.fn(async () => undefined),
  loadCronRuns: vi.fn(async () => "ok"),
  loadCronStatus: vi.fn(async () => undefined),
}));

describe("cron page loading", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses table filters only for the Cron page owner", async () => {
    const host = {
      cronRunsScope: "all",
      cronRunsJobId: null,
    } as unknown as SettingsHost;

    await loadCron(host);
    expect(loadCronJobsPage).toHaveBeenLastCalledWith(host, { tableFilters: false });

    await loadCronPage(host);
    expect(loadCronJobsPage).toHaveBeenLastCalledWith(host, { tableFilters: true });
    expect(loadChannels).toHaveBeenCalledTimes(2);
    expect(loadCronRuns).toHaveBeenCalledTimes(2);
    expect(loadCronStatus).toHaveBeenCalledTimes(2);
  });
});

// Control UI module implements main behavior.
import "./styles.css";
import { inferControlUiPublicAssetPath } from "./ui/public-assets.ts";

type ViteImportMeta = ImportMeta & {
  readonly env?: {
    readonly PROD?: boolean;
  };
};

declare const OPENCLAW_CONTROL_UI_BUILD_ID: string | undefined;

const isProd = (import.meta as ViteImportMeta).env?.PROD === true;
const currentControlUiBuildId = OPENCLAW_CONTROL_UI_BUILD_ID || "dev";
const isSetupPage =
  /\/setup\/?$/u.test(window.location.pathname) &&
  new URLSearchParams(window.location.search).get("openclawSetup") === "1";

syncDocumentPublicAssetLinks();

if (isSetupPage) {
  document.title = "OpenClaw Setup";
  void import("./setup/main.ts");
} else if (isProd && "serviceWorker" in navigator) {
  void import("./ui/app.ts");
  const swUrl = new URL(inferControlUiPublicAssetPath("sw.js"), window.location.origin);
  swUrl.searchParams.set("v", currentControlUiBuildId);
  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data?.type === "sw-updated" && event.data.version !== currentControlUiBuildId) {
      window.location.reload();
    }
  });
  void navigator.serviceWorker.register(swUrl, { updateViaCache: "none" });
} else if (!isProd && "serviceWorker" in navigator) {
  void import("./ui/app.ts");
  // Unregister any leftover dev SW to avoid stale cache issues.
  void navigator.serviceWorker.getRegistrations().then((registrations) => {
    for (const r of registrations) {
      void r.unregister();
    }
  });
} else {
  void import("./ui/app.ts");
}

function syncDocumentPublicAssetLinks() {
  setDocumentLinkHref('link[rel="icon"][type="image/svg+xml"]', "favicon.svg");
  setDocumentLinkHref('link[rel="icon"][type="image/png"]', "favicon-32.png");
  setDocumentLinkHref('link[rel="apple-touch-icon"]', "apple-touch-icon.png");
  setDocumentLinkHref('link[rel="manifest"]', "manifest.webmanifest");
}

function setDocumentLinkHref(
  selector: string,
  asset: Parameters<typeof inferControlUiPublicAssetPath>[0],
) {
  const link = document.querySelector<HTMLLinkElement>(selector);
  if (!link) {
    return;
  }
  const setupBasePath = isSetupPage
    ? window.location.pathname.replace(/\/setup\/?$/u, "")
    : undefined;
  link.href = inferControlUiPublicAssetPath(
    asset,
    isSetupPage ? { basePath: setupBasePath ?? "" } : undefined,
  );
}

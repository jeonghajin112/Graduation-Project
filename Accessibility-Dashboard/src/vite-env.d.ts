/// <reference types="vite/client" />

// Variables read by application code. Build/server-only variables
// (VITE_DEV_PROXY_TARGET, VITE_ALLOWED_HOSTS) are read in vite.config.ts.
interface ImportMetaEnv {
  /** API base; empty means same-origin "/api". */
  readonly VITE_API_BASE_URL?: string;
  /** Live report viewer origin; required for production builds. */
  readonly VITE_LIVE_REPORT_VIEWER_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

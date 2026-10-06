import { defineConfig, loadEnv, type Plugin, type ProxyOptions } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const bundleTextEncoder = new TextEncoder();

function normalizeBundleModuleId(moduleId: string): string {
  const normalizedId = moduleId.replace(/\\/g, "/");
  const dependencyIndex = normalizedId.indexOf("/node_modules/");
  if (dependencyIndex >= 0) {
    return normalizedId.slice(dependencyIndex + 1);
  }

  const sourceIndex = normalizedId.lastIndexOf("/src/");
  if (sourceIndex >= 0) {
    return normalizedId.slice(sourceIndex + 1);
  }

  return normalizedId;
}

function bundleAnalysisPlugin(): Plugin {
  return {
    name: "local-bundle-analysis",
    apply: "build",
    generateBundle(_options, bundle) {
      const chunks = Object.values(bundle)
        .filter((output): output is Extract<typeof output, { type: "chunk" }> => output.type === "chunk")
        .map((chunk) => ({
          fileName: chunk.fileName,
          isEntry: chunk.isEntry,
          isDynamicEntry: chunk.isDynamicEntry,
          rawBytes: bundleTextEncoder.encode(chunk.code).byteLength,
          imports: chunk.imports,
          dynamicImports: chunk.dynamicImports,
          modules: Object.entries(chunk.modules)
            .map(([moduleId, module]) => ({
              id: normalizeBundleModuleId(moduleId),
              renderedBytes: module.renderedLength
            }))
            .sort((left, right) => right.renderedBytes - left.renderedBytes)
        }))
        .sort((left, right) => right.rawBytes - left.rawBytes);

      this.emitFile({
        type: "asset",
        fileName: "bundle-analysis.json",
        source: JSON.stringify(
          {
            totalJavaScriptBytes: chunks.reduce((total, chunk) => total + chunk.rawBytes, 0),
            chunks
          },
          null,
          2
        )
      });
    }
  };
}

const LIVE_REPORT_VIEWER_ENV_KEY = "VITE_LIVE_REPORT_VIEWER_BASE_URL";
const LIVE_REPORT_VIEWER_LOCAL_OVERRIDE_KEY = "LIVE_REPORT_VIEWER_ALLOW_LOCAL";
// The bundle-boundary check only measures chunks. It never contacts a viewer,
// so it builds with a reserved, non-resolvable https origin.
const BUNDLE_CHECK_VIEWER_BASE_URL = "https://viewer.bundle-check.invalid";
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]"]);

function isLocalHostname(hostname: string): boolean {
  return LOCAL_HOSTNAMES.has(hostname) || hostname.endsWith(".localhost");
}

/**
 * A production bundle without an explicit viewer origin silently falls back
 * to http://localhost:9090 (src/config/live-report.ts), and every deployed
 * viewer frame is then rejected by the origin check. Fail the build instead.
 */
function assertDeployableLiveReportViewer(rawValue: string | undefined): void {
  if (process.env[LIVE_REPORT_VIEWER_LOCAL_OVERRIDE_KEY] === "true") {
    return;
  }

  const value = rawValue?.trim() ?? "";
  const hint =
    `Set ${LIVE_REPORT_VIEWER_ENV_KEY} to the deployed live report viewer origin ` +
    `(for example https://viewer.example.com) in the build environment or .env.production.local. ` +
    `It must match the backend LIVE_REPORT_VIEWER_BASE_URL. ` +
    `To build against a local backend on purpose, set ${LIVE_REPORT_VIEWER_LOCAL_OVERRIDE_KEY}=true.`;

  if (value.length === 0) {
    throw new Error(`[live-report] ${LIVE_REPORT_VIEWER_ENV_KEY} is empty for a production build. ${hint}`);
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`[live-report] ${LIVE_REPORT_VIEWER_ENV_KEY} is not a valid URL: "${value}". ${hint}`);
  }

  if (isLocalHostname(url.hostname)) {
    throw new Error(
      `[live-report] ${LIVE_REPORT_VIEWER_ENV_KEY} points to a local host (${url.origin}) in a production build. ${hint}`
    );
  }

  if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash) {
    throw new Error(
      `[live-report] ${LIVE_REPORT_VIEWER_ENV_KEY} must be a bare https origin such as https://viewer.example.com, received "${value}". ${hint}`
    );
  }
}

/**
 * `--mode analyze` must measure the same bundle a production build ships, so
 * it reads the production env files. Variables already present in the shell
 * keep priority, exactly as in a production build.
 */
function applyProductionEnvForAnalysis(): void {
  const productionEnv = loadEnv("production", ".", "VITE_");
  for (const [key, value] of Object.entries(productionEnv)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
  process.env[LIVE_REPORT_VIEWER_ENV_KEY] = BUNDLE_CHECK_VIEWER_BASE_URL;
}

export default defineConfig(({ command, mode }) => {
  if (command === "build" && mode === "analyze") {
    applyProductionEnvForAnalysis();
  }
  // loadEnv also merges variables already set in the shell (process.env).
  const env = loadEnv(mode, ".", "");
  if (command === "build" && (mode === "production" || mode === "analyze")) {
    assertDeployableLiveReportViewer(env[LIVE_REPORT_VIEWER_ENV_KEY]);
  }
  const proxyTarget = env.VITE_DEV_PROXY_TARGET?.trim();
  const allowedHosts = (env.VITE_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((host) => host.trim())
    .filter((host) => host.length > 0);
  const proxy: Record<string, ProxyOptions> | undefined = proxyTarget
    ? {
        "/api": {
          target: proxyTarget,
          changeOrigin: true,
          secure: false,
          configure(proxy) {
            proxy.on("proxyReq", (proxyRequest) => {
              // The browser talks to Vite on the same origin. Do not forward
              // that development origin to Spring's cross-origin filter.
              proxyRequest.removeHeader("origin");
            });
          }
        }
      }
    : undefined;

  return {
    plugins: [
      react(),
      tailwindcss(),
      ...(mode === "analyze" ? [bundleAnalysisPlugin()] : [])
    ],
    resolve: {
      alias: {
        "@": "/src"
      }
    },
    server: proxy ? { proxy } : undefined,
    preview: {
      ...(proxy ? { proxy } : {}),
      ...(allowedHosts.length > 0 ? { allowedHosts } : {})
    }
  };
});

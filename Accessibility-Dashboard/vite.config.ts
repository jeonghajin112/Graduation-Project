import { defineConfig, loadEnv, type Plugin } from "vite";
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

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "");
  const proxyTarget = env.VITE_DEV_PROXY_TARGET?.trim();
  const allowedHosts = (env.VITE_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((host) => host.trim())
    .filter((host) => host.length > 0);
  const proxy = proxyTarget
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

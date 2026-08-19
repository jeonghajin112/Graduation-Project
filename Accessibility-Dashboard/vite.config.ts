import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

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
    plugins: [react(), tailwindcss({ optimize: { minify: false } })],
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

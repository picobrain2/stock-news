import { defineConfig, type PreviewServer, type ViteDevServer } from "vite";
import { handleApi } from "./server/api";

function attach(server: ViteDevServer | PreviewServer): void {
  server.middlewares.use((req, res, next) => {
    const url = req.url ?? "";
    if (!url.startsWith("/api/")) {
      next();
      return;
    }
    void handleApi(req, res).catch((err: unknown) => {
      res.statusCode = 500;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : "server error" }));
    });
  });
}

export default defineConfig({
  base: process.env.GITHUB_ACTIONS ? "/stock-news/" : "./",
  plugins: [
    {
      name: "sihwang-api",
      configureServer: attach,
      configurePreviewServer: attach,
    },
  ],
  server: { port: 5174, strictPort: true },
  preview: { port: 4174, strictPort: true },
});

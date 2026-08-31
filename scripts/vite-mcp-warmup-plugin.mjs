/**
 * Warm Shopify MCP tools/list when the Vite/React Router server starts listening.
 * Must run in the same Node process as chat (in-memory cache).
 */
export function mcpToolsWarmupPlugin() {
  return {
    name: "mcp-tools-warmup",
    apply: "serve",
    configureServer(server) {
      let started = false;

      const runWarmup = async () => {
        if (started) return;
        started = true;

        try {
          await import("dotenv/config");
          const mod = await server.ssrLoadModule("/app/mcp-client.js");
          const warm = mod.warmMcpToolsAtStartup || mod.ensureMcpToolsWarmed;
          if (typeof warm !== "function") {
            throw new Error("warmMcpToolsAtStartup export not found");
          }

          console.log("[mcp] server listening — warming tools/list cache…");
          const result = await (mod.warmMcpToolsAtStartup
            ? mod.warmMcpToolsAtStartup({ failHard: true })
            : mod.ensureMcpToolsWarmed());

          if (result?.error) {
            throw new Error(result.error);
          }
        } catch (error) {
          console.error(
            "[mcp] fatal: tools warmup failed at server start —",
            error?.message || error
          );
          process.exit(1);
        }
      };

      const attach = () => {
        const httpServer = server.httpServer;
        if (!httpServer) {
          setTimeout(attach, 25);
          return;
        }
        if (httpServer.listening) {
          void runWarmup();
          return;
        }
        httpServer.once("listening", () => {
          void runWarmup();
        });
      };

      attach();
    }
  };
}

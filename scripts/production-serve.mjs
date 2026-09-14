/**
 * Production server for `npm run start`.
 *
 * Same role as `react-router-serve`, but:
 * - loads `.env` (Vite does this for `dev:server`; stock serve does not)
 * - skips gzip/brotli for SSE so chat streaming works
 *
 * Does not affect `npm run dev:server` (Vite path).
 */
import "dotenv/config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequestHandler } from "@react-router/express";
import { createRequestListener } from "@mjackson/node-fetch-server";
import compression from "compression";
import express from "express";
import getPort from "get-port";
import morgan from "morgan";
import sourceMapSupport from "source-map-support";

process.env.NODE_ENV = process.env.NODE_ENV ?? "production";

sourceMapSupport.install({
  retrieveSourceMap(source) {
    if (!source.startsWith("file://")) return null;
    const filePath = new URL(source).pathname;
    const sourceMapPath = `${filePath}.map`;
    if (!fs.existsSync(sourceMapPath)) return null;
    return {
      url: source,
      map: fs.readFileSync(sourceMapPath, "utf8")
    };
  }
});

function parseNumber(raw) {
  if (raw === undefined) return undefined;
  const maybe = Number(raw);
  return Number.isNaN(maybe) ? undefined : maybe;
}

function isRSCServerBuild(build) {
  return Boolean(
    typeof build === "object" &&
      build &&
      "default" in build &&
      typeof build.default === "object" &&
      build.default &&
      "fetch" in build.default &&
      typeof build.default.fetch === "function"
  );
}

/** Do not compress chat SSE — buffering breaks the storefront stream reader. */
function shouldCompress(req, res) {
  const type = String(res.getHeader("Content-Type") || "");
  if (type.includes("text/event-stream")) return false;
  const accept = String(req.headers.accept || "");
  if (accept.includes("text/event-stream")) return false;
  return compression.filter(req, res);
}

async function run() {
  const port =
    parseNumber(process.env.PORT) ?? (await getPort({ port: 3000 }));
  const buildPathArg = process.argv[2] || "./build/server/index.js";
  const buildPath = path.resolve(buildPathArg);

  if (!fs.existsSync(buildPath)) {
    console.error(
      `[production-serve] Missing build at ${buildPath}. Run: npm run build`
    );
    process.exit(1);
  }

  const buildModule = await import(pathToFileURL(buildPath).href);
  let build;
  let isRSCBuild = false;

  if ((isRSCBuild = isRSCServerBuild(buildModule))) {
    const config = {
      publicPath: "/",
      assetsBuildDirectory: "../client",
      ...(buildModule.unstable_reactRouterServeConfig || {})
    };
    build = {
      fetch: buildModule.default.fetch,
      publicPath: config.publicPath,
      assetsBuildDirectory: path.resolve(
        path.dirname(buildPath),
        config.assetsBuildDirectory
      )
    };
  } else {
    build = buildModule;
  }

  const onListen = () => {
    const address =
      process.env.HOST ||
      Object.values(os.networkInterfaces())
        .flat()
        .find((ip) => String(ip?.family).includes("4") && !ip?.internal)
        ?.address;
    if (!address) {
      console.log(`[production-serve] http://localhost:${port}`);
    } else {
      console.log(
        `[production-serve] http://localhost:${port} (http://${address}:${port})`
      );
    }
  };

  const app = express();
  app.disable("x-powered-by");

  if (!isRSCBuild) {
    app.use(compression({ filter: shouldCompress }));
  }

  app.use(
    path.posix.join(build.publicPath, "assets"),
    express.static(path.join(build.assetsBuildDirectory, "assets"), {
      immutable: true,
      maxAge: "1y"
    })
  );
  app.use(build.publicPath, express.static(build.assetsBuildDirectory));
  app.use(express.static("public", { maxAge: "1h" }));
  app.use(morgan("tiny"));

  if (build.fetch) {
    app.all("*", createRequestListener(build.fetch));
  } else {
    app.all(
      "*",
      createRequestHandler({
        build: buildModule,
        mode: process.env.NODE_ENV
      })
    );
  }

  const server = process.env.HOST
    ? app.listen(port, process.env.HOST, onListen)
    : app.listen(port, onListen);

  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.once(signal, () => server?.close(console.error));
  }
}

run().catch((error) => {
  console.error("[production-serve] failed to start:", error);
  process.exit(1);
});

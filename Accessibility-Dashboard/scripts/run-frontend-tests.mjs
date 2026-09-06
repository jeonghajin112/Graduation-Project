import { mkdir, mkdtemp, open, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { FRONTEND_TEST_SUITES } from "./frontend-test-suites.mjs";
import {
  DEFAULT_TEST_BASE_URL, parseTestOptions, selectFrontendTests,
  resolveTestBaseUrl, resolveTestPort, TEST_HOST
} from "./frontend-test-runtime.mjs";
import { runTestProcess } from "./frontend-test-process.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const dashboardDirectory = path.resolve(scriptDirectory, "..");

const usage = `Usage: npm run test:run -- [options]
  --suite <name>  Run a suite (default ci when selecting individual tests)
  --test <file>   Select a test; repeat to run several in one Vite session
  --list          List available tests as JSON without starting servers or tests
  --verbose       Stream test output as well as saving it to logs
  --help          Show this help

No selection prints help. npm test remains the full build/unit/CI entry point.
Available suites: ${Object.keys(FRONTEND_TEST_SUITES).join(", ")}`;

function readPositiveInteger(name, fallback) {
  const rawValue = process.env[name]?.trim();
  if (!rawValue) return fallback;
  const value = Number(rawValue);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer: ${rawValue}`);
  }
  return value;
}

async function startViteServer(port, baseUrl, backendUrl, signal) {
  process.env.VITE_API_BASE_URL = "";
  process.env.VITE_DEV_PROXY_TARGET = backendUrl;
  const { createServer } = await import("vite");
  const server = await createServer({
    root: dashboardDirectory,
    clearScreen: false,
    logLevel: "error",
    server: { host: TEST_HOST, port, strictPort: true }
  });
  try {
    signal.throwIfAborted();
    await server.listen();
    const response = await fetch(baseUrl, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)])
    });
    if (!response.ok) throw new Error(`Vite readiness check failed with HTTP ${response.status}`);
    return server;
  } catch (error) {
    await server.close();
    throw error;
  }
}

async function readLogTail(logPath) {
  const log = await open(logPath, "r");
  try {
    const { size } = await log.stat();
    const length = Math.min(size, 12_000);
    const buffer = Buffer.alloc(length);
    await log.read(buffer, 0, length, size - length);
    return buffer.toString("utf8").trim();
  } finally {
    await log.close();
  }
}

async function main() {
  const options = parseTestOptions(process.argv.slice(2));
  if (options.help) {
    console.log(usage);
    return;
  }

  const suiteName = options.suite ?? "ci";
  const suite = selectFrontendTests(FRONTEND_TEST_SUITES, suiteName, options.tests);
  if (options.list) {
    const listed = options.suite || options.tests.length > 0
      ? { [suiteName]: suite }
      : FRONTEND_TEST_SUITES;
    console.log(JSON.stringify(listed, null, 2));
    return;
  }

  const needsVite = suite.some((test) => test.needsVite);
  const needsBackend = suite.some((test) => test.needsBackend);
  if (needsBackend && !process.env.TEST_BACKEND_URL?.trim()) {
    throw new Error("The backend suite requires TEST_BACKEND_URL (for example http://127.0.0.1:9090).");
  }
  const backendUrl = needsBackend ? resolveTestBaseUrl("TEST_BACKEND_URL") : "";
  const port = needsVite ? resolveTestPort() : null;
  const baseUrl = needsVite ? `http://${TEST_HOST}:${port}` : DEFAULT_TEST_BASE_URL;
  const timeoutMs = readPositiveInteger("TEST_TIMEOUT_MS", 180_000);
  const artifactRoot = path.join(dashboardDirectory, "artifacts", "frontend-tests");
  await mkdir(artifactRoot, { recursive: true });
  const runDirectory = await mkdtemp(path.join(artifactRoot, suiteName + "-"));
  const reportPath = path.join(runDirectory, "results.json");
  const report = {
    suite: suiteName,
    status: "running",
    startedAt: new Date().toISOString(),
    completedAt: null,
    baseUrl: needsVite ? baseUrl : null,
    timeoutMs,
    selectedTests: suite.map((test) => ({ file: test.file, label: test.label ?? test.file })),
    results: []
  };
  const saveReport = () => writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  await saveReport();
  console.log(`[test:${suiteName}] Report: ${reportPath}`);

  const controller = new AbortController();
  const onInterrupt = () => controller.abort();
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onInterrupt);
  let viteServer = null;

  try {
    if (needsVite) {
      viteServer = await startViteServer(port, baseUrl, backendUrl, controller.signal);
      console.log(`[test:${suiteName}] Vite ready at ${baseUrl}`);
    }
    for (const [index, test] of suite.entries()) {
      if (controller.signal.aborted) break;
      const label = test.label ?? test.file;
      const logFile = `${String(index + 1).padStart(2, "0")}-${test.file}.log`;
      const logPath = path.join(runDirectory, logFile);
      console.log(`[test:${suiteName}] RUN ${label}`);
      const result = await runTestProcess(path.join(scriptDirectory, test.file), {
        cwd: dashboardDirectory,
        env: {
          ...process.env,
          BASE_URL: baseUrl,
          SIDEBAR_TEST_BASE_URL: baseUrl,
          ...test.environment
        },
        timeoutMs,
        signal: controller.signal,
        logPath,
        verbose: options.verbose
      });
      report.results.push({ file: test.file, label, ...result, logFile });
      await saveReport();
      console.log(`[test:${suiteName}] ${result.status.toUpperCase()} ${label} (${(result.durationMs / 1000).toFixed(1)}s)`);
      if (result.status !== "passed") {
        if (result.error) console.error(result.error);
        if (!options.verbose) console.error(await readLogTail(logPath));
        console.error(`[test:${suiteName}] Log: ${logPath}`);
      }
    }
    report.status = controller.signal.aborted
      ? "interrupted"
      : report.results.every((result) => result.status === "passed") ? "passed" : "failed";
  } catch (error) {
    report.status = controller.signal.aborted ? "interrupted" : "error";
    report.error = error.message;
    console.error(`[test:${suiteName}] ${error.message}`);
  } finally {
    try {
      if (viteServer) {
        await viteServer.close();
        console.log(`[test:${suiteName}] Vite stopped`);
      }
    } catch (error) {
      report.status = "error";
      report.error = error.message;
    }
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onInterrupt);
    report.completedAt = new Date().toISOString();
    report.notRunCount = suite.length - report.results.length;
    await saveReport();
  }

  const passed = report.results.filter((result) => result.status === "passed").length;
  console.log(`[test:${suiteName}] ${passed}/${suite.length} passed; status: ${report.status}; not run: ${report.notRunCount}`);
  console.log(`[test:${suiteName}] Report: ${reportPath}`);
  if (report.status !== "passed") {
    const passedFiles = new Set(report.results.filter((result) => result.status === "passed").map((result) => result.file));
    const retryTests = suite.filter((test) => !passedFiles.has(test.file));
    console.log(`[test:${suiteName}] Retry: npm run test:run -- --suite ${suiteName}${retryTests.map((test) => " --test " + test.file).join("")}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`[frontend-tests] ${error.message}`);
  process.exitCode = 1;
});

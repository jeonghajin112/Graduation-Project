import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createServer } from "vite";

import { FRONTEND_TEST_SUITES } from "./frontend-test-suites.mjs";
import { resolveTestPort, TEST_HOST } from "./frontend-test-runtime.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const dashboardDirectory = path.resolve(scriptDirectory, "..");
const suiteName = readOption("--suite") ?? "ci";
const configuredSuite = FRONTEND_TEST_SUITES[suiteName];
const requestedTest = readOption("--test");
const testTimeoutMs = readPositiveInteger("TEST_TIMEOUT_MS", 180_000);

if (!configuredSuite) {
  throw new Error(
    `Unknown test suite "${suiteName}". Available suites: ${Object.keys(FRONTEND_TEST_SUITES).join(", ")}`
  );
}

const suite = requestedTest
  ? configuredSuite.filter((test) => test.file === requestedTest || test.label === requestedTest)
  : configuredSuite;
if (requestedTest && suite.length !== 1) {
  throw new Error(
    `Test "${requestedTest}" must identify exactly one entry in suite "${suiteName}"; received ${suite.length}.`
  );
}

const needsVite = suite.some((test) => test.needsVite);
const needsBackend = suite.some((test) => test.needsBackend);
const testPort = resolveTestPort();
const baseUrl = `http://${TEST_HOST}:${testPort}`;
const backendUrl = process.env.TEST_BACKEND_URL?.trim() ?? "";

if (needsBackend && !backendUrl) {
  throw new Error(
    "The backend suite requires TEST_BACKEND_URL (for example http://127.0.0.1:9090)."
  );
}

let viteServer = null;
let activeTestProcess = null;
let interrupted = false;

function readOption(name) {
  const optionIndex = process.argv.indexOf(name);
  return optionIndex >= 0 ? process.argv[optionIndex + 1] : null;
}

function readPositiveInteger(name, fallback) {
  const rawValue = process.env[name]?.trim();
  if (!rawValue) {
    return fallback;
  }

  const value = Number(rawValue);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer: ${rawValue}`);
  }
  return value;
}

async function startViteServer() {
  // An isolated suite must never inherit a developer's real API URL or proxy.
  process.env.VITE_API_BASE_URL = "";
  process.env.VITE_DEV_PROXY_TARGET = needsBackend ? backendUrl : "";

  const server = await createServer({
    root: dashboardDirectory,
    clearScreen: false,
    logLevel: "error",
    server: {
      host: TEST_HOST,
      port: testPort,
      strictPort: true
    }
  });
  await server.listen();

  const response = await fetch(baseUrl, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) {
    await server.close();
    throw new Error(`Vite readiness check failed with HTTP ${response.status}: ${baseUrl}`);
  }

  return server;
}

function runTest(test) {
  const label = test.label ?? test.file;
  const scriptPath = path.join(scriptDirectory, test.file);
  const startedAt = performance.now();

  console.log(`\n[test:${suiteName}] RUN  ${label}`);

  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath], {
      cwd: dashboardDirectory,
      env: {
        ...process.env,
        BASE_URL: baseUrl,
        SIDEBAR_TEST_BASE_URL: baseUrl,
        ...test.environment
      },
      shell: false,
      stdio: "inherit"
    });
    activeTestProcess = child;

    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
    }, testTimeoutMs);

    child.once("error", (error) => {
      clearTimeout(timeout);
      activeTestProcess = null;
      resolve({ label, passed: false, durationMs: performance.now() - startedAt, error });
    });

    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      activeTestProcess = null;
      const durationMs = performance.now() - startedAt;
      const passed = code === 0;
      console.log(
        `[test:${suiteName}] ${passed ? "PASS" : "FAIL"} ${label} (${(durationMs / 1000).toFixed(1)}s)`
      );
      resolve({ label, passed, durationMs, code, signal });
    });
  });
}

function handleSignal() {
  interrupted = true;
  activeTestProcess?.kill("SIGTERM");
}

process.once("SIGINT", handleSignal);
process.once("SIGTERM", handleSignal);

const results = [];
try {
  if (needsVite) {
    viteServer = await startViteServer();
    console.log(`[test:${suiteName}] Vite ready at ${baseUrl}`);
  }

  for (const test of suite) {
    if (interrupted) {
      break;
    }
    results.push(await runTest(test));
  }
} finally {
  activeTestProcess?.kill("SIGTERM");
  if (viteServer) {
    await viteServer.close();
    console.log(`[test:${suiteName}] Vite stopped`);
  }
}

const failures = results.filter((result) => !result.passed);
console.log(
  `\n[test:${suiteName}] ${results.length - failures.length}/${results.length} passed` +
    (failures.length > 0 ? `; failed: ${failures.map((failure) => failure.label).join(", ")}` : "")
);

if (interrupted || failures.length > 0 || results.length !== suite.length) {
  process.exitCode = 1;
}

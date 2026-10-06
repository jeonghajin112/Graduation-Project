import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { FRONTEND_TEST_SUITES } from "./frontend-test-suites.mjs";
import {
  DEFAULT_TEST_BASE_URL,
  DEFAULT_TEST_PORT,
  parseTestOptions,
  resolveTestBaseUrl,
  resolveTestPort,
  selectFrontendTests
} from "./frontend-test-runtime.mjs";
import { runTestProcess } from "./frontend-test-process.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const scriptFiles = new Set(await readdir(scriptDirectory));
const activeTestFiles = new Set();

for (const [suiteName, suite] of Object.entries(FRONTEND_TEST_SUITES)) {
  assert.ok(suite.length > 0, suiteName + " must contain a test");
  const labels = new Set();
  for (const test of suite) {
    assert.equal(scriptFiles.has(test.file), true, "Unknown test file: " + test.file);
    assert.equal(typeof test.needsVite, "boolean", test.file + " must declare whether it needs Vite");
    const label = test.label ?? test.file;
    assert.equal(labels.has(label), false, "Duplicate test in " + suiteName + ": " + label);
    labels.add(label);
    activeTestFiles.add(test.file);
  }
}

for (const test of FRONTEND_TEST_SUITES.ci) {
  assert.ok(!test.needsBackend, test.file + " must not require a backend in CI");
  assert.ok(!test.crossStack, test.file + " must not read backend source in CI");
}
const ciFiles = new Set(FRONTEND_TEST_SUITES.ci.map((test) => test.file));
for (const test of FRONTEND_TEST_SUITES.backend) {
  assert.equal(ciFiles.has(test.file), false, test.file + " must stay out of the isolated CI suite");
}

for (const file of scriptFiles) {
  if (file.startsWith("verify-") && file.endsWith(".mjs") && file !== "verify-bundle-boundaries.mjs") {
    assert.equal(activeTestFiles.has(file), true, "Unregistered verification script: " + file);
  }
}

// Exercise URL configuration itself instead of prescribing how each test calls it.
const variableNames = ["BASE_URL", "SIDEBAR_TEST_BASE_URL", "TEST_PORT"];
const originalEnvironment = variableNames.map((name) => [name, process.env[name]]);
try {
  for (const name of variableNames) delete process.env[name];
  assert.equal(resolveTestBaseUrl(), DEFAULT_TEST_BASE_URL);
  assert.equal(resolveTestPort(), DEFAULT_TEST_PORT);
  assert.equal(new URL(DEFAULT_TEST_BASE_URL).hostname, "127.0.0.1");
  assert.equal(new URL(DEFAULT_TEST_BASE_URL).port, String(DEFAULT_TEST_PORT));

  process.env.BASE_URL = " https://dashboard.example.test/ ";
  assert.equal(resolveTestBaseUrl(), "https://dashboard.example.test");
  assert.equal(resolveTestBaseUrl("SIDEBAR_TEST_BASE_URL"), "https://dashboard.example.test");
  process.env.SIDEBAR_TEST_BASE_URL = "https://sidebar.example.test";
  assert.equal(resolveTestBaseUrl("SIDEBAR_TEST_BASE_URL"), "https://sidebar.example.test");

  for (const value of ["not-a-url", "file:///tmp/report", "https://user:secret@example.test", "https://example.test/path", "https://example.test/?query=1", "https://example.test/#section"]) {
    process.env.BASE_URL = value;
    assert.throws(() => resolveTestBaseUrl(), Error, "Invalid test origin must be rejected: " + value);
  }
  for (const value of ["1", "41911", "65535"]) {
    process.env.TEST_PORT = value;
    assert.equal(resolveTestPort(), Number(value));
  }
  for (const value of ["0", "65536", "1.5", "NaN"]) {
    process.env.TEST_PORT = value;
    assert.throws(() => resolveTestPort(), Error, "Invalid test port must be rejected: " + value);
  }
} finally {
  for (const [name, value] of originalEnvironment) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

// A typo or an incomplete selection must never silently launch the full suite.
assert.equal(parseTestOptions([]).help, true);
assert.equal(parseTestOptions(["--verbose"]).help, true);
assert.equal(parseTestOptions(["--list"]).list, true);
for (const args of [["--test"], ["--suite"], ["--test", "--list"], ["--tests", "x"], ["extra"], ["--suite", "ci", "--suite", "browser"]]) {
  assert.throws(() => parseTestOptions(args));
}
const firstTest = FRONTEND_TEST_SUITES.ci[0];
const lastTest = FRONTEND_TEST_SUITES.ci.at(-1);
const selectedOptions = parseTestOptions(["--test", lastTest.file, "--test", firstTest.file, "--test", lastTest.file]);
assert.deepEqual(selectFrontendTests(FRONTEND_TEST_SUITES, "ci", selectedOptions.tests), [firstTest, lastTest]);
assert.deepEqual(selectFrontendTests(FRONTEND_TEST_SUITES, "ci"), FRONTEND_TEST_SUITES.ci);
assert.throws(() => selectFrontendTests(FRONTEND_TEST_SUITES, "__proto__"));
assert.throws(() => selectFrontendTests(FRONTEND_TEST_SUITES, "ci", [firstTest.file, "missing.mjs"]));
assert.throws(() => selectFrontendTests({ duplicate: [firstTest, { ...firstTest }] }, "duplicate", [firstTest.file]));
const labeledTest = FRONTEND_TEST_SUITES.browser.find((test) => test.label);
assert.deepEqual(selectFrontendTests(FRONTEND_TEST_SUITES, "browser", [labeledTest.label]), [labeledTest]);

const execute = promisify(execFile);
const runnerPath = path.join(scriptDirectory, "run-frontend-tests.mjs");
const cliOptions = {
  cwd: path.resolve(scriptDirectory, ".."),
  env: { ...process.env, TEST_PORT: "invalid", TEST_TIMEOUT_MS: "invalid", TEST_BACKEND_URL: "" },
  timeout: 10_000,
  windowsHide: true
};
const listed = await execute(process.execPath, [runnerPath, "--list"], cliOptions);
assert.deepEqual(JSON.parse(listed.stdout), FRONTEND_TEST_SUITES);
const backendListing = await execute(process.execPath, [runnerPath, "--suite", "backend", "--list"], cliOptions);
assert.deepEqual(JSON.parse(backendListing.stdout).backend, FRONTEND_TEST_SUITES.backend);
const help = await execute(process.execPath, [runnerPath, "--help"], cliOptions);
assert.match(help.stdout, /Usage:/);
await assert.rejects(execute(process.execPath, [runnerPath, "--test"], cliOptions), (error) => {
  assert.equal(error.code, 1);
  assert.match(error.stderr, /--test requires a value/);
  return true;
});

// Exercise real child processes, output capture, cancellation and time limits.
const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "frontend-harness-"));
let fixtureIndex = 0;
let descendantPid = null;
const processResults = [];
async function runFixture(source, options = {}) {
  const scriptPath = path.join(temporaryDirectory, `${fixtureIndex++}.mjs`);
  const logPath = scriptPath + ".log";
  await writeFile(scriptPath, source);
  const result = await runTestProcess(scriptPath, {
    cwd: temporaryDirectory, env: process.env, timeoutMs: 5_000, logPath, ...options
  });
  processResults.push(result.status);
  return { ...result, output: await readFile(logPath, "utf8") };
}
try {
  const success = await runFixture('console.log("stdout evidence"); console.error("stderr evidence");');
  assert.equal(success.status, "passed");
  assert.match(success.output, /stdout evidence/);
  assert.match(success.output, /stderr evidence/);
  const failure = await runFixture('console.error("expected failure"); process.exitCode = 7;');
  assert.equal(failure.status, "failed");
  assert.equal(failure.code, 7);
  assert.match(failure.output, /expected failure/);
  const spawnFailure = await runFixture('console.log("must not run");', {
    cwd: path.join(temporaryDirectory, "missing-working-directory")
  });
  assert.equal(spawnFailure.status, "error");
  assert.match(spawnFailure.error, /ENOENT/);

  const heartbeat = path.join(temporaryDirectory, "heartbeat.txt");
  const descendantSource = `const fs=require('node:fs'); const tick=()=>fs.writeFileSync(${JSON.stringify(heartbeat)}, String(Date.now())); tick(); setInterval(tick, 30);`;
  const timedOut = await runFixture(`
    import { spawn } from 'node:child_process';
    const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendantSource)}], { stdio: 'ignore', windowsHide: true });
    console.log(child.pid);
    setInterval(() => {}, 1000);
  `, { timeoutMs: 2_000 });
  descendantPid = Number(timedOut.output.trim());
  assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 0);
  assert.equal(timedOut.status, "timed_out");
  const lastHeartbeat = await readFile(heartbeat, "utf8");
  await new Promise((resolve) => setTimeout(resolve, 180));
  assert.equal(await readFile(heartbeat, "utf8"), lastHeartbeat, "Timeout must stop the test's descendant process");
  if (process.platform === "win32") {
    assert.throws(() => process.kill(descendantPid, 0), { code: "ESRCH" });
  }
  descendantPid = null;

  const abort = new AbortController();
  const interruptTimer = setTimeout(() => abort.abort(), 200);
  try {
    const interrupted = await runFixture('setInterval(() => {}, 1000);', { signal: abort.signal });
    assert.equal(interrupted.status, "interrupted");
  } finally {
    clearTimeout(interruptTimer);
  }
  const preAborted = await runFixture('console.log("must not run");', { signal: AbortSignal.abort() });
  assert.equal(preAborted.status, "interrupted");
  assert.equal(preAborted.output, "");
} finally {
  if (descendantPid !== null) {
    try { process.kill(descendantPid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
  }
  const cleanupPath = path.resolve(temporaryDirectory);
  assert.equal(path.dirname(cleanupPath), path.resolve(tmpdir()));
  assert.ok(path.basename(cleanupPath).startsWith("frontend-harness-"));
  await rm(cleanupPath, { recursive: true, force: true });
}

console.log(JSON.stringify({
  result: "PASS",
  ciTestCount: FRONTEND_TEST_SUITES.ci.length,
  activeTestCount: activeTestFiles.size,
  canonicalBaseUrl: DEFAULT_TEST_BASE_URL,
  harnessProcessResults: processResults,
  backendTestsExcludedFromCi: FRONTEND_TEST_SUITES.backend.map((test) => test.file)
}));

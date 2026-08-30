import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { FRONTEND_TEST_MIGRATIONS, FRONTEND_TEST_SUITES } from "./frontend-test-suites.mjs";
import { DEFAULT_TEST_BASE_URL } from "./frontend-test-runtime.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const dashboardDirectory = path.resolve(scriptDirectory, "..");
const packageJson = JSON.parse(await readFile(path.join(dashboardDirectory, "package.json"), "utf8"));

assert.equal(packageJson.scripts.test, "node scripts/run-frontend-tests.mjs --suite ci");
assert.equal(packageJson.scripts["test:ci"], "npm test");
assert.equal(packageJson.scripts.pretest, "npm run test:bundle && npm run test:unit");
assert.equal(packageJson.scripts["test:unit"], "vitest run");
assert.equal(
  packageJson.scripts["test:bundle"],
  "npm run analyze:bundle && node scripts/verify-bundle-boundaries.mjs"
);
assert.equal(packageJson.scripts["test:legacy"], undefined);
assert.equal(
  packageJson.scripts["test:recovery"],
  "node scripts/run-frontend-tests.mjs --suite recovery"
);
assert.equal(packageJson.scripts["verify:bundle-boundaries"], "npm run test:bundle");
for (const [scriptName, command] of Object.entries(packageJson.scripts)) {
  if (!scriptName.startsWith("verify:") || scriptName === "verify:bundle-boundaries") {
    continue;
  }
  assert.match(
    command,
    /^node scripts\/run-frontend-tests\.mjs --suite \S+ --test \S+$/,
    `${scriptName} must use the managed frontend test runner`
  );
}
assert.equal(new URL(DEFAULT_TEST_BASE_URL).hostname, "127.0.0.1");
assert.equal(new URL(DEFAULT_TEST_BASE_URL).port, "41901");

const ciFiles = new Set(FRONTEND_TEST_SUITES.ci.map((test) => test.file));
const recoveryFiles = new Set(FRONTEND_TEST_SUITES.recovery.map((test) => test.file));
assert.deepEqual(
  [...recoveryFiles],
  ["verify-quick-rescan-recovery-guards.mjs"],
  "the managed recovery suite must preserve the valid Quick Analyze recovery guards"
);
assert.equal(
  ciFiles.has("verify-quick-rescan-recovery-guards.mjs"),
  true,
  "Quick Analyze duplicate-POST recovery must remain in the CI suite"
);
assert.equal(
  ciFiles.has("verify-route-resilience-accessibility.mjs"),
  true,
  "route loading, error-boundary, title, and modal accessibility must remain in CI"
);
assert.equal(
  ciFiles.has("verify-dashboard-request-budget.mjs"),
  true,
  "the dashboard request-budget regression must remain in the CI suite"
);
assert.equal(
  ciFiles.has("verify-api-response-validation.mjs"),
  true,
  "malformed successful API responses must remain covered by the CI suite"
);
assert.equal(
  ciFiles.has("verify-dashboard-boot-accessibility.mjs"),
  true,
  "keyboard access behind the dashboard boot overlay must remain covered by the CI suite"
);
assert.equal(
  ciFiles.has("verify-dashboard-mutation-refresh.mjs"),
  true,
  "overview timeout, replacement, and retry must remain covered by the CI suite"
);
assert.equal(
  ciFiles.has("verify-site-create-request-retry.mjs"),
  true,
  "inactive-target creation recovery must remain covered by the CI suite"
);
for (const test of FRONTEND_TEST_SUITES.ci) {
  assert.equal(test.needsBackend, undefined, `${test.file} must not require a backend in the CI suite`);
  assert.equal(test.crossStack, undefined, `${test.file} must not read backend source in the CI suite`);
  if (test.needsVite) {
    const source = await readFile(path.join(scriptDirectory, test.file), "utf8");
    assert.match(
      source,
      /page\.route\(|installDashboardApiFixture\(/,
      `${test.file} must install an isolated API fixture in the CI suite`
    );
  }
}
for (const test of FRONTEND_TEST_SUITES.backend) {
  assert.equal(ciFiles.has(test.file), false, `${test.file} must stay out of the isolated CI suite`);
}

const scriptNames = await readdir(scriptDirectory);
const browserScripts = scriptNames.filter((name) => /^(?:verify|record)-.*\.mjs$/.test(name));
const literalServerPattern = /https?:\/\/(?:127\.0\.0\.1|localhost):\d+/;

for (const scriptName of browserScripts) {
  const source = await readFile(path.join(scriptDirectory, scriptName), "utf8");
  assert.doesNotMatch(source, literalServerPattern, `${scriptName} must use the shared test base URL`);
  if (/const baseUrl\s*=/.test(source)) {
    assert.match(source, /resolveTestBaseUrl\(/, `${scriptName} must resolve its URL through the shared runtime`);
  }
}

const configuredTestFiles = Object.values(FRONTEND_TEST_SUITES).flat().map((test) => test.file);
for (const file of configuredTestFiles) {
  assert.equal(browserScripts.includes(file), true, `Unknown test file in suite manifest: ${file}`);
}

const activeTestFiles = new Set(configuredTestFiles);
const migrationFiles = new Set();
for (const migration of FRONTEND_TEST_MIGRATIONS) {
  assert.equal(migrationFiles.has(migration.file), false, `Duplicate migration entry: ${migration.file}`);
  migrationFiles.add(migration.file);
  assert.equal(activeTestFiles.has(migration.file), false, `${migration.file} cannot be active and migrated`);
  assert.ok(migration.replacements.length > 0, `${migration.file} must name its current replacement coverage`);
  for (const replacement of migration.replacements) {
    assert.equal(activeTestFiles.has(replacement), true, `Unknown replacement ${replacement} for ${migration.file}`);
  }
  if (migration.status === "pending-migration") {
    assert.equal(browserScripts.includes(migration.file), true, `Pending migration file is missing: ${migration.file}`);
  } else {
    assert.equal(migration.status, "retired", `Unknown migration status for ${migration.file}`);
    assert.equal(browserScripts.includes(migration.file), false, `Retired test file must be deleted: ${migration.file}`);
  }
}

const classifiedVerifyFiles = new Set([
  ...activeTestFiles,
  ...migrationFiles,
  "verify-bundle-boundaries.mjs"
]);
for (const scriptName of browserScripts.filter((name) => name.startsWith("verify-"))) {
  assert.equal(classifiedVerifyFiles.has(scriptName), true, `Unclassified verification script: ${scriptName}`);
}

console.log(
  JSON.stringify({
    result: "PASS",
    ciTestCount: FRONTEND_TEST_SUITES.ci.length,
    canonicalBaseUrl: DEFAULT_TEST_BASE_URL,
    backendTestsExcludedFromCi: FRONTEND_TEST_SUITES.backend.map((test) => test.file),
    pendingMigrations: FRONTEND_TEST_MIGRATIONS.filter(
      (migration) => migration.status === "pending-migration"
    ).map((migration) => migration.file),
    retiredTests: FRONTEND_TEST_MIGRATIONS.filter(
      (migration) => migration.status === "retired"
    ).map((migration) => migration.file)
  })
);

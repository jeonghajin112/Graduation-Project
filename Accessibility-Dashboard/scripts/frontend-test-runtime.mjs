export const TEST_HOST = "127.0.0.1";
export const DEFAULT_TEST_PORT = 41_901;
export const DEFAULT_TEST_BASE_URL = `http://${TEST_HOST}:${DEFAULT_TEST_PORT}`;

export function parseTestOptions(args) {
  const options = { suite: null, tests: [], list: false, help: false, verbose: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (["--list", "--help", "--verbose"].includes(argument)) {
      options[argument.slice(2)] = true;
      continue;
    }
    if (argument !== "--suite" && argument !== "--test") {
      throw new Error(`Unknown option "${argument}". Use --help to see supported options.`);
    }
    const value = args[++index];
    if (!value?.trim() || value.startsWith("--")) {
      throw new Error(`${argument} requires a value.`);
    }
    if (argument === "--suite") {
      if (options.suite !== null) throw new Error("--suite may only be specified once.");
      options.suite = value;
    } else {
      options.tests.push(value);
    }
  }
  if (!options.suite && options.tests.length === 0 && !options.list) options.help = true;
  return options;
}

export function selectFrontendTests(suites, suiteName, requestedTests = []) {
  if (!Object.hasOwn(suites, suiteName)) {
    throw new Error(`Unknown test suite "${suiteName}". Available suites: ${Object.keys(suites).join(", ")}`);
  }
  const configuredSuite = suites[suiteName];
  if (requestedTests.length === 0) return [...configuredSuite];

  const selected = new Set();
  for (const requested of requestedTests) {
    const matches = configuredSuite.filter((test) => test.file === requested || test.label === requested);
    if (matches.length !== 1) {
      throw new Error(`Test "${requested}" must identify exactly one entry in suite "${suiteName}"; received ${matches.length}.`);
    }
    selected.add(matches[0]);
  }
  return configuredSuite.filter((test) => selected.has(test));
}

export function resolveTestBaseUrl(environmentVariable = "BASE_URL") {
  const configuredValue =
    process.env[environmentVariable]?.trim() ||
    (environmentVariable === "BASE_URL" ? "" : process.env.BASE_URL?.trim()) ||
    DEFAULT_TEST_BASE_URL;

  let url;
  try {
    url = new URL(configuredValue);
  } catch {
    throw new Error(`${environmentVariable} must be an absolute HTTP(S) URL: ${configuredValue}`);
  }

  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error(`${environmentVariable} must be an HTTP(S) origin without credentials: ${configuredValue}`);
  }

  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`${environmentVariable} must contain only an origin: ${configuredValue}`);
  }

  return url.origin;
}

export function resolveTestPort() {
  const rawPort = process.env.TEST_PORT?.trim();
  if (!rawPort) {
    return DEFAULT_TEST_PORT;
  }

  const port = Number(rawPort);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`TEST_PORT must be an integer between 1 and 65535: ${rawPort}`);
  }

  return port;
}

export const TEST_HOST = "127.0.0.1";
export const DEFAULT_TEST_PORT = 41_901;
export const DEFAULT_TEST_BASE_URL = `http://${TEST_HOST}:${DEFAULT_TEST_PORT}`;

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

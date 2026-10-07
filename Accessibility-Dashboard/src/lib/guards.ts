/** Runtime checks shared by the viewer protocol parsers and the recovery stores. */

/** Any non-null object, arrays included. Field checks that follow reject the wrong shape. */
export function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

/** A non-null object that is not an array: the shape of a JSON message or response body. */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return isObjectRecord(value) && !Array.isArray(value);
}

/** True when `value` has exactly these own keys, no more and no fewer. */
export function hasExactOwnKeys(value: Record<string, unknown>, expectedKeys: readonly string[]): boolean {
  const ownKeys = Reflect.ownKeys(value);
  return (
    ownKeys.length === expectedKeys.length &&
    expectedKeys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

export function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

const DOCUMENT_TOKEN_MAX_LENGTH = 128;

/** A viewer document token: 1 to 128 URL-safe characters. */
export function isDocumentToken(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= DOCUMENT_TOKEN_MAX_LENGTH &&
    /^[A-Za-z0-9_-]+$/.test(value)
  );
}

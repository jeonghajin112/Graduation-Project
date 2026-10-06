export function extractBridgeNumber(source, constantName) {
  const escapedName = constantName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp(`\\bconst\\s+${escapedName}\\s*=\\s*(-?\\d+(?:\\.\\d+)?)\\s*;`));
  if (!match) {
    throw new Error(`Replay bridge constant ${constantName} must exist`);
  }
  const value = Number(match[1]);
  if (!Number.isFinite(value)) {
    throw new Error(`Replay bridge constant ${constantName} must be numeric`);
  }
  return value;
}

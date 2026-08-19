const rawApiBaseUrl = import.meta.env.VITE_API_BASE_URL?.trim() ?? "";

function stripTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

export const API_BASE_URL = rawApiBaseUrl.length > 0 ? stripTrailingSlash(rawApiBaseUrl) : "/api";

export function buildApiUrl(path: string): string {
  return path.startsWith("/") ? `${API_BASE_URL}${path}` : `${API_BASE_URL}/${path}`;
}

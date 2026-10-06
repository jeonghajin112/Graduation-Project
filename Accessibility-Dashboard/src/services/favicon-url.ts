import { buildApiUrl } from "@/config/api";

// Only serve backend-verified bytes. Legacy remote URLs await explicit metadata refresh.
export function getVerifiedFaviconUrl(value?: string | null): string | null {
  return value && /^\/api\/favicons\/[a-f0-9]{64}\.(png|svg)$/.test(value)
    ? buildApiUrl(value.slice("/api".length))
    : null;
}

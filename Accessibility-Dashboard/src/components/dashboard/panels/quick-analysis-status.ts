import type { RequestStatus } from "@/types/accessibility-domain";

const REQUEST_STATUSES: readonly RequestStatus[] = ["PENDING", "IN_PROGRESS", "COMPLETED", "FAILED"];

/**
 * Persisted quick-analysis checkpoints store the last seen status as free
 * text. Only forward known request statuses; anything else (legacy or
 * corrupted storage) is treated as still pending so polling can correct it.
 */
export function toRequestStatus(value: string | null | undefined): RequestStatus {
  return REQUEST_STATUSES.find((status) => status === value) ?? "PENDING";
}

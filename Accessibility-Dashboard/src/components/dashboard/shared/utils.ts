type ScanStatus = "완료" | "진행중" | "실패";

export function mapScanStatus(status: string): ScanStatus {
  const normalizedStatus = status.trim().toLowerCase();

  if (normalizedStatus === "finished" || normalizedStatus === "completed" || normalizedStatus === "success") {
    return "완료";
  }
  if (normalizedStatus === "failed" || normalizedStatus === "error" || normalizedStatus === "cancelled") {
    return "실패";
  }
  return "진행중";
}

/**
 * A 0–100 score as every dashboard view prints it: rounded to one decimal,
 * whole numbers without ".0" (86.25 → "86.3", 99.96 → "100", 75 → "75").
 */
export function formatScore(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

export function formatDateTime(value: string | null): string {
  if (!value) {
    return "-";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");

  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

import type { ScanStatus } from "./constants";

export function buildMetricSparklinePoints(series: number[]): string {
  if (series.length === 0) {
    return "";
  }

  const width = 64;
  const height = 28;
  const padding = 2;
  const min = Math.min(...series);
  const max = Math.max(...series);
  const range = max - min;
  const denominator = Math.max(series.length - 1, 1);

  return series
    .map((value, index) => {
      const x = (width / denominator) * index;
      const normalized = range === 0 ? 0.5 : (value - min) / range;
      const y = height - padding - normalized * (height - padding * 2);
      return `${x},${y}`;
    })
    .join(" ");
}

export function buildCumulativeCountSeries(dateStrings: string[], months: number): number[] {
  const monthKeys = buildRecentMonthKeys(months);
  const countsByMonth = new Map<string, number>();

  for (const value of dateStrings) {
    const monthKey = toMonthKey(value);
    countsByMonth.set(monthKey, (countsByMonth.get(monthKey) ?? 0) + 1);
  }

  let cumulative = 0;
  return monthKeys.map((monthKey) => {
    cumulative += countsByMonth.get(monthKey) ?? 0;
    return cumulative;
  });
}

export function buildRecentMonthKeys(months: number): string[] {
  const current = new Date();
  current.setDate(1);
  const result: string[] = [];

  for (let offset = months - 1; offset >= 0; offset -= 1) {
    const date = new Date(current.getFullYear(), current.getMonth() - offset, 1);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
    result.push(key);
  }

  return result;
}

export function toMonthKey(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value.slice(0, 7);
  }
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

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

export function formatDateOnly(value: string | null): string {
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
  return `${year}-${month}-${day}`;
}

export function formatMonthShortLabel(value: string): string {
  const [year, month] = value.split("-");
  if (!year || !month) {
    return value;
  }
  return `${year.slice(-2)}.${Number(month)}`;
}

export function buildLinePoints(series: number[]): string {
  if (series.length === 0) {
    return "";
  }

  const maxX = 620;
  const maxY = 190;
  const denominator = Math.max(series.length - 1, 1);

  return series
    .map((value, index) => {
      const x = (maxX / denominator) * index;
      const clamped = Math.min(Math.max(value, 0), 100);
      const y = maxY - clamped * 1.7;
      return `${x},${y}`;
    })
    .join(" ");
}

export function buildSmoothLinePath(points: { x: number; y: number }[]): string {
  if (points.length === 0) {
    return "";
  }

  if (points.length === 1) {
    return `M ${points[0]!.x},${points[0]!.y}`;
  }

  let path = `M ${points[0]!.x},${points[0]!.y}`;

  for (let index = 0; index < points.length - 1; index += 1) {
    const previous = points[index - 1] ?? points[index]!;
    const current = points[index]!;
    const next = points[index + 1]!;
    const afterNext = points[index + 2] ?? next;

    const cp1x = current.x + (next.x - previous.x) / 6;
    const cp1y = current.y + (next.y - previous.y) / 6;
    const cp2x = next.x - (afterNext.x - current.x) / 6;
    const cp2y = next.y - (afterNext.y - current.y) / 6;

    path += ` C ${cp1x},${cp1y} ${cp2x},${cp2y} ${next.x},${next.y}`;
  }

  return path;
}

export function buildSmoothAreaPath(points: { x: number; y: number }[], baseY: number): string {
  if (points.length === 0) {
    return "";
  }

  const first = points[0]!;
  const last = points[points.length - 1]!;
  const linePath = buildSmoothLinePath(points);
  return `${linePath} L ${last.x},${baseY} L ${first.x},${baseY} Z`;
}

export function polarToCartesian(centerX: number, centerY: number, radius: number, angleDegrees: number) {
  const angleRadians = (Math.PI / 180) * angleDegrees;
  return {
    x: centerX + radius * Math.cos(angleRadians),
    y: centerY + radius * Math.sin(angleRadians)
  };
}

export function buildClosedPolygonPath(points: { x: number; y: number }[]): string {
  if (points.length === 0) {
    return "";
  }

  const [first, ...rest] = points;
  const segments = rest.map((point) => `L ${point.x},${point.y}`).join(" ");
  return `M ${first.x},${first.y}${segments ? ` ${segments}` : ""} Z`;
}

export function buildTrendChartPoints(
  series: number[],
  labels: string[],
  options: {
    width: number;
    height: number;
    paddingLeft?: number;
    paddingRight?: number;
    paddingX?: number;
    centerY: number;
    amplitude: number;
    topY?: number;
    bottomY?: number;
    domainMin?: number;
    domainMax?: number;
  }
): { month: string; score: number; x: number; y: number }[] {
  if (series.length === 0) {
    return [];
  }

  const { width, paddingLeft, paddingRight, paddingX, centerY, amplitude, topY, bottomY, domainMin, domainMax } = options;
  const leftPadding = paddingLeft ?? paddingX ?? 0;
  const rightPadding = paddingRight ?? paddingX ?? 0;
  const usableWidth = width - leftPadding - rightPadding;
  const denominator = Math.max(series.length - 1, 1);
  const hasFixedDomain =
    typeof topY === "number" &&
    typeof bottomY === "number" &&
    typeof domainMin === "number" &&
    typeof domainMax === "number" &&
    domainMax > domainMin;
  const min = Math.min(...series);
  const max = Math.max(...series);
  const range = Math.max(max - min, 1);
  const midpoint = (min + max) / 2;

  return series.map((value, index) => {
    const x = leftPadding + (usableWidth / denominator) * index;
    const y = hasFixedDomain
      ? (() => {
          const normalized = Math.min(Math.max((value - domainMin) / (domainMax - domainMin), 0), 1);
          return bottomY - normalized * (bottomY - topY);
        })()
      : (() => {
          const normalized = range === 0 ? 0 : (value - midpoint) / (range / 2);
          return centerY - normalized * amplitude;
        })();

    return {
      month: labels[index] ?? "",
      score: value,
      x,
      y
    };
  });
}








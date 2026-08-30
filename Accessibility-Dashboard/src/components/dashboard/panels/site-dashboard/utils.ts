export function getAnalyzerTypeLabel(analyzerType: string | undefined): string {
  if (!analyzerType) {
    return "출처 미확인";
  }

  const normalizedType = analyzerType.toLowerCase();
  if (normalizedType.includes("rule")) {
    return "규칙 기반";
  }
  if (normalizedType.includes("cv") || normalizedType.includes("visual") || normalizedType.includes("vision")) {
    return "시각 분석";
  }
  if (normalizedType.includes("text") || normalizedType.includes("difficulty") || normalizedType.includes("suggestion")) {
    return "AI 분석";
  }
  if (normalizedType.includes("integrated")) {
    return "통합 분석";
  }

  return analyzerType;
}

export function formatShortDate(value: string): string {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value.slice(5, 10).replace("-", ".");
  }

  return `${date.getMonth() + 1}.${date.getDate()}`;
}

export function formatDateKey(value: string): string {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value.slice(0, 10);
  }

  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

export function formatDateLabel(value: string): string {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return `${date.getFullYear()}년 ${date.getMonth() + 1}월 ${date.getDate()}일`;
}

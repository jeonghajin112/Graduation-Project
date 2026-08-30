import type {
  DashboardIssueGroup,
  DashboardLatestIssueCount,
  DashboardOverviewApiResponse,
  EvaluationArtifact,
  EvaluationIssue,
  EvaluationIssueSeverity,
  EvaluationRequestModel,
  EvaluationResultSummary,
  EvaluationTarget,
  IssueLocator,
  IssueLocatorPathStep,
  Organization,
  RequestStatus,
  ScoreResult,
  SeverityLevel
} from "@/types/accessibility-domain";

export type ApiResponseParser<T> = (value: unknown, path: string) => T;

export class ApiContractValidationError extends Error {
  readonly fieldPath: string;
  readonly expected: string;
  readonly actualType: string;

  constructor({
    fieldPath,
    expected,
    actualType
  }: {
    fieldPath: string;
    expected: string;
    actualType: string;
  }) {
    super(`${fieldPath}: ${expected} 형식이어야 하지만 ${actualType} 값이 반환되었습니다.`);
    this.name = "ApiContractValidationError";
    this.fieldPath = fieldPath;
    this.expected = expected;
    this.actualType = actualType;
  }
}

function describeValueType(value: unknown): string {
  if (value === undefined) {
    return "누락된";
  }
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "배열";
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    return "유한하지 않은 숫자";
  }
  return typeof value;
}

function failContract(value: unknown, path: string, expected: string): never {
  throw new ApiContractValidationError({
    fieldPath: path,
    expected,
    actualType: describeValueType(value)
  });
}

function parseRecord(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return failContract(value, path, "객체");
  }
  return value as Record<string, unknown>;
}

function readRequired(record: Record<string, unknown>, key: string, path: string): unknown {
  if (!Object.prototype.hasOwnProperty.call(record, key)) {
    return failContract(undefined, `${path}.${key}`, "필수 필드");
  }
  return record[key];
}

function parseString(value: unknown, path: string): string {
  if (typeof value !== "string") {
    return failContract(value, path, "문자열");
  }
  return value;
}

function parseNonBlankString(value: unknown, path: string, maxLength?: number): string {
  const parsed = parseString(value, path);
  if (parsed.trim().length === 0 || (maxLength !== undefined && parsed.length > maxLength)) {
    return failContract(
      value,
      path,
      maxLength === undefined
        ? "공백이 아닌 문자열"
        : `공백이 아니며 ${maxLength}자 이하인 문자열`
    );
  }
  return parsed;
}

function parseBoundedStringWithFallback(
  value: unknown,
  path: string,
  maxLength: number,
  fallback: string
): string {
  const parsed = parseString(value, path);
  if (parsed.length > maxLength) {
    return failContract(value, path, `${maxLength}자 이하인 문자열`);
  }
  return parsed.trim().length === 0 ? fallback : parsed;
}

function parseNullableString(value: unknown, path: string): string | null {
  return value === null ? null : parseString(value, path);
}

function parseAbsoluteHttpUrl(value: unknown, path: string, maxLength = 2_048): string {
  const parsed = parseNonBlankString(value, path, maxLength);
  if (parsed !== parsed.trim()) {
    return failContract(
      value,
      path,
      `앞뒤 공백이 없는 ${maxLength}자 이하의 absolute HTTP(S) URL`
    );
  }
  try {
    const url = new URL(parsed);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      !url.hostname ||
      url.username.length > 0 ||
      url.password.length > 0
    ) {
      return failContract(value, path, "absolute HTTP(S) URL");
    }
  } catch {
    return failContract(value, path, "absolute HTTP(S) URL");
  }
  return parsed;
}

function parseLegacyOptionalAbsoluteHttpUrl(
  value: unknown,
  path: string,
  maxLength: number
): string {
  const parsed = parseString(value, path);
  if (parsed.trim().length === 0 || parsed.length > maxLength) {
    return "";
  }
  try {
    const url = new URL(parsed);
    if (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.hostname.length > 0 &&
      url.username.length === 0 &&
      url.password.length === 0
    ) {
      return parsed;
    }
  } catch {
    // Legacy/imported invalid URLs are quarantined instead of becoming links.
  }
  return "";
}

function parseOptionalNullableString(
  record: Record<string, unknown>,
  key: string,
  path: string
): string | null | undefined {
  if (!Object.prototype.hasOwnProperty.call(record, key)) {
    return undefined;
  }
  return parseNullableString(record[key], `${path}.${key}`);
}

function parseOptionalNullableNonBlankString(
  record: Record<string, unknown>,
  key: string,
  path: string,
  maxLength?: number
): string | null | undefined {
  if (!Object.prototype.hasOwnProperty.call(record, key)) {
    return undefined;
  }
  return record[key] === null
    ? null
    : parseNonBlankString(record[key], `${path}.${key}`, maxLength);
}

function parseBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    return failContract(value, path, "불리언");
  }
  return value;
}

function parseFiniteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return failContract(value, path, "유한한 숫자");
  }
  return value;
}

function parseScore(value: unknown, path: string): number {
  const parsed = parseFiniteNumber(value, path);
  if (parsed < 0 || parsed > 100) {
    return failContract(value, path, "0 이상 100 이하의 점수");
  }
  return parsed;
}

function parsePositiveFiniteNumber(value: unknown, path: string): number {
  const parsed = parseFiniteNumber(value, path);
  if (parsed <= 0) {
    return failContract(value, path, "0보다 큰 유한한 숫자");
  }
  return parsed;
}

function parseNullableFiniteNumber(value: unknown, path: string): number | null {
  return value === null ? null : parseFiniteNumber(value, path);
}

function parsePositiveInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    return failContract(value, path, "양의 정수");
  }
  return value as number;
}

function parseNonNegativeInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    return failContract(value, path, "0 이상의 정수");
  }
  return value as number;
}

function parseDateTime(value: unknown, path: string): string {
  const parsed = parseString(value, path);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))?$/.exec(
    parsed
  );
  if (!match) {
    return failContract(value, path, "ISO 8601 날짜·시간 문자열");
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[8] === undefined ? 0 : Number(match[8]);
  const offsetMinute = match[9] === undefined ? 0 : Number(match[9]);
  const isLeapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, isLeapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const isValidCalendarValue =
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= (daysInMonth[month - 1] ?? 0) &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    offsetHour <= 18 &&
    offsetMinute <= 59 &&
    (offsetHour < 18 || offsetMinute === 0);
  if (!isValidCalendarValue) {
    return failContract(value, path, "실제 달력에 존재하는 ISO 8601 날짜·시간 문자열");
  }
  return parsed;
}

function parseEnumValue<const Values extends readonly string[]>(
  value: unknown,
  path: string,
  values: Values
): Values[number] {
  if (typeof value !== "string" || !values.includes(value)) {
    return failContract(value, path, values.map((candidate) => `\"${candidate}\"`).join(" | "));
  }
  return value as Values[number];
}

function parseArray<T>(value: unknown, path: string, itemParser: ApiResponseParser<T>): T[] {
  if (!Array.isArray(value)) {
    return failContract(value, path, "배열");
  }
  return value.map((item, index) => itemParser(item, `${path}[${index}]`));
}

function assertExpectedIdentifier(
  actual: number,
  expected: number | undefined,
  path: string,
  label: string
): void {
  if (expected !== undefined && actual !== expected) {
    throw new ApiContractValidationError({
      fieldPath: path,
      expected: `${label} ${expected}`,
      actualType: `숫자 ${actual}`
    });
  }
}

function assertExpectedString(
  actual: string,
  expected: string | undefined,
  path: string,
  label: string
): void {
  if (expected !== undefined && actual !== expected) {
    throw new ApiContractValidationError({
      fieldPath: path,
      expected: `${label} \"${expected}\"`,
      actualType: `문자열 \"${actual}\"`
    });
  }
}

const organizationTypes = ["GOVERNMENT", "PUBLIC_AGENCY", "UNIVERSITY", "COMPANY", "ETC"] as const;
const organizationStatuses = ["ACTIVE", "INACTIVE"] as const;
const targetTypes = ["WEB", "MOBILE_APP", "DOCUMENT", "KIOSK", "ETC"] as const;
const targetStatuses = ["ACTIVE", "INACTIVE", "DELETED"] as const;
const requestStatuses = ["PENDING", "IN_PROGRESS", "COMPLETED", "FAILED"] as const;
const issueModules = ["rule_based", "text_difficulty", "cv_visual"] as const;
const issueSeverities = ["CRITICAL", "SERIOUS", "MODERATE", "MINOR"] as const;
const severityLevels = ["CRITICAL", "HIGH", "MEDIUM", "LOW"] as const;

export const parseOrganizationResponse: ApiResponseParser<Organization> = (value, path) => {
  const record = parseRecord(value, path);
  return {
    id: parsePositiveInteger(readRequired(record, "id", path), `${path}.id`),
    name: parseNonBlankString(readRequired(record, "name", path), `${path}.name`, 100),
    type: parseEnumValue(readRequired(record, "type", path), `${path}.type`, organizationTypes),
    homepageUrl:
      parseNullableString(readRequired(record, "homepageUrl", path), `${path}.homepageUrl`) ?? "",
    description:
      parseNullableString(readRequired(record, "description", path), `${path}.description`) ?? "",
    status: parseEnumValue(
      readRequired(record, "status", path),
      `${path}.status`,
      organizationStatuses
    ),
    createdAt: parseDateTime(readRequired(record, "createdAt", path), `${path}.createdAt`),
    updatedAt: parseDateTime(readRequired(record, "updatedAt", path), `${path}.updatedAt`)
  };
};

export function createOrganizationResponseParser(
  expectedId: number
): ApiResponseParser<Organization> {
  return (value, path) => {
    const organization = parseOrganizationResponse(value, path);
    assertExpectedIdentifier(organization.id, expectedId, `${path}.id`, "조직 ID");
    return organization;
  };
}

function parseEvaluationTarget(
  value: unknown,
  path: string,
  { strictAccessUrl = false }: { strictAccessUrl?: boolean } = {}
): EvaluationTarget {
  const record = parseRecord(value, path);
  return {
    id: parsePositiveInteger(readRequired(record, "id", path), `${path}.id`),
    organizationId: parsePositiveInteger(
      readRequired(record, "organizationId", path),
      `${path}.organizationId`
    ),
    name: parseNonBlankString(readRequired(record, "name", path), `${path}.name`, 100),
    targetType: parseEnumValue(
      readRequired(record, "targetType", path),
      `${path}.targetType`,
      targetTypes
    ),
    accessUrl: strictAccessUrl
      ? parseAbsoluteHttpUrl(readRequired(record, "accessUrl", path), `${path}.accessUrl`, 500)
      : parseLegacyOptionalAbsoluteHttpUrl(
          readRequired(record, "accessUrl", path),
          `${path}.accessUrl`,
          500
        ),
    faviconUrl: parseOptionalNullableString(record, "faviconUrl", path),
    description:
      parseNullableString(readRequired(record, "description", path), `${path}.description`) ?? "",
    status: parseEnumValue(readRequired(record, "status", path), `${path}.status`, targetStatuses),
    createdAt: parseDateTime(readRequired(record, "createdAt", path), `${path}.createdAt`),
    updatedAt: parseDateTime(readRequired(record, "updatedAt", path), `${path}.updatedAt`)
  };
}

export const parseEvaluationTargetResponse: ApiResponseParser<EvaluationTarget> = (value, path) =>
  parseEvaluationTarget(value, path);

export function createEvaluationTargetResponseParser({
  expectedId,
  expectedOrganizationId,
  expectedName,
  expectedAccessUrl,
  expectedTargetType,
  expectedStatus,
  strictAccessUrl = false
}: {
  expectedId?: number;
  expectedOrganizationId?: number;
  expectedName?: string;
  expectedAccessUrl?: string;
  expectedTargetType?: string;
  expectedStatus?: string;
  strictAccessUrl?: boolean;
}): ApiResponseParser<EvaluationTarget> {
  return (value, path) => {
    const target = parseEvaluationTarget(value, path, { strictAccessUrl });
    assertExpectedIdentifier(target.id, expectedId, `${path}.id`, "평가 대상 ID");
    assertExpectedIdentifier(
      target.organizationId,
      expectedOrganizationId,
      `${path}.organizationId`,
      "조직 ID"
    );
    assertExpectedString(target.name, expectedName, `${path}.name`, "페이지 이름");
    assertExpectedString(target.accessUrl, expectedAccessUrl, `${path}.accessUrl`, "페이지 URL");
    assertExpectedString(
      target.targetType,
      expectedTargetType,
      `${path}.targetType`,
      "평가 대상 유형"
    );
    assertExpectedString(target.status, expectedStatus, `${path}.status`, "평가 대상 상태");
    return target;
  };
}

export function createEvaluationTargetsResponseParser(
  expectedOrganizationId: number
): ApiResponseParser<EvaluationTarget[]> {
  return (value, path) => {
    const targets = parseArray(
      value,
      path,
      createEvaluationTargetResponseParser({ expectedOrganizationId })
    );
    const ids = new Set<number>();
    targets.forEach((target, index) => {
      if (ids.has(target.id)) {
        throw new ApiContractValidationError({
          fieldPath: `${path}[${index}].id`,
          expected: "중복되지 않는 평가 대상 ID",
          actualType: `중복 ID ${target.id}`
        });
      }
      ids.add(target.id);
    });
    return targets;
  };
}

export const parseEvaluationRequestResponse: ApiResponseParser<EvaluationRequestModel> = (
  value,
  path
) => {
  const record = parseRecord(value, path);
  const targetName = parseOptionalNullableNonBlankString(record, "targetName", path, 100);
  return {
    id: parsePositiveInteger(readRequired(record, "id", path), `${path}.id`),
    evaluationTargetId: parsePositiveInteger(
      readRequired(record, "evaluationTargetId", path),
      `${path}.evaluationTargetId`
    ),
    targetName: targetName ?? undefined,
    faviconUrl: parseOptionalNullableString(record, "faviconUrl", path),
    status: parseEnumValue(
      readRequired(record, "status", path),
      `${path}.status`,
      requestStatuses
    ) as RequestStatus,
    requestNote:
      parseNullableString(readRequired(record, "requestNote", path), `${path}.requestNote`) ?? "",
    requestedAt: parseDateTime(
      readRequired(record, "requestedAt", path),
      `${path}.requestedAt`
    ),
    createdAt: parseDateTime(readRequired(record, "createdAt", path), `${path}.createdAt`),
    updatedAt: parseDateTime(readRequired(record, "updatedAt", path), `${path}.updatedAt`)
  };
};

export function createEvaluationRequestResponseParser({
  expectedId,
  expectedTargetId
}: {
  expectedId?: number;
  expectedTargetId?: number;
}): ApiResponseParser<EvaluationRequestModel> {
  return (value, path) => {
    const request = parseEvaluationRequestResponse(value, path);
    assertExpectedIdentifier(request.id, expectedId, `${path}.id`, "평가 요청 ID");
    assertExpectedIdentifier(
      request.evaluationTargetId,
      expectedTargetId,
      `${path}.evaluationTargetId`,
      "평가 대상 ID"
    );
    return request;
  };
}

export const parseEvaluationRequestsResponse: ApiResponseParser<EvaluationRequestModel[]> = (
  value,
  path
) => {
  const requests = parseArray(value, path, parseEvaluationRequestResponse);
  const ids = new Set<number>();
  requests.forEach((request, index) => {
    if (ids.has(request.id)) {
      throw new ApiContractValidationError({
        fieldPath: `${path}[${index}].id`,
        expected: "중복되지 않는 평가 요청 ID",
        actualType: `중복 ID ${request.id}`
      });
    }
    ids.add(request.id);
  });
  return requests;
};

const parseEvaluationResultSummary: ApiResponseParser<EvaluationResultSummary> = (value, path) => {
  const record = parseRecord(value, path);
  const totalIssueCount = parseNonNegativeInteger(
    readRequired(record, "totalIssueCount", path),
    `${path}.totalIssueCount`
  );
  const criticalIssueCount = parseNonNegativeInteger(
    readRequired(record, "criticalIssueCount", path),
    `${path}.criticalIssueCount`
  );
  if (criticalIssueCount > totalIssueCount) {
    return failContract(
      criticalIssueCount,
      `${path}.criticalIssueCount`,
      "전체 이슈 수 이하의 정수"
    );
  }
  return {
    requestId: parsePositiveInteger(readRequired(record, "requestId", path), `${path}.requestId`),
    targetName: parseNonBlankString(
      readRequired(record, "targetName", path),
      `${path}.targetName`,
      100
    ),
    status: parseEnumValue(
      readRequired(record, "status", path),
      `${path}.status`,
      requestStatuses
    ) as RequestStatus,
    totalScore: parseScore(readRequired(record, "totalScore", path), `${path}.totalScore`),
    totalIssueCount,
    criticalIssueCount,
    requestedAt: parseDateTime(readRequired(record, "requestedAt", path), `${path}.requestedAt`)
  };
};

const parseScoreResult: ApiResponseParser<ScoreResult> = (value, path) => {
  const record = parseRecord(value, path);
  return {
    id: parsePositiveInteger(readRequired(record, "id", path), `${path}.id`),
    evaluationRequestId: parsePositiveInteger(
      readRequired(record, "evaluationRequestId", path),
      `${path}.evaluationRequestId`
    ),
    totalScore: parseScore(readRequired(record, "totalScore", path), `${path}.totalScore`),
    ruleScore: parseScore(readRequired(record, "ruleScore", path), `${path}.ruleScore`),
    aiScore: parseScore(readRequired(record, "aiScore", path), `${path}.aiScore`),
    cvScore: parseScore(readRequired(record, "cvScore", path), `${path}.cvScore`),
    createdAt: parseDateTime(readRequired(record, "createdAt", path), `${path}.createdAt`),
    updatedAt: parseDateTime(readRequired(record, "updatedAt", path), `${path}.updatedAt`)
  };
};

const parseDashboardIssueGroup: ApiResponseParser<DashboardIssueGroup> = (value, path) => {
  const record = parseRecord(value, path);
  return {
    issueCode: parseBoundedStringWithFallback(
      readRequired(record, "issueCode", path),
      `${path}.issueCode`,
      100,
      "UNKNOWN"
    ),
    issueTitle: parseBoundedStringWithFallback(
      readRequired(record, "issueTitle", path),
      `${path}.issueTitle`,
      200,
      "제목 없는 접근성 이슈"
    ),
    severity: parseEnumValue(
      readRequired(record, "severity", path),
      `${path}.severity`,
      severityLevels
    ) as SeverityLevel,
    count: parseNonNegativeInteger(readRequired(record, "count", path), `${path}.count`)
  };
};

const parseDashboardLatestIssueCount: ApiResponseParser<DashboardLatestIssueCount> = (
  value,
  path
) => {
  const record = parseRecord(value, path);
  const result: DashboardLatestIssueCount = {
    evaluationTargetId: parsePositiveInteger(
      readRequired(record, "evaluationTargetId", path),
      `${path}.evaluationTargetId`
    ),
    requestId: parsePositiveInteger(readRequired(record, "requestId", path), `${path}.requestId`),
    totalIssueCount: parseNonNegativeInteger(
      readRequired(record, "totalIssueCount", path),
      `${path}.totalIssueCount`
    ),
    criticalIssueCount: parseNonNegativeInteger(
      readRequired(record, "criticalIssueCount", path),
      `${path}.criticalIssueCount`
    ),
    highIssueCount: parseNonNegativeInteger(
      readRequired(record, "highIssueCount", path),
      `${path}.highIssueCount`
    ),
    mediumIssueCount: parseNonNegativeInteger(
      readRequired(record, "mediumIssueCount", path),
      `${path}.mediumIssueCount`
    ),
    lowIssueCount: parseNonNegativeInteger(
      readRequired(record, "lowIssueCount", path),
      `${path}.lowIssueCount`
    ),
    groups: parseArray(
      readRequired(record, "groups", path),
      `${path}.groups`,
      parseDashboardIssueGroup
    )
  };
  const groupTotal = result.groups.reduce((sum, group) => sum + group.count, 0);
  const severityTotals = {
    CRITICAL: 0,
    HIGH: 0,
    MEDIUM: 0,
    LOW: 0
  };
  result.groups.forEach((group) => {
    severityTotals[group.severity] += group.count;
  });
  const expectedCounts: Array<[keyof typeof severityTotals, number, string]> = [
    ["CRITICAL", result.criticalIssueCount, "criticalIssueCount"],
    ["HIGH", result.highIssueCount, "highIssueCount"],
    ["MEDIUM", result.mediumIssueCount, "mediumIssueCount"],
    ["LOW", result.lowIssueCount, "lowIssueCount"]
  ];
  if (groupTotal !== result.totalIssueCount) {
    return failContract(
      result.totalIssueCount,
      `${path}.totalIssueCount`,
      `groups 합계 ${groupTotal}과 같은 정수`
    );
  }
  for (const [severity, actualCount, field] of expectedCounts) {
    if (actualCount !== severityTotals[severity]) {
      return failContract(
        actualCount,
        `${path}.${field}`,
        `${severity} groups 합계 ${severityTotals[severity]}과 같은 정수`
      );
    }
  }
  return result;
};

export const parseDashboardOverviewResponse: ApiResponseParser<DashboardOverviewApiResponse> = (
  value,
  path
) => {
  const record = parseRecord(value, path);
  const organizations = parseArray(
    readRequired(record, "organizations", path),
    `${path}.organizations`,
    (organizationValue, organizationPath) => {
      const organizationRecord = parseRecord(organizationValue, organizationPath);
      const organization = parseOrganizationResponse(organizationValue, organizationPath);
      const evaluationTargets = parseArray(
        readRequired(organizationRecord, "evaluationTargets", organizationPath),
        `${organizationPath}.evaluationTargets`,
        createEvaluationTargetResponseParser({ expectedOrganizationId: organization.id })
      );
      return {
        ...organization,
        evaluationTargets
      };
    }
  );
  const evaluationRequests = parseArray(
    readRequired(record, "evaluationRequests", path),
    `${path}.evaluationRequests`,
    parseEvaluationRequestResponse
  );
  const resultSummaries = parseArray(
    readRequired(record, "resultSummaries", path),
    `${path}.resultSummaries`,
    parseEvaluationResultSummary
  );
  const scoreResults = parseArray(
    readRequired(record, "scoreResults", path),
    `${path}.scoreResults`,
    parseScoreResult
  );
  const latestIssueCounts = parseArray(
    readRequired(record, "latestIssueCounts", path),
    `${path}.latestIssueCounts`,
    parseDashboardLatestIssueCount
  );
  const evaluationTargets = organizations.flatMap(
    (organization) => organization.evaluationTargets
  );

  const organizationIds = new Set<number>();
  organizations.forEach((organization, index) => {
    if (organizationIds.has(organization.id)) {
      throw new ApiContractValidationError({
        fieldPath: `${path}.organizations[${index}].id`,
        expected: "중복되지 않는 조직 ID",
        actualType: `중복 ID ${organization.id}`
      });
    }
    organizationIds.add(organization.id);
  });

  const targetsById = new Map<number, EvaluationTarget>();
  evaluationTargets.forEach((target, index) => {
    if (targetsById.has(target.id)) {
      throw new ApiContractValidationError({
        fieldPath: `${path}.organizations[*].evaluationTargets[${index}].id`,
        expected: "중복되지 않는 평가 대상 ID",
        actualType: `중복 ID ${target.id}`
      });
    }
    targetsById.set(target.id, target);
  });

  const requestsById = new Map<number, EvaluationRequestModel>();
  evaluationRequests.forEach((request, index) => {
    if (requestsById.has(request.id)) {
      throw new ApiContractValidationError({
        fieldPath: `${path}.evaluationRequests[${index}].id`,
        expected: "중복되지 않는 평가 요청 ID",
        actualType: `중복 ID ${request.id}`
      });
    }
    if (!targetsById.has(request.evaluationTargetId)) {
      throw new ApiContractValidationError({
        fieldPath: `${path}.evaluationRequests[${index}].evaluationTargetId`,
        expected: "organizations에 포함된 평가 대상 ID",
        actualType: `참조할 수 없는 ID ${request.evaluationTargetId}`
      });
    }
    requestsById.set(request.id, request);
  });

  const summaryRequestIds = new Set<number>();
  resultSummaries.forEach((summary, index) => {
    if (!requestsById.has(summary.requestId) || summaryRequestIds.has(summary.requestId)) {
      throw new ApiContractValidationError({
        fieldPath: `${path}.resultSummaries[${index}].requestId`,
        expected: "존재하며 중복되지 않는 평가 요청 ID",
        actualType: `유효하지 않은 ID ${summary.requestId}`
      });
    }
    summaryRequestIds.add(summary.requestId);
  });

  const scoreRequestIds = new Set<number>();
  scoreResults.forEach((scoreResult, index) => {
    if (
      !requestsById.has(scoreResult.evaluationRequestId) ||
      scoreRequestIds.has(scoreResult.evaluationRequestId)
    ) {
      throw new ApiContractValidationError({
        fieldPath: `${path}.scoreResults[${index}].evaluationRequestId`,
        expected: "존재하며 중복되지 않는 평가 요청 ID",
        actualType: `유효하지 않은 ID ${scoreResult.evaluationRequestId}`
      });
    }
    scoreRequestIds.add(scoreResult.evaluationRequestId);
  });

  const latestTargetIds = new Set<number>();
  latestIssueCounts.forEach((statistics, index) => {
    const referencedRequest = requestsById.get(statistics.requestId);
    if (!targetsById.has(statistics.evaluationTargetId)) {
      throw new ApiContractValidationError({
        fieldPath: `${path}.latestIssueCounts[${index}].evaluationTargetId`,
        expected: "organizations에 포함된 평가 대상 ID",
        actualType: `참조할 수 없는 ID ${statistics.evaluationTargetId}`
      });
    }
    if (
      referencedRequest === undefined ||
      referencedRequest.evaluationTargetId !== statistics.evaluationTargetId
    ) {
      throw new ApiContractValidationError({
        fieldPath: `${path}.latestIssueCounts[${index}].requestId`,
        expected: `평가 대상 ${statistics.evaluationTargetId}에 속한 요청 ID`,
        actualType: `참조할 수 없는 ID ${statistics.requestId}`
      });
    }
    if (latestTargetIds.has(statistics.evaluationTargetId)) {
      throw new ApiContractValidationError({
        fieldPath: `${path}.latestIssueCounts[${index}].evaluationTargetId`,
        expected: "중복되지 않는 최신 이슈 대상 ID",
        actualType: `중복 ID ${statistics.evaluationTargetId}`
      });
    }
    latestTargetIds.add(statistics.evaluationTargetId);
  });

  return {
    organizations,
    evaluationRequests,
    resultSummaries,
    scoreResults,
    latestIssueCounts
  };
};

const parseIssueLocatorPathStep: ApiResponseParser<IssueLocatorPathStep> = (value, path) => {
  const record = parseRecord(value, path);
  return {
    // Stored locator metadata predates the current replay vocabulary and can
    // contain lowercase/custom contexts or null selectors. Preserve that
    // valid wire data; the replay adapter filters unsupported steps safely.
    context:
      parseNullableString(readRequired(record, "context", path), `${path}.context`) ?? "",
    selector:
      parseNullableString(readRequired(record, "selector", path), `${path}.selector`) ?? "",
    frameUrl: parseNullableString(readRequired(record, "frameUrl", path), `${path}.frameUrl`)
  };
};

const parseIssueLocator: ApiResponseParser<IssueLocator> = (value, path) => {
  const record = parseRecord(value, path);
  const visibleValue = readRequired(record, "visible", path);
  return {
    kind: parseNullableString(readRequired(record, "kind", path), `${path}.kind`) ?? "",
    pathSteps: parseArray(
      readRequired(record, "pathSteps", path),
      `${path}.pathSteps`,
      parseIssueLocatorPathStep
    ),
    x: parseNullableFiniteNumber(readRequired(record, "x", path), `${path}.x`),
    y: parseNullableFiniteNumber(readRequired(record, "y", path), `${path}.y`),
    width: parseNullableFiniteNumber(readRequired(record, "width", path), `${path}.width`),
    height: parseNullableFiniteNumber(readRequired(record, "height", path), `${path}.height`),
    coordinateSpace: parseNullableString(
      readRequired(record, "coordinateSpace", path),
      `${path}.coordinateSpace`
    ),
    visible: visibleValue === null ? null : parseBoolean(visibleValue, `${path}.visible`),
    htmlSnippet: parseNullableString(
      readRequired(record, "htmlSnippet", path),
      `${path}.htmlSnippet`
    )
  };
};

const parseEvaluationIssue: ApiResponseParser<EvaluationIssue> = (value, path) => {
  const record = parseRecord(value, path);
  const locatorValue = readRequired(record, "locator", path);
  return {
    id: parsePositiveInteger(readRequired(record, "id", path), `${path}.id`),
    requestId: parsePositiveInteger(readRequired(record, "requestId", path), `${path}.requestId`),
    module: parseEnumValue(
      readRequired(record, "module", path),
      `${path}.module`,
      issueModules
    ),
    severity: parseEnumValue(
      readRequired(record, "severity", path),
      `${path}.severity`,
      issueSeverities
    ) as EvaluationIssueSeverity,
    title: parseBoundedStringWithFallback(
      readRequired(record, "title", path),
      `${path}.title`,
      200,
      "제목 없는 접근성 이슈"
    ),
    description: parseNullableString(
      readRequired(record, "description", path),
      `${path}.description`
    ),
    recommendation: parseNullableString(
      readRequired(record, "recommendation", path),
      `${path}.recommendation`
    ),
    selector: parseNullableString(readRequired(record, "selector", path), `${path}.selector`),
    locator: locatorValue === null ? null : parseIssueLocator(locatorValue, `${path}.locator`),
    wcagCode: parseBoundedStringWithFallback(
      readRequired(record, "wcagCode", path),
      `${path}.wcagCode`,
      100,
      "UNKNOWN"
    ),
    createdAt: parseDateTime(readRequired(record, "createdAt", path), `${path}.createdAt`)
  };
};

export const parseEvaluationIssuesResponse: ApiResponseParser<EvaluationIssue[]> = (value, path) =>
  parseArray(value, path, parseEvaluationIssue);

export function createEvaluationIssuesResponseParser(
  expectedRequestId: number
): ApiResponseParser<EvaluationIssue[]> {
  return (value, path) => {
    const issues = parseEvaluationIssuesResponse(value, path);
    issues.forEach((issue, index) => {
      assertExpectedIdentifier(
        issue.requestId,
        expectedRequestId,
        `${path}[${index}].requestId`,
        "평가 요청 ID"
      );
    });
    return issues;
  };
}

export function createEvaluationArtifactParser(
  expectedRequestId: number
): ApiResponseParser<EvaluationArtifact> {
  return (value, path) => {
    const record = parseRecord(value, path);
    const id = parsePositiveInteger(readRequired(record, "id", path), `${path}.id`);
    const requestId = parsePositiveInteger(
      readRequired(record, "requestId", path),
      `${path}.requestId`
    );
    if (requestId !== expectedRequestId) {
      return failContract(requestId, `${path}.requestId`, `요청 ID ${expectedRequestId}`);
    }
    const captureMode = parseEnumValue(
      readRequired(record, "captureMode", path),
      `${path}.captureMode`,
      ["DOM_REPLAY"] as const
    );
    const contentType = parseEnumValue(
      readRequired(record, "contentType", path),
      `${path}.contentType`,
      ["text/html"] as const
    );
    const contentUrl = parseString(readRequired(record, "contentUrl", path), `${path}.contentUrl`);
    if (!["/api", ""].some((prefix) => contentUrl === `${prefix}/results/artifacts/${id}/content`)) {
      return failContract(contentUrl, `${path}.contentUrl`, `artifact ${id}의 상대 콘텐츠 URL`);
    }
    const sha256 = parseString(readRequired(record, "sha256", path), `${path}.sha256`);
    if (!/^[a-f\d]{64}$/i.test(sha256)) {
      return failContract(sha256, `${path}.sha256`, "64자리 SHA-256 문자열");
    }
    const viewportWidthCssPx = parsePositiveInteger(
      readRequired(record, "viewportWidthCssPx", path),
      `${path}.viewportWidthCssPx`
    );
    const viewportHeightCssPx = parsePositiveInteger(
      readRequired(record, "viewportHeightCssPx", path),
      `${path}.viewportHeightCssPx`
    );
    const deviceScaleFactor = parsePositiveFiniteNumber(
      readRequired(record, "deviceScaleFactor", path),
      `${path}.deviceScaleFactor`
    );
    if (deviceScaleFactor < 0.1 || deviceScaleFactor > 10) {
      return failContract(deviceScaleFactor, `${path}.deviceScaleFactor`, "0.1 이상 10 이하의 숫자");
    }
    const pageWidthCssPx = parsePositiveInteger(
      readRequired(record, "pageWidthCssPx", path),
      `${path}.pageWidthCssPx`
    );
    const pageHeightCssPx = parsePositiveInteger(
      readRequired(record, "pageHeightCssPx", path),
      `${path}.pageHeightCssPx`
    );
    if (pageWidthCssPx < viewportWidthCssPx) {
      return failContract(pageWidthCssPx, `${path}.pageWidthCssPx`, "viewport 너비 이상의 숫자");
    }
    if (pageHeightCssPx < viewportHeightCssPx) {
      return failContract(pageHeightCssPx, `${path}.pageHeightCssPx`, "viewport 높이 이상의 숫자");
    }

    return {
      id,
      requestId,
      requestedUrl: parseAbsoluteHttpUrl(
        readRequired(record, "requestedUrl", path),
        `${path}.requestedUrl`
      ),
      finalUrl: parseAbsoluteHttpUrl(readRequired(record, "finalUrl", path), `${path}.finalUrl`),
      capturedAt: parseDateTime(readRequired(record, "capturedAt", path), `${path}.capturedAt`),
      viewportWidthCssPx,
      viewportHeightCssPx,
      deviceScaleFactor,
      pageWidthCssPx,
      pageHeightCssPx,
      captureMode,
      contentUrl,
      contentType,
      sizeBytes: parsePositiveInteger(readRequired(record, "sizeBytes", path), `${path}.sizeBytes`),
      sha256,
      createdAt: parseDateTime(readRequired(record, "createdAt", path), `${path}.createdAt`),
      updatedAt: parseDateTime(readRequired(record, "updatedAt", path), `${path}.updatedAt`)
    };
  };
}

export const parseVoidResponse: ApiResponseParser<void> = (value, path) => {
  if (value === null) {
    return;
  }
  return failContract(value, path, "null");
};

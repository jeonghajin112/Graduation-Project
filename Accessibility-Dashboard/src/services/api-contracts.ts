import type {
  DashboardLatestIssueCount,
  DashboardOverviewApiResponse,
  EvaluationCaptureMetadata,
  EvaluationIssue,
  EvaluationIssueSeverity,
  EvaluationRequestModel,
  EvaluationResultSummary,
  EvaluationTarget,
  IssueLocator,
  IssueLocatorCarouselContext,
  IssueLocatorPathStep,
  LiveReportSession,
  Organization,
  RequestStatus,
  ScoreResult
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

type ContractFields = {
  required<T>(key: string, parser: ApiResponseParser<T>): T;
  optional<T>(key: string, parser: ApiResponseParser<T>): T | undefined;
};

function readFields(value: unknown, path: string): ContractFields {
  const record = parseRecord(value, path);
  const parseField = <T>(key: string, parser: ApiResponseParser<T>): T =>
    parser(readRequired(record, key, path), `${path}.${key}`);
  return {
    required: parseField,
    optional: <T>(key: string, parser: ApiResponseParser<T>): T | undefined =>
      Object.prototype.hasOwnProperty.call(record, key)
        ? parser(record[key], `${path}.${key}`)
        : undefined
  };
}

function parseString(value: unknown, path: string): string {
  if (typeof value !== "string") {
    return failContract(value, path, "문자열");
  }
  return value;
}

function parseBoolean(value: unknown, path: string): boolean {
  return typeof value === "boolean" ? value : failContract(value, path, "boolean");
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

function indexUnique<T>({
  items,
  getIdentifier,
  pathFor,
  expected
}: {
  items: readonly T[];
  getIdentifier: (item: T) => number;
  pathFor: (index: number) => string;
  expected: string;
}): Map<number, T> {
  const indexed = new Map<number, T>();
  items.forEach((item, index) => {
    const identifier = getIdentifier(item);
    if (indexed.has(identifier)) {
      throw new ApiContractValidationError({
        fieldPath: pathFor(index),
        expected,
        actualType: `중복 ID ${identifier}`
      });
    }
    indexed.set(identifier, item);
  });
  return indexed;
}

function assertKnownIdentifier(
  identifier: number,
  indexed: ReadonlyMap<number, unknown> | ReadonlySet<number>,
  path: string,
  expected: string
): void {
  if (!indexed.has(identifier)) {
    throw new ApiContractValidationError({
      fieldPath: path,
      expected,
      actualType: `참조할 수 없는 ID ${identifier}`
    });
  }
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

const organizationStatuses = ["ACTIVE", "INACTIVE"] as const;
const targetTypes = ["WEB", "MOBILE_APP", "DOCUMENT", "KIOSK", "ETC"] as const;
const targetStatuses = ["ACTIVE", "INACTIVE", "DELETED"] as const;
const requestStatuses = ["PENDING", "IN_PROGRESS", "COMPLETED", "FAILED"] as const;
const issueModules = ["rule_based", "text_difficulty", "cv_visual"] as const;
const issueSeverities = ["CRITICAL", "SERIOUS", "MODERATE", "MINOR"] as const;

export const parseOrganizationResponse: ApiResponseParser<Organization> = (value, path) => {
  const fields = readFields(value, path);
  return {
    systemManaged: fields.optional("systemManaged", parseBoolean),
    id: fields.required("id", parsePositiveInteger),
    name: fields.required("name", (field, fieldPath) =>
      parseNonBlankString(field, fieldPath, 100)),
    description: fields.required("description", parseNullableString) ?? "",
    status: fields.required("status", (field, fieldPath) =>
      parseEnumValue(field, fieldPath, organizationStatuses)),
    updatedAt: fields.required("updatedAt", parseDateTime)
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
  const fields = readFields(value, path);
  return {
    id: fields.required("id", parsePositiveInteger),
    organizationId: fields.required("organizationId", parsePositiveInteger),
    name: fields.required("name", (field, fieldPath) =>
      parseNonBlankString(field, fieldPath, 100)),
    targetType: fields.required("targetType", (field, fieldPath) =>
      parseEnumValue(field, fieldPath, targetTypes)),
    accessUrl: strictAccessUrl
      ? fields.required("accessUrl", (field, fieldPath) =>
          parseAbsoluteHttpUrl(field, fieldPath, 500))
      : fields.required("accessUrl", (field, fieldPath) =>
          parseLegacyOptionalAbsoluteHttpUrl(field, fieldPath, 500)),
    faviconUrl: fields.optional("faviconUrl", parseNullableString),
    status: fields.required("status", (field, fieldPath) =>
      parseEnumValue(field, fieldPath, targetStatuses)),
    createdAt: fields.required("createdAt", parseDateTime)
  };
}

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
    indexUnique({
      items: targets,
      getIdentifier: (target) => target.id,
      pathFor: (index) => `${path}[${index}].id`,
      expected: "중복되지 않는 평가 대상 ID"
    });
    return targets;
  };
}

export const parseEvaluationRequestResponse: ApiResponseParser<EvaluationRequestModel> = (
  value,
  path
) => {
  const fields = readFields(value, path);
  return {
    quickAnalysis: fields.optional("quickAnalysis", parseBoolean),
    id: fields.required("id", parsePositiveInteger),
    evaluationTargetId: fields.required("evaluationTargetId", parsePositiveInteger),
    status: fields.required("status", (field, fieldPath) =>
      parseEnumValue(field, fieldPath, requestStatuses)) as RequestStatus,
    requestedAt: fields.required("requestedAt", parseDateTime),
    updatedAt: fields.required("updatedAt", parseDateTime)
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
  indexUnique({
    items: requests,
    getIdentifier: (request) => request.id,
    pathFor: (index) => `${path}[${index}].id`,
    expected: "중복되지 않는 평가 요청 ID"
  });
  return requests;
};

const parseEvaluationResultSummary: ApiResponseParser<EvaluationResultSummary> = (value, path) => {
  const fields = readFields(value, path);
  return {
    requestId: fields.required("requestId", parsePositiveInteger),
    totalScore: fields.required("totalScore", parseScore),
    totalIssueCount: fields.required("totalIssueCount", parseNonNegativeInteger),
    requestedAt: fields.required("requestedAt", parseDateTime)
  };
};

const parseScoreResult: ApiResponseParser<ScoreResult> = (value, path) => {
  const fields = readFields(value, path);
  return {
    id: fields.required("id", parsePositiveInteger),
    evaluationRequestId: fields.required("evaluationRequestId", parsePositiveInteger),
    totalScore: fields.required("totalScore", parseScore)
  };
};

const parseDashboardLatestIssueCount: ApiResponseParser<DashboardLatestIssueCount> = (
  value,
  path
) => {
  const fields = readFields(value, path);
  return {
    evaluationTargetId: fields.required("evaluationTargetId", parsePositiveInteger),
    requestId: fields.required("requestId", parsePositiveInteger)
  };
};

export const parseDashboardOverviewResponse: ApiResponseParser<DashboardOverviewApiResponse> = (
  value,
  path
) => {
  const fields = readFields(value, path);
  const organizations = fields.required("organizations", (organizationsValue, organizationsPath) =>
    parseArray(organizationsValue, organizationsPath, (organizationValue, organizationPath) => {
      const organizationFields = readFields(organizationValue, organizationPath);
      const organization = parseOrganizationResponse(organizationValue, organizationPath);
      const evaluationTargets = organizationFields.required(
        "evaluationTargets",
        (targetsValue, targetsPath) => parseArray(
          targetsValue,
          targetsPath,
          createEvaluationTargetResponseParser({ expectedOrganizationId: organization.id })
        )
      );
      return {
        ...organization,
        evaluationTargets
      };
    })
  );
  const evaluationRequests = fields.required("evaluationRequests", (field, fieldPath) =>
    parseArray(field, fieldPath, parseEvaluationRequestResponse));
  const resultSummaries = fields.required("resultSummaries", (field, fieldPath) =>
    parseArray(field, fieldPath, parseEvaluationResultSummary));
  const scoreResults = fields.required("scoreResults", (field, fieldPath) =>
    parseArray(field, fieldPath, parseScoreResult));
  const latestIssueCounts = fields.required("latestIssueCounts", (field, fieldPath) =>
    parseArray(field, fieldPath, parseDashboardLatestIssueCount));
  const evaluationTargets = organizations.flatMap(
    (organization) => organization.evaluationTargets
  );

  indexUnique({
    items: organizations,
    getIdentifier: (organization) => organization.id,
    pathFor: (index) => `${path}.organizations[${index}].id`,
    expected: "중복되지 않는 조직 ID"
  });
  const targetsById = indexUnique({
    items: evaluationTargets,
    getIdentifier: (target) => target.id,
    pathFor: (index) => `${path}.organizations[*].evaluationTargets[${index}].id`,
    expected: "중복되지 않는 평가 대상 ID"
  });
  const requestsById = indexUnique({
    items: evaluationRequests,
    getIdentifier: (request) => request.id,
    pathFor: (index) => `${path}.evaluationRequests[${index}].id`,
    expected: "중복되지 않는 평가 요청 ID"
  });
  evaluationRequests.forEach((request, index) => {
    assertKnownIdentifier(
      request.evaluationTargetId,
      targetsById,
      `${path}.evaluationRequests[${index}].evaluationTargetId`,
      "organizations에 포함된 평가 대상 ID"
    );
  });

  indexUnique({
    items: resultSummaries,
    getIdentifier: (summary) => summary.requestId,
    pathFor: (index) => `${path}.resultSummaries[${index}].requestId`,
    expected: "중복되지 않는 평가 요청 ID"
  });
  resultSummaries.forEach((summary, index) => {
    assertKnownIdentifier(
      summary.requestId,
      requestsById,
      `${path}.resultSummaries[${index}].requestId`,
      "존재하는 평가 요청 ID"
    );
  });

  indexUnique({
    items: scoreResults,
    getIdentifier: (score) => score.evaluationRequestId,
    pathFor: (index) => `${path}.scoreResults[${index}].evaluationRequestId`,
    expected: "중복되지 않는 평가 요청 ID"
  });
  scoreResults.forEach((scoreResult, index) => {
    assertKnownIdentifier(
      scoreResult.evaluationRequestId,
      requestsById,
      `${path}.scoreResults[${index}].evaluationRequestId`,
      "존재하는 평가 요청 ID"
    );
  });

  indexUnique({
    items: latestIssueCounts,
    getIdentifier: (statistics) => statistics.evaluationTargetId,
    pathFor: (index) => `${path}.latestIssueCounts[${index}].evaluationTargetId`,
    expected: "중복되지 않는 최신 이슈 대상 ID"
  });
  latestIssueCounts.forEach((statistics, index) => {
    const referencedRequest = requestsById.get(statistics.requestId);
    assertKnownIdentifier(
      statistics.evaluationTargetId,
      targetsById,
      `${path}.latestIssueCounts[${index}].evaluationTargetId`,
      "organizations에 포함된 평가 대상 ID"
    );
    if (
      referencedRequest === undefined ||
      referencedRequest.evaluationTargetId !== statistics.evaluationTargetId
    ) {
      failContract(
        statistics.requestId,
        `${path}.latestIssueCounts[${index}].requestId`,
        `평가 대상 ${statistics.evaluationTargetId}에 속한 요청 ID`
      );
    }
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
  const fields = readFields(value, path);
  return {
    // Stored locator metadata predates the current replay vocabulary and can
    // contain lowercase/custom contexts or null selectors. Preserve that
    // valid wire data; the replay adapter filters unsupported steps safely.
    context: fields.required("context", parseNullableString) ?? "",
    selector: fields.required("selector", parseNullableString) ?? "",
    frameUrl: fields.required("frameUrl", parseNullableString)
  };
};

const parseIssueLocatorCarouselContext: ApiResponseParser<IssueLocatorCarouselContext> = (
  value,
  path
) => {
  const fields = readFields(value, path);
  const carouselId = fields.required("carouselId", parsePositiveInteger);
  const slideIndex = fields.required("slideIndex", parseNonNegativeInteger);
  const slideCount = fields.required("slideCount", parsePositiveInteger);
  if (slideCount < 2) {
    return failContract(slideCount, `${path}.slideCount`, "2 이상의 정수");
  }
  if (slideCount > 10_000) {
    return failContract(slideCount, `${path}.slideCount`, "10,000 이하의 정수");
  }
  if (slideIndex >= slideCount) {
    return failContract(slideIndex, `${path}.slideIndex`, "slideCount보다 작은 정수");
  }
  return { carouselId, slideIndex, slideCount };
};

const parseIssueLocator: ApiResponseParser<IssueLocator> = (value, path) => {
  const fields = readFields(value, path);
  const carouselContext = fields.optional("carouselContext", (field, fieldPath) =>
    field === null ? null : parseIssueLocatorCarouselContext(field, fieldPath));
  const nullableNumber: ApiResponseParser<number | null> = (field, fieldPath) =>
    field === null ? null : parseFiniteNumber(field, fieldPath);
  return {
    pathSteps: fields.required("pathSteps", (field, fieldPath) =>
      parseArray(field, fieldPath, parseIssueLocatorPathStep)),
    htmlSnippet: fields.optional("htmlSnippet", parseNullableString),
    x: fields.optional("x", nullableNumber),
    y: fields.optional("y", nullableNumber),
    width: fields.optional("width", nullableNumber),
    height: fields.optional("height", nullableNumber),
    coordinateSpace: fields.optional("coordinateSpace", parseNullableString),
    ...(carouselContext !== undefined ? { carouselContext } : {})
  };
};

const parseEvaluationIssue: ApiResponseParser<EvaluationIssue> = (value, path) => {
  const fields = readFields(value, path);
  return {
    id: fields.required("id", parsePositiveInteger),
    requestId: fields.required("requestId", parsePositiveInteger),
    module: fields.required("module", (field, fieldPath) =>
      parseEnumValue(field, fieldPath, issueModules)),
    severity: fields.required("severity", (field, fieldPath) =>
      parseEnumValue(field, fieldPath, issueSeverities)) as EvaluationIssueSeverity,
    title: fields.required("title", (field, fieldPath) =>
      parseBoundedStringWithFallback(field, fieldPath, 200, "제목 없는 접근성 이슈")),
    description: fields.required("description", parseNullableString),
    recommendation: fields.required("recommendation", parseNullableString),
    selector: fields.required("selector", parseNullableString),
    locator: fields.required("locator", (field, fieldPath) =>
      field === null ? null : parseIssueLocator(field, fieldPath)),
    wcagCode: fields.required("wcagCode", (field, fieldPath) =>
      parseBoundedStringWithFallback(field, fieldPath, 100, "UNKNOWN")),
    createdAt: fields.required("createdAt", parseDateTime)
  };
};

const parseEvaluationIssuesResponse: ApiResponseParser<EvaluationIssue[]> = (value, path) =>
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

export function createEvaluationCaptureMetadataParser(
  expectedRequestId: number
): ApiResponseParser<EvaluationCaptureMetadata> {
  return (value, path) => {
    const fields = readFields(value, path);
    const id = fields.required("id", parsePositiveInteger);
    const requestId = fields.required("requestId", parsePositiveInteger);
    if (requestId !== expectedRequestId) {
      return failContract(requestId, `${path}.requestId`, `요청 ID ${expectedRequestId}`);
    }
    const viewportWidthCssPx = fields.required("viewportWidthCssPx", parsePositiveInteger);
    const viewportHeightCssPx = fields.required("viewportHeightCssPx", parsePositiveInteger);
    const deviceScaleFactor = fields.required("deviceScaleFactor", parsePositiveFiniteNumber);
    if (deviceScaleFactor < 0.1 || deviceScaleFactor > 10) {
      return failContract(deviceScaleFactor, `${path}.deviceScaleFactor`, "0.1 이상 10 이하의 숫자");
    }
    const pageWidthCssPx = fields.required("pageWidthCssPx", parsePositiveInteger);
    const pageHeightCssPx = fields.required("pageHeightCssPx", parsePositiveInteger);
    if (pageWidthCssPx < viewportWidthCssPx) {
      return failContract(pageWidthCssPx, `${path}.pageWidthCssPx`, "viewport 너비 이상의 숫자");
    }
    if (pageHeightCssPx < viewportHeightCssPx) {
      return failContract(pageHeightCssPx, `${path}.pageHeightCssPx`, "viewport 높이 이상의 숫자");
    }

    return {
      id,
      requestId,
      requestedUrl: fields.required("requestedUrl", parseAbsoluteHttpUrl),
      finalUrl: fields.required("finalUrl", parseAbsoluteHttpUrl),
      capturedAt: fields.required("capturedAt", parseDateTime),
      viewportWidthCssPx,
      viewportHeightCssPx,
      deviceScaleFactor,
      pageWidthCssPx,
      pageHeightCssPx
    };
  };
}

export const parseLiveReportSessionResponse: ApiResponseParser<LiveReportSession> = (
  value,
  path
) => {
  const fields = readFields(value, path);
  const sessionId = fields.required("sessionId", (field, fieldPath) =>
    parseNonBlankString(field, fieldPath, 128));
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) {
    return failContract(sessionId, `${path}.sessionId`, "URL-safe session identifier");
  }

  const runtimeUrl = fields.required("runtimeUrl", parseAbsoluteHttpUrl);
  const viewerOrigin = fields.required("viewerOrigin", (field, fieldPath) =>
    parseNonBlankString(field, fieldPath, 512));
  const parsedRuntimeUrl = new URL(runtimeUrl);
  if (viewerOrigin !== "null") {
    const parsedViewerOrigin = new URL(parseAbsoluteHttpUrl(viewerOrigin, `${path}.viewerOrigin`, 512));
    if (
      parsedViewerOrigin.origin !== viewerOrigin ||
      parsedViewerOrigin.pathname !== "/" ||
      parsedViewerOrigin.search.length > 0 ||
      parsedViewerOrigin.hash.length > 0
    ) {
      return failContract(viewerOrigin, `${path}.viewerOrigin`, "path가 없는 HTTP(S) origin");
    }
    if (parsedRuntimeUrl.origin !== parsedViewerOrigin.origin) {
      return failContract(
        runtimeUrl,
        `${path}.runtimeUrl`,
        `viewerOrigin ${viewerOrigin}과 같은 origin의 URL`
      );
    }
  }

  const nonce = fields.required("nonce", (field, fieldPath) =>
    parseNonBlankString(field, fieldPath, 256));
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(nonce)) {
    return failContract(nonce, `${path}.nonce`, "32~256자 URL-safe nonce");
  }

  const bridgeSecret = fields.required("bridgeSecret", (field, fieldPath) =>
    parseNonBlankString(field, fieldPath, 256));
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(bridgeSecret)) {
    return failContract(
      bridgeSecret,
      `${path}.bridgeSecret`,
      "32~256자 URL-safe bridge secret"
    );
  }
  if (bridgeSecret === nonce) {
    return failContract(
      bridgeSecret,
      `${path}.bridgeSecret`,
      "resource nonce와 다른 bridge secret"
    );
  }

  return {
    sessionId,
    runtimeUrl,
    viewerOrigin,
    nonce,
    bridgeSecret,
    expiresAt: fields.required("expiresAt", parseDateTime)
  };
};

export const parseVoidResponse: ApiResponseParser<void> = (value, path) => {
  if (value === null) {
    return;
  }
  return failContract(value, path, "null");
};

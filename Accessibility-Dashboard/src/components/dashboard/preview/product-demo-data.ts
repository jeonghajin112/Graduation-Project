import type { SiteDashboardPreviewEvidence } from "../panels/site-dashboard-panel";
import type { QuickAnalysisResultRecord } from "@/services/quick-analysis-registry";
import type {
  AnalysisResult,
  DashboardViewModel,
  EvaluationCaptureMetadata,
  EvaluationRequestModel,
  EvaluationResultSummary,
  IssueResultModel,
  OrganizationModel,
  ScoreResult
} from "@/types/accessibility-domain";

const CREATED_AT = "2026-08-01T01:00:00.000Z";
const HONGIK_MAIN_REQUEST_ID = 5_001;
const HONGIK_ARCH_REQUEST_ID = 5_002;
const NAVER_REQUEST_ID = 5_003;
const HONGIK_LIBRARY_REQUEST_ID = 5_004;
const HONGIK_ADMISSION_REQUEST_ID = 5_005;
const HONGIK_GLOBAL_REQUEST_ID = 5_006;
const HONGIK_GRADUATE_REQUEST_ID = 5_007;

export const PRODUCT_DEMO_ORGANIZATIONS: OrganizationModel[] = [
  {
    id: 101,
    name: "홍익대학교",
    description: "홍익대학교 웹 접근성 점검 프로젝트",
    status: "ACTIVE",
    updatedAt: "2026-08-11T11:26:00.000Z",
    evaluationTargets: [
      {
        id: 1_001,
        name: "www.hongik.ac.kr",
        targetType: "PC 웹",
        accessUrl: "https://www.hongik.ac.kr",
        faviconUrl: null,
        status: "COMPLETED",
        createdAt: CREATED_AT
      },
      {
        id: 1_002,
        name: "건축학부",
        targetType: "PC 웹",
        accessUrl: "https://arch.hongik.ac.kr",
        faviconUrl: null,
        status: "COMPLETED",
        createdAt: "2026-08-02T02:00:00.000Z"
      },
      {
        id: 1_003,
        name: "중앙도서관",
        targetType: "PC 웹",
        accessUrl: "https://library.hongik.ac.kr",
        faviconUrl: null,
        status: "COMPLETED",
        createdAt: "2026-08-03T03:00:00.000Z"
      },
      {
        id: 1_004,
        name: "입학관리본부",
        targetType: "PC 웹",
        accessUrl: "https://admission.hongik.ac.kr",
        faviconUrl: null,
        status: "COMPLETED",
        createdAt: "2026-08-04T04:00:00.000Z"
      },
      {
        id: 1_005,
        name: "국제협력본부",
        targetType: "PC 웹",
        accessUrl: "https://oia.hongik.ac.kr",
        faviconUrl: null,
        status: "COMPLETED",
        createdAt: "2026-08-05T05:00:00.000Z"
      },
      {
        id: 1_006,
        name: "대학원",
        targetType: "PC 웹",
        accessUrl: "https://grad.hongik.ac.kr",
        faviconUrl: null,
        status: "COMPLETED",
        createdAt: "2026-08-06T06:00:00.000Z"
      }
    ]
  },
  {
    id: 102,
    name: "네이버",
    description: "네이버 웹 접근성 점검 프로젝트",
    status: "ACTIVE",
    updatedAt: "2026-08-10T08:20:00.000Z",
    evaluationTargets: [
      {
        id: 2_001,
        name: "네이버",
        targetType: "PC 웹",
        accessUrl: "https://www.naver.com",
        faviconUrl: null,
        status: "COMPLETED",
        createdAt: "2026-08-03T03:00:00.000Z"
      }
    ]
  }
];

const REQUESTS: EvaluationRequestModel[] = [
  createRequest(HONGIK_MAIN_REQUEST_ID, 1_001, "2026-08-11T11:26:00.000Z"),
  createRequest(HONGIK_ARCH_REQUEST_ID, 1_002, "2026-08-09T07:42:00.000Z"),
  createRequest(HONGIK_LIBRARY_REQUEST_ID, 1_003, "2026-08-08T06:18:00.000Z"),
  createRequest(HONGIK_ADMISSION_REQUEST_ID, 1_004, "2026-08-07T05:04:00.000Z"),
  createRequest(HONGIK_GLOBAL_REQUEST_ID, 1_005, "2026-08-06T04:31:00.000Z"),
  createRequest(HONGIK_GRADUATE_REQUEST_ID, 1_006, "2026-08-05T03:12:00.000Z"),
  createRequest(NAVER_REQUEST_ID, 2_001, "2026-08-10T08:20:00.000Z")
];

const SUMMARIES: EvaluationResultSummary[] = [
  createSummary(HONGIK_MAIN_REQUEST_ID, 86.2, 117, "2026-08-11T11:26:00.000Z"),
  createSummary(HONGIK_ARCH_REQUEST_ID, 75, 233, "2026-08-09T07:42:00.000Z"),
  createSummary(HONGIK_LIBRARY_REQUEST_ID, 91.4, 28, "2026-08-08T06:18:00.000Z"),
  createSummary(HONGIK_ADMISSION_REQUEST_ID, 83.7, 74, "2026-08-07T05:04:00.000Z"),
  createSummary(HONGIK_GLOBAL_REQUEST_ID, 88.1, 39, "2026-08-06T04:31:00.000Z"),
  createSummary(HONGIK_GRADUATE_REQUEST_ID, 80.5, 91, "2026-08-05T03:12:00.000Z"),
  createSummary(NAVER_REQUEST_ID, 89.6, 42, "2026-08-10T08:20:00.000Z")
];

const SCORES: ScoreResult[] = [
  createScore(7_001, HONGIK_MAIN_REQUEST_ID, 86.2),
  createScore(7_002, HONGIK_ARCH_REQUEST_ID, 75),
  createScore(7_004, HONGIK_LIBRARY_REQUEST_ID, 91.4),
  createScore(7_005, HONGIK_ADMISSION_REQUEST_ID, 83.7),
  createScore(7_006, HONGIK_GLOBAL_REQUEST_ID, 88.1),
  createScore(7_007, HONGIK_GRADUATE_REQUEST_ID, 80.5),
  createScore(7_003, NAVER_REQUEST_ID, 89.6)
];

export const PRODUCT_DEMO_DASHBOARD: DashboardViewModel = {
  organizations: PRODUCT_DEMO_ORGANIZATIONS,
  evaluationRequests: REQUESTS,
  resultSummaries: SUMMARIES,
  latestIssueCounts: [],
  scoreResults: SCORES
};

export const PRODUCT_DEMO_QUICK_ANALYSIS_RESULTS: readonly QuickAnalysisResultRecord[] = [
  {
    projectId: 101,
    pageId: 1_001,
    timestamp: Date.parse("2026-08-11T11:26:00.000Z")
  },
  {
    projectId: 102,
    pageId: 2_001,
    timestamp: Date.parse("2026-08-10T08:20:00.000Z")
  },
  {
    projectId: 101,
    pageId: 1_002,
    timestamp: Date.parse("2026-08-09T07:42:00.000Z")
  }
];

export const PRODUCT_DEMO_EVIDENCE = new Map<number, SiteDashboardPreviewEvidence>([
  [
    1_001,
    createEvidence({
      requestId: HONGIK_MAIN_REQUEST_ID,
      analysisResultId: 8_001,
      metadataId: 9_001,
      url: "https://www.hongik.ac.kr",
      capturedAt: "2026-08-11T11:26:00.000Z",
      issues: [
        createIssue(10_001, 8_001, "img-alt", "이미지 대체 텍스트가 없습니다", "CRITICAL", ".visual-banner", "메인 비주얼 이미지에 대체 텍스트가 없어 화면 읽기 프로그램이 이미지의 목적을 전달하지 못합니다."),
        createIssue(10_002, 8_001, "color-contrast", "텍스트 명도 대비가 부족합니다", "HIGH", ".notice-date", "공지 날짜의 전경색과 배경색 명도 대비가 기준보다 낮습니다."),
        createIssue(10_003, 8_001, "keyboard-focus", "키보드 초점이 보이지 않습니다", "MEDIUM", ".quick-link", "빠른 메뉴 링크가 키보드 초점을 받아도 시각적 표시가 충분하지 않습니다.")
      ]
    })
  ],
  [
    1_002,
    createEvidence({
      requestId: HONGIK_ARCH_REQUEST_ID,
      analysisResultId: 8_002,
      metadataId: 9_002,
      url: "https://arch.hongik.ac.kr",
      capturedAt: "2026-08-09T07:42:00.000Z",
      issues: [
        createIssue(10_011, 8_002, "heading-order", "제목 구조의 순서가 올바르지 않습니다", "HIGH", ".department-title", "콘텐츠 제목 단계가 문서 구조와 일치하지 않습니다."),
        createIssue(10_012, 8_002, "keyboard-focus", "키보드 초점이 보이지 않습니다", "MEDIUM", ".quick-link", "갤러리 제어 버튼의 키보드 초점 표시가 부족합니다.")
      ]
    })
  ],
  [
    1_003,
    createEvidence({
      requestId: HONGIK_LIBRARY_REQUEST_ID,
      analysisResultId: 8_004,
      metadataId: 9_004,
      url: "https://library.hongik.ac.kr",
      capturedAt: "2026-08-08T06:18:00.000Z",
      issues: [
        createIssue(10_031, 8_004, "link-name", "링크의 목적을 알기 어렵습니다", "HIGH", ".book-link", "자료 링크에 화면 읽기 프로그램이 구분할 수 있는 이름이 필요합니다.")
      ]
    })
  ],
  [
    1_004,
    createEvidence({
      requestId: HONGIK_ADMISSION_REQUEST_ID,
      analysisResultId: 8_005,
      metadataId: 9_005,
      url: "https://admission.hongik.ac.kr",
      capturedAt: "2026-08-07T05:04:00.000Z",
      issues: [
        createIssue(10_041, 8_005, "color-contrast", "텍스트 명도 대비가 부족합니다", "HIGH", ".admission-date", "전형 일정 텍스트의 명도 대비가 기준보다 낮습니다.")
      ]
    })
  ],
  [
    1_005,
    createEvidence({
      requestId: HONGIK_GLOBAL_REQUEST_ID,
      analysisResultId: 8_006,
      metadataId: 9_006,
      url: "https://oia.hongik.ac.kr",
      capturedAt: "2026-08-06T04:31:00.000Z",
      issues: [
        createIssue(10_051, 8_006, "language-change", "언어 변경을 식별할 수 없습니다", "MEDIUM", ".global-notice", "영문 안내 영역의 언어 변경 정보가 제공되지 않습니다.")
      ]
    })
  ],
  [
    1_006,
    createEvidence({
      requestId: HONGIK_GRADUATE_REQUEST_ID,
      analysisResultId: 8_007,
      metadataId: 9_007,
      url: "https://grad.hongik.ac.kr",
      capturedAt: "2026-08-05T03:12:00.000Z",
      issues: [
        createIssue(10_061, 8_007, "keyboard-focus", "키보드 초점이 보이지 않습니다", "MEDIUM", ".graduate-menu", "대학원 메뉴의 키보드 초점 표시가 충분하지 않습니다.")
      ]
    })
  ],
  [
    2_001,
    createEvidence({
      requestId: NAVER_REQUEST_ID,
      analysisResultId: 8_003,
      metadataId: 9_003,
      url: "https://www.naver.com",
      capturedAt: "2026-08-10T08:20:00.000Z",
      issues: [
        createIssue(10_021, 8_003, "label-missing", "입력 요소의 이름이 명확하지 않습니다", "HIGH", ".search-field", "검색 입력란에 프로그램이 인식할 수 있는 이름이 필요합니다.")
      ]
    })
  ]
]);

function createRequest(
  id: number,
  evaluationTargetId: number,
  updatedAt: string
): EvaluationRequestModel {
  return {
    id,
    evaluationTargetId,
    status: "COMPLETED",
    requestedAt: updatedAt,
    updatedAt
  };
}

function createSummary(
  requestId: number,
  totalScore: number,
  totalIssueCount: number,
  requestedAt: string
): EvaluationResultSummary {
  return {
    requestId,
    totalScore,
    totalIssueCount,
    requestedAt
  };
}

function createScore(
  id: number,
  evaluationRequestId: number,
  totalScore: number
): ScoreResult {
  return {
    id,
    evaluationRequestId,
    totalScore
  };
}

function createIssue(
  id: number,
  analysisResultId: number,
  issueCode: string,
  issueTitle: string,
  severity: IssueResultModel["severity"],
  selector: string,
  message: string
): IssueResultModel {
  return {
    id,
    analysisResultId,
    issueCode,
    issueTitle,
    severity,
    locationPath: selector,
    locator: {
      pathSteps: [{ context: "DOCUMENT", selector }]
    },
    message,
    recommendation: "해당 요소가 KWCAG 기준을 충족하도록 이름, 대비 또는 초점 표시를 보완하세요.",
    resolved: false,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT
  };
}

function createEvidence({
  analysisResultId,
  metadataId,
  capturedAt,
  issues,
  requestId,
  url
}: {
  analysisResultId: number;
  metadataId: number;
  capturedAt: string;
  issues: IssueResultModel[];
  requestId: number;
  url: string;
}): SiteDashboardPreviewEvidence {
  const analysisResult: AnalysisResult = {
    id: analysisResultId,
    evaluationRequestId: requestId,
    analyzerType: "RULE_BASED",
    status: "SUCCESS",
    summary: "랜딩 미리보기용 정적 분석 결과",
    startedAt: capturedAt,
    completedAt: capturedAt,
    createdAt: capturedAt,
    updatedAt: capturedAt
  };
  const captureMetadata: EvaluationCaptureMetadata = {
    id: metadataId,
    requestId,
    requestedUrl: url,
    finalUrl: url,
    capturedAt,
    viewportWidthCssPx: 1440,
    viewportHeightCssPx: 900,
    deviceScaleFactor: 1,
    pageWidthCssPx: 1440,
    pageHeightCssPx: 1680
  };

  return {
    analysisResults: [analysisResult],
    captureMetadata,
    issueResults: issues,
    previewRuntimeUrl: "/preview/product-replay.html"
  };
}

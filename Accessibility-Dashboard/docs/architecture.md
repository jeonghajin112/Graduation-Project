# 프런트 아키텍처

현재 상태 소유권과 모듈 간 계약을 설명한다. 실행은 [README](../README.md), 설계 판단은 [개발 기준](engineering.md), 검증은 [테스트 가이드](testing.md)를 참고한다. 현재 확인된 오류는 아래에 따로 기록한다.

## 화면과 데이터 흐름

```text
App / BrowserRouter
  → DashboardAppRoute
  → useDashboardController        URL 선택·화면 동작
  → useDashboardData              overview·상태 polling
  → backend-api / api-contracts   HTTP·오류 변환·응답 검증

페이지 상세
  → 이슈 / 캡처 메타데이터 / 라이브 세션 조회
  → RenderedPageEvidenceCard
  → 격리 viewer의 MessageChannel
```

| 상태 | 소유 위치 | 이유 |
|---|---|---|
| 현재 프로젝트·페이지 | URL | 새로고침, 뒤로 가기, 링크 공유 |
| 서버 snapshot·진행 상태 | `useDashboardData` | 목록과 결과의 일관된 갱신 |
| 모달·입력·선택 이슈 | 해당 컴포넌트/훅 | 짧은 UI 수명 |
| 생성·분석 복구 기록 | `sessionStorage` | 새로고침 후 미확정 작업 확인 |
| 테마·완료 확인 표시 | `localStorage` | 브라우저의 사용자 선택 보조 |
| 상세 캐시·공유 요청 | `services/request-cache.ts`와 조회 훅 | 같은 요청의 중복 조회와 수명 관리 |

저장소의 기록은 서버 데이터의 대체물이 아니다. 최근 분석 링크도 현재 overview에 존재하는 페이지를 기준으로 표시한다.

최근 분석한 페이지는 서버 요청의 `quickAnalysis` 구분을 기준으로 접수부터 표시한다. 완료 여부나 탭을 열었는지에 의존하지 않으며 새로고침 후에도 복원된다. 이전 로컬 최근 기록은 호환용으로 합치되 페이지별 중복은 제거한다. 프로젝트에서만 분석한 페이지는 최근 목록에 자동 추가하지 않는다.

URL 분석의 저장용 조직은 `systemManaged`로 구분해 프로젝트 목록에서 제외한다. 데이터와 리포트 조회에는 그대로 사용하며 예전 프로젝트 페이지 주소는 최근 페이지 주소로 연결한다. 구형 자동 그룹은 기본 이름·설명·유형이 모두 일치하는 경우에만 인식하고, 이름을 바꿔 쓰는 기존 프로젝트는 유지한다.

주요 경로는 `/`, `/product-preview`, `/analyze`, `/projects/:projectId`, `/projects/:projectId/pages/:pageId`, `/recent-pages/:pageId`다. 실제 라우팅은 [App.tsx](../src/App.tsx)와 [controller](../src/components/dashboard/shared/use-dashboard-controller.tsx)가 기준이다. `/dashboard`는 `/analyze`로 이동한다.

## 대시보드 조회

[useDashboardData](../src/components/dashboard/shared/use-dashboard-data.ts)는 `GET /dashboard/overview`를 받아 화면 모델을 만든다. 진행 중 요청이 있을 때만 요청별 상태를 polling하고, 완료·실패 또는 조회 오류가 발생하면 overview를 다시 가져온다. 숨겨진 탭에서는 polling을 건너뛴다.

URL 분석과 프로젝트 페이지 등록은 요청 ID가 확인되면 입력 또는 모달을 해제한다. 이후 상태 조회는 대시보드 수명으로 계속하며 완료 시 화면을 강제로 이동하지 않는다. 접수·상태 응답은 overview가 반영할 때까지 유지하고, 개별 조회 실패가 다른 요청의 상태 갱신을 막지 않는다. 결과 조회 실패는 다음 분석 접수와 분리한다. 백엔드는 단일 작업자로 순차 실행하며 실제 실행 전에는 `PENDING`, 실행 시작 시 `IN_PROGRESS`로 전환한다.

분석 중인 페이지를 열면 본문 전체에 대기 또는 분석 진행 화면을 표시한다. 이때 결과 카드와 뷰어는 마운트하지 않으며, 재분석 시 이전 뷰어도 해제한다. 해당 페이지의 활성 요청이 끝나면 최신 완료 요청의 결과와 렌더링을 불러온다. 점수 overview 갱신이 늦더라도 이전 요청의 뷰어를 다시 열지 않는다. 다른 페이지의 탐색과 상태 조회는 계속된다.

사이드바의 프로젝트 페이지 탭 오른쪽에 대기·진행·오류·완료 아이콘을 표시한다. 같은 페이지에 여러 요청이 있으면 실행 중, 대기 중 순으로 우선 표시하고, 활성 요청이 없으면 최근 접수한 요청의 결과를 표시한다. 프로젝트 페이지 탭이나 최근 분석한 페이지를 열면 해당 완료 요청 ID를 API scope별로 로컬에 저장해 표시를 지운다. 아이콘은 별도의 버튼이 아니며 이후 새 분석의 완료 표시는 다시 나타난다.

수동 재시도와 mutation 후 갱신은 이전 요청을 취소한다. 늦게 도착한 응답은 현재 요청의 상태를 덮지 못해야 한다. 갱신 실패 시 기존 snapshot을 유지하면서 오류와 재시도를 제공한다.

현재 생성 흐름에는 일시적으로 오래된 overview가 도착할 때 기존 목록을 유지하는 directory recovery lease가 있다. 단순화하려면 서버 응답 일관성과 동시 삭제 시나리오를 먼저 확인해야 한다. 기존 수명·횟수 제한의 구현은 해당 훅과 회귀 테스트를 기준으로 한다.

## API 경계

일반 화면 API는 [backend-api.ts](../src/services/backend-api.ts)를 거쳐 [api-contracts.ts](../src/services/api-contracts.ts)에서 검증한다. API base는 `VITE_API_BASE_URL` 또는 `/api`다.

일반 API는 `{ success, data, message }` 형태를 사용한다. HTTP 2xx라도 실패 envelope나 잘못된 data이면 오류다. ID·URL·enum·점수·날짜뿐 아니라 요청과 결과의 참조 관계를 확인한다. AI가 쓰는 `POST /api/v1/evaluations`는 [별도 ingestion API](../../ap-backend/src/main/java/com/accessibility/platform/integration/controller/AiEvaluationController.java)로 이 일반 envelope 규칙의 대상이 아니다.

주요 조회는 overview, 요청 상태, 선택된 요청의 이슈·캡처·라이브 세션이다. 생성·수정·삭제 endpoint와 필드의 정확한 목록은 HTTP 어댑터와 백엔드 controller가 원본이다. 문서에 두 번째 스키마를 유지하지 않는다.

UI에는 내부 payload 대신 사용자에게 필요한 실패 원인과 재시도 동작을 제공한다. 데이터 없음, 실제 0점, 로딩과 실패를 구분한다.

## 페이지 상세와 캐시

점수 또는 결과 요약이 있는 요청 중 최신 요청을 선택한 뒤 이슈, 캡처 정보, 라이브 세션을 독립적으로 조회한다. 캡처 404는 정상적인 자료 없음이며, 지원하지 않는 라이브 세션 응답은 별도 사용 불가 상태다.

[request-cache.ts](../src/services/request-cache.ts)는 TTL·LRU와 공유 중인 요청의 소비자 수, 취소, 제한시간을 담당한다. 각 조회 훅은 캐시 키와 도메인 상태를 결정한다. 라이브 세션의 origin·토큰·만료·갱신 판단도 라이브 세션 훅의 책임이다. 취소된 요청의 늦은 결과를 캐시에 저장하지 않고 로그아웃 때 등록된 요청과 캐시를 정리한다.

새 캐시 계층을 추가하기 전에 이 책임으로 표현할 수 있는지 확인한다. 단순한 파생 값은 별도 state/ref에 중복 저장하지 않는다.

## 생성과 복구

| 흐름 | 현재 계약 | 결과가 불명확할 때 |
|---|---|---|
| 프로젝트 생성 | UUID `Idempotency-Key`와 입력을 저장해 POST | 같은 키와 입력으로 명시적 재시도. ID 확인 후에는 목록 GET만 재시도 |
| 페이지 생성·분석 시작 | 서버 요청 식별자 계약이 아직 없음 | 기존 ID와 입력을 기준으로 제한된 GET 확인. 불명확한 POST를 자동 반복하지 않음 |
| 빠른 URL 분석 | 요청 ID 확인 후 백그라운드 상태 조회로 인계 | 불명확한 접수만 GET으로 복구하며, 확인된 요청은 결과 열람 없이 입력을 해제 |

프로젝트 생성 API는 같은 키·원본 입력이면 같은 ID, 다른 입력이면 409, 잘못된 UUID이면 400을 반환한다. 원래 입력의 비교값을 보존하므로 이후 이름 변경과도 구분된다. 이 API를 지원하는 백엔드와 프런트를 함께 적용해야 한다.

복구 기록은 version·attempt ID·API scope·시각을 확인한다. 저장값 비교로 오래된 비동기 작업이 새 기록을 덮는 것을 막는다. 프로젝트 생성 기록 v2는 이전 v1을 감지할 수 있도록 저장 키를 유지하며, 구형 기록을 새 요청으로 자동 재실행하지 않는다.

페이지 생성·분석의 복구를 더 줄이려면 해당 서버 API에도 중복 요청 식별 계약을 먼저 마련해야 한다. 프로젝트 생성만의 보장을 다른 POST에 있다고 가정하지 않는다.

프로젝트 수정·제거와 페이지 제거는 실행 전에 최신 overview로 원하는 변경이 이미 반영됐는지 확인한다. 상태 조회는 5초, PATCH는 15초로 제한하며, 불명확한 PATCH 결과는 GET으로 한 번 더 확인한다. 처리 여부를 확인하지 못하면 모달에 안내하고 취소·Escape를 다시 허용한다. PATCH를 자동 재전송하지 않으며 사용자가 다시 시도하거나 모달을 다시 열어도 먼저 서버 상태를 확인한다. 확인 조회가 실패하면 변경 요청을 보내지 않는다. 대시보드를 떠나면 진행 중 요청을 취소하고 늦은 완료가 화면 이동을 일으키지 않도록 한다. 클라이언트의 대기 중단은 서버 작업 취소를 보장하지 않는다.

## 라이브 리포트

현재 외부 페이지를 격리한 viewer를 표시한다. 분석 당시 정적 화면과 동일한 내용임을 보장하지 않으며, 캡처 크기와 locator를 현재 문서에 맞춰 해석한다.

마커는 각 대상 요소의 가로 위치를 유지한다. 같은 줄이라는 이유로 균등 간격으로 옮기지 않으며, 공간이 부족하면 기존 묶음 마커로 문제를 확인할 수 있다. 분석 문장이 저장된 텍스트 문제는 현재 요소의 텍스트·안내 속성과도 대조한다. 순번 경로가 다른 내용을 가리키면 같은 경로 구조에서 순번만 풀어 원문이 일치하는 요소를 찾는다. 공백을 제외한 원문이 20자 이상이고 후보가 하나일 때만 다시 연결하며, 여러 후보가 일치하거나 원문이 없으면 잘못된 요소에 마커를 붙이지 않는다. 문서 내용이 갱신될 때 다시 확인한다. 텍스트 추출기는 숨김 요소를 제거하기 전의 형제 순번을 보존해 분석 경로를 만든다.

미표시 문제에는 뷰어가 전달한 사유를 표시한다. 카드의 ‘문제 상세’에서는 미리보기에서 잘린 전체 설명과 개선 안내, 분석 당시 요소 경로, 프레임·Shadow DOM 경로, HTML과 좌표를 확인한다. 긴 내용은 대화상자 본문에서 키보드로도 스크롤할 수 있다. 저장된 HTML은 텍스트로만 렌더링하며, 과거 좌표를 현재 페이지의 정확한 위치로 표시하지 않는다.

문제 목록의 페이지당 개수는 실제 목록 높이, 카드의 최소 높이와 간격으로 계산한다. 창 크기·브라우저 배율·주변 패널이 바뀌면 다시 측정하고, 보고 있던 문제를 포함하는 페이지를 유지한다. 목록 내용이 부모 높이를 늘려 표시 개수가 계속 증가하지 않도록 CSS 크기 격리를 적용한다.

[viewer origin 설정](../src/config/live-report.ts)과 백엔드 설정을 맞춘다. iframe은 API가 제공한 viewer identity를 검증하고, MessageChannel은 session·secret·document token·순서를 확인한다. 다른 문서에서 도착한 메시지가 현재 선택과 위치 상태를 갱신하지 못해야 한다.

초기 연결, 문서 표시 가능 여부, 이슈별 위치 확인은 별개의 상태다. 정상 연결만으로 모든 문제의 위치 확인이 완료됐다고 표시하지 않는다. 표시·전송·수신 한도도 함께 맞춰야 한다. 현재 대량 문제의 한도 불일치는 아래에 기록되어 있다.

| 책임 | 구현 |
|---|---|
| viewer URL·origin 설정 | [src/config](../src/config/) |
| 메시지 변환·검증 | [page-replay-protocol.ts](../src/components/dashboard/panels/site-dashboard/page-replay-protocol.ts) |
| iframe 연결·위치 상태 | [rendered-page-evidence-card.tsx](../src/components/dashboard/panels/site-dashboard/rendered-page-evidence-card.tsx) |
| 격리 문서와 브리지 생성 | [LiveReportDocumentRewriter.java](../../ap-backend/src/main/java/com/accessibility/platform/livereport/LiveReportDocumentRewriter.java) |

## 현재 확인된 프런트 오류

2026-09-05 감사에서 확인했으며 **문서 정리 시점에도 미해결**이다.

| 문제 | 재현과 영향 | 수정 완료 기준 |
|---|---|---|
| 대량 문제의 리포트 초기화 거절 | 이슈 10,001개를 전송하면 브리지가 INIT를 거절한다. sequence도 어긋나 후속 명령이 거절되고, 정상 연결을 유지해도 위치 확인은 완료되지 않는다. | 표시·전송·수신 한도를 맞추고 초과 항목을 명시적으로 처리. 한도 직전·경계·직후와 후속 선택 동작 검증 |
| 추이 차트의 가짜 0점 | 기록 없음은 7개 0점, 실제 80점 한 번은 6개 0점 뒤 80점으로 차트에 전달된다. | 기록 없음, 실제 0점, 한 번·여러 번의 분석을 구분하고 미실측 0점을 연결하지 않음 |

첫 항목의 구현은 위 리포트 카드와 Java 브리지, 두 번째는 [AnalysisTrendPanel](../src/components/dashboard/panels/site-dashboard/analysis-trend-panel.tsx)이다. 실제 송신·수신 함수·API 파서와 실제 컴포넌트의 차트 props를 실행해 확인했다. 리포트 로딩 지속은 상태·타이머 경로를 대조한 결과이며 전체 브라우저 재현은 수행하지 않았다.

전체 시스템 감사의 원본 자료는 작성자 로컬 `artifacts/deep-code-audit/`에만 보관되어 있다. 저장소에 포함되는 증거로 가정하지 않는다. 완료 처리는 기대 동작을 검증한 코드 변경과 함께 한다.

## 오류와 코드 분할

앱·패널·모달의 오류 경계는 해당 범위에서 재시도할 수 있게 한다. 상세 조회 하나의 실패가 다른 자료를 지우지 않아야 한다.

랜딩·대시보드·제품 미리보기, 상세 패널과 모달은 사용 시점에 지연 로딩한다. 정확한 청크와 예산은 [verify-bundle-boundaries.mjs](../scripts/verify-bundle-boundaries.mjs)가 관리한다. 새 분할은 실제 초기 로딩 비용과 사용자 대기 시간을 근거로 결정한다.

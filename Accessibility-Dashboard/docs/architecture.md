# 프런트 아키텍처

현재 상태 소유권과 모듈 간 계약을 설명한다. 실행은 [README](../README.md), 검증은 [테스트 가이드](testing.md)를 참고한다.

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
| 페이지 상세의 분석 결과·최종 리포트 보기 | URL `?view=report` (미리보기는 로컬 상태) | 새로고침, 뒤로 가기, 링크 공유 |
| 서버 snapshot·진행 상태 | `useDashboardData` | 목록과 결과의 일관된 갱신 |
| 모달·입력·선택 이슈 | 해당 컴포넌트/훅 | 짧은 UI 수명 |
| 생성·분석 복구 기록 | `sessionStorage` | 새로고침 후 미확정 작업 확인 |
| 테마·완료 확인 표시 | `localStorage` | 브라우저의 사용자 선택 보조 |
| 상세 캐시·공유 요청 | `services/request-cache.ts`와 조회 훅 | 같은 요청의 중복 조회와 수명 관리 |

저장소의 기록은 서버 데이터의 대체물이 아니다. 최근 분석 링크도 현재 overview에 존재하는 페이지를 기준으로 표시한다.

분석 실패 아이콘은 서버의 선택 필드 `failureCode`를 짧은 한국어 오류 툴팁으로 표시한다. 원인이 저장되지 않은 과거 요청이나 알 수 없는 코드는 일반 실패 문구로 표시하며 원인을 추정하지 않는다. 아이콘은 페이지 이동과 별도 버튼이며 호버·포커스·클릭으로 안내를 열고 Escape로 닫을 수 있다.

최근 분석한 페이지는 서버 요청의 `quickAnalysis` 구분을 기준으로 접수부터 표시한다. 완료 여부나 탭을 열었는지에 의존하지 않으며 새로고침 후에도 복원된다. 이전 로컬 최근 기록은 호환용으로 합치되 페이지별 중복은 제거한다. 프로젝트에서만 분석한 페이지는 최근 목록에 자동 추가하지 않는다.

URL 분석의 저장용 조직은 `systemManaged`로 구분해 프로젝트 목록에서 제외한다. 데이터와 리포트 조회에는 그대로 사용하며 예전 프로젝트 페이지 주소는 최근 페이지 주소로 연결한다. 구형 자동 그룹은 기본 이름·설명·유형이 모두 일치하는 경우에만 인식하고, 이름을 바꿔 쓰는 기존 프로젝트는 유지한다.

주요 경로는 `/`, `/product-preview`, `/analyze`, `/projects/:projectId`, `/projects/:projectId/pages/:pageId`, `/recent-pages/:pageId`다. 실제 라우팅은 [App.tsx](../src/App.tsx)와 [controller](../src/components/dashboard/shared/use-dashboard-controller.tsx)가 기준이다. `/dashboard`는 `/analyze`로 이동한다.

## 대시보드 화면 재사용

[DashboardSurface](../src/components/dashboard/dashboard-surface.tsx)는 [표시 계약](../src/components/dashboard/dashboard-surface.types.ts)의 데이터·선택·탐색·테마만 참조한다. 실제 controller의 전체 반환 타입이나 생성 복구 필드를 요구하지 않는다. `SidebarDemo`는 실제 controller와 작업 함수를 연결하고, `DashboardProductPreview`는 예제 데이터와 로컬 선택을 같은 화면에 연결한다.

`mode: "live"`에서는 작업 함수가 필수이며 `mode: "preview"`에서는 변경 작업과 로그아웃 함수를 받지 않는다. 프로젝트 목록과 상세의 작업 묶음이 null이면 기존 읽기 전용 표시를 사용한다. 프로젝트·페이지 생성 및 복구 모달은 실제 앱의 [DashboardMutationModals](../src/components/dashboard/dashboard-mutation-modals.tsx)가 담당한다. 계정 설정·테마 조절은 공용 화면에 남으며 미리보기의 테마는 사용자 설정에 저장하지 않는다. 모달의 지연 로딩·오류 경계·포커스 수명은 유지한다.

## 대시보드 조회

[useDashboardData](../src/components/dashboard/shared/use-dashboard-data.ts)는 `GET /dashboard/overview`를 받아 화면 모델을 만든다. 진행 중 요청이 있을 때만 요청별 상태를 polling하고, 완료·실패 또는 조회 오류가 발생하면 overview를 다시 가져온다. 숨겨진 탭에서는 polling을 건너뛴다.

URL 분석과 프로젝트 페이지 등록은 요청 ID가 확인되면 입력 또는 모달을 해제한다. 이후 상태 조회는 대시보드 수명으로 계속하며 완료 시 화면을 강제로 이동하지 않는다. 접수·상태 응답은 overview가 반영할 때까지 유지하고, 개별 조회 실패가 다른 요청의 상태 갱신을 막지 않는다. 결과 조회 실패는 다음 분석 접수와 분리한다. 백엔드는 단일 작업자로 순차 실행하며 실제 실행 전에는 `PENDING`, 실행 시작 시 `IN_PROGRESS`로 전환한다.

분석 중인 페이지를 열면 본문 전체에 대기 또는 분석 진행 화면을 표시한다. 이때 결과 카드와 뷰어는 마운트하지 않으며, 재분석 시 이전 뷰어도 해제한다. 해당 페이지의 활성 요청이 끝나면 최신 완료 요청의 결과와 렌더링을 불러온다. 점수 overview 갱신이 늦더라도 이전 요청의 뷰어를 다시 열지 않는다. 다른 페이지의 탐색과 상태 조회는 계속된다.

사이드바의 프로젝트 페이지 탭 오른쪽에 대기·진행·오류·완료 아이콘을 표시한다. 같은 페이지에 여러 요청이 있으면 실행 중, 대기 중 순으로 우선 표시하고, 활성 요청이 없으면 최근 접수한 요청의 결과를 표시한다. 프로젝트 페이지 탭이나 최근 분석한 페이지를 열면 해당 완료 요청 ID를 API scope별로 로컬에 저장해 표시를 지운다. 아이콘은 별도의 버튼이 아니며 이후 새 분석의 완료 표시는 다시 나타난다.

수동 재시도와 mutation 후 갱신은 이전 요청을 취소한다. 늦게 도착한 응답은 현재 요청의 상태를 덮지 못해야 한다. 갱신 실패 시 기존 snapshot을 유지하면서 오류와 재시도를 제공한다.

현재 생성 흐름에는 일시적으로 오래된 overview가 도착할 때 기존 목록을 유지하는 directory recovery lease가 있다. [dashboard-recovery.ts](../src/components/dashboard/shared/dashboard-recovery.ts)는 기준 snapshot과 요청 상태의 역행 여부, lease별 불완전 응답 횟수를 판단한다. `useDashboardData`는 lease의 시작·종료와 fetch·polling·React 상태의 수명을 소유한다. 단순화하려면 서버 응답 일관성과 동시 삭제 시나리오를 먼저 확인해야 한다.

overview 전체 비교는 실제 overview 응답을 받을 때만 수행한다. 개별 요청의 정상 진행 상태 polling마다 전체를 직렬화하지 않는다. 요청의 `updatedAt`은 프로젝트 이름·페이지·결과 전체의 변경 버전이 아니므로, 서버가 집계 응답의 revision을 제공하기 전에는 이를 전체 변경 감지값으로 사용하지 않는다.

생성·분석 작업의 제출 잠금, 작업 식별자, AbortController와 언마운트 정리는 [useMutationOperation](../src/components/dashboard/shared/use-mutation-operation.ts)이 함께 소유한다. 취소 후 새 작업이 시작되면 이전 작업의 완료 처리는 새 잠금을 해제하거나 새 요청을 취소할 수 없다. 새로고침 복구 기록과 서버 결과 확인은 각 생성 흐름에 남는다.

## API 경계

일반 화면 API는 [backend-api.ts](../src/services/backend-api.ts)를 거쳐 [api-contracts.ts](../src/services/api-contracts.ts)에서 검증한다. API base는 `VITE_API_BASE_URL` 또는 `/api`다.

최신 분석 요청 선택은 [evaluation-request-selection.ts](../src/services/evaluation-request-selection.ts)가 소유한다. 결과와 overview의 갱신 순서는 `updatedAt`을 사용하고, 재분석 실패 안내의 최근 접수 시도는 `requestedAt`과 ID로 별도 판단한다. 실패 후 과거 성공 결과를 표시할 때 그 사실과 표시 중인 분석 시각을 안내한다. 실행 중 요청을 먼저 보여주는 사이드바 상태 정책은 별도 책임으로 유지한다.

일반 API는 `{ success, data, message }` 형태를 사용한다. HTTP 2xx라도 실패 envelope나 잘못된 data이면 오류다. ID·URL·enum·점수·날짜뿐 아니라 요청과 결과의 참조 관계를 확인한다. AI가 쓰는 `POST /api/v1/evaluations`는 [별도 ingestion API](../../ap-backend/src/main/java/com/accessibility/platform/integration/controller/AiEvaluationController.java)로 이 일반 envelope 규칙의 대상이 아니다.

주요 조회는 overview, 요청 상태, 선택된 요청의 이슈·캡처·라이브 세션이다. 생성·수정·삭제 endpoint와 필드의 정확한 목록은 HTTP 어댑터와 백엔드 controller가 원본이다. 문서에 두 번째 스키마를 유지하지 않는다.

UI에는 내부 payload 대신 사용자에게 필요한 실패 원인과 재시도 동작을 제공한다. 데이터 없음, 실제 0점, 로딩과 실패를 구분한다.

CV 점수의 `null`은 측정값이 없다는 뜻이며 실제 0점과 구분한다. 새 결과는 `cvStatus`에 `SUCCESS`, `NOT_MEASURED`, `FAILED`를 전달한다. 구형 응답은 두 필드가 없어도 읽을 수 있고, 과거 저장 데이터의 상태가 `null`이면 당시 측정 여부가 확인되지 않은 것이다. 기존 0점을 추정으로 미측정 처리하지 않는다. 텍스트 난이도도 `textStatus`에 `SUCCESS`, `FAILED`를 전달한다. 실패한 텍스트 분석의 점수는 0이 아니라 `null`이며 총점에서 제외된다. 최종 리포트는 실패한 엔진의 문제 수를 0건 대신 검사 실패로 표시하고 그 범위의 문제가 빠졌음을 안내한다.

## 페이지 상세와 캐시

점수 또는 결과 요약이 있는 요청 중 최신 요청을 선택한 뒤 이슈, 캡처 정보, 라이브 세션을 독립적으로 조회한다. 캡처 404는 정상적인 자료 없음이며, 지원하지 않는 라이브 세션 응답은 별도 사용 불가 상태다.

상세 패널의 evidence·rail·반응형 스타일은 `SiteDashboardPanel`이 [page-evidence-layout.css](../src/styles/page-evidence-layout.css)를 로드한다. 패널을 기다리는 동안의 바깥 프레임과 공용 카드의 `@layer base` 테마 우선순위는 `index.css`가 유지한다. 넓은 화면의 열 배치는 상세 CSS의 컨테이너 조건 한 곳에서 결정한다.

[request-cache.ts](../src/services/request-cache.ts)는 TTL·LRU와 공유 중인 요청의 소비자 수, 취소, 제한시간을 담당한다. 각 조회 훅은 캐시 키와 도메인 상태를 결정한다. 라이브 세션의 origin·토큰·만료·갱신 판단도 라이브 세션 훅의 책임이다. 취소된 요청의 늦은 결과를 캐시에 저장하지 않고 로그아웃 때 등록된 요청과 캐시를 정리한다.

새 캐시 계층을 추가하기 전에 이 책임으로 표현할 수 있는지 확인한다. 단순한 파생 값은 별도 state/ref에 중복 저장하지 않는다.

## 생성과 복구

| 흐름 | 현재 계약 | 결과가 불명확할 때 |
|---|---|---|
| 프로젝트 생성 | UUID `Idempotency-Key`와 입력을 저장해 POST | 같은 키와 입력으로 명시적 재시도. ID 확인 후에는 목록 GET만 재시도 |
| 페이지 생성 | 서버 요청 식별자 계약이 아직 없음 | 기존 ID와 입력을 기준으로 제한된 GET 확인. 불명확한 POST를 자동 반복하지 않음 |
| 분석 시작·재분석 | overview의 `analysisProtocolVersion: 1`에서 UUID 접수 키 지원 | 같은 키의 접수 결과를 조회하고, 아직 없으면 같은 키·입력으로 재시도. 구형 서버·복구 기록은 기존 ID 기반 확인 유지 |
| 빠른 URL 분석 | 요청 ID 확인 후 백그라운드 상태 조회로 인계 | 불명확한 접수는 키로 조회·복구하며, 확인된 요청은 결과 열람 없이 입력을 해제 |

프로젝트 생성 API는 같은 키·원본 입력이면 같은 ID, 다른 입력이면 409, 잘못된 UUID이면 400을 반환한다. 원래 입력의 비교값을 보존하므로 이후 이름 변경과도 구분된다. 이 API를 지원하는 백엔드와 프런트를 함께 적용해야 한다.

복구 기록은 version·attempt ID·API scope·시각을 확인한다. 저장값 비교로 오래된 비동기 작업이 새 기록을 덮는 것을 막는다. 프로젝트 생성 기록 v2는 이전 v1을 감지할 수 있도록 저장 키를 유지하며, 구형 기록을 새 요청으로 자동 재실행하지 않는다.

페이지 분석 요청의 정상 접수·응답 유실 복구·이전 기록 재개·실행 중 요청 재사용은 [analysis-request-acceptance](../src/components/dashboard/shared/analysis-request-acceptance.ts)의 poll 저장 전환을 공유한다. 호출 경로가 읽어 둔 rawValue를 비교하고, 저장에 성공한 뒤에만 checkpoint의 저장 기록과 요청 ID를 함께 갱신한다. 사전 확인 중인 재분석은 저장된 기록이 없을 수 있어 기대값 null도 명시적으로 전달한다. 취소 listener와 목록 보호 lease의 수명은 요청 훅이 소유하며, 기존 실행 요청을 찾은 경로는 저장 성공·실패 모두 사전 조회 lease를 해제한다. sessionStorage 비교를 여러 탭 전체의 잠금으로 취급하지 않는다.

기존 페이지 재분석은 사전 GET이 끝난 뒤 POST 직전에 복구 기록을 저장한다. 사전 조회 실패·취소와 확정적인 접수 거절은 다른 페이지의 재분석을 막지 않는다. POST 응답 유실은 접수 여부가 불명확하므로 기존 GET 복구를 유지한다. 이전 클라이언트가 남긴 준비 기록은 기존 페이지의 재분석인지 확인하고 정확히 같은 저장값만 해제하며, 페이지 생성이 일부 완료된 기록은 보존한다.

분석 접수의 `AnalysisSubmission`은 키를 DB 기본키로 저장하며 입력 종류·내용의 해시가 다르면 충돌로 거절한다. 키 삽입, 대상·분석 생성은 같은 트랜잭션에 속한다. 키를 먼저 flush하여 경쟁 요청이 작업을 만들기 전에 차단하고, 실패한 트랜잭션 밖에서 승자의 접수 결과를 읽는다. 분석 실행은 기존 commit 후 예약 정책을 따른다. 키 기록은 자동 만료·삭제하지 않는다. 페이지 생성 POST에는 이 보장이 없으므로 기존 복구를 유지한다.

새 분석은 서버 계약이 확인되면 전체 이력 선조회와 ID 배열 저장을 생략한다. 재분석은 해당 대상의 활성 요청만 먼저 확인한다. 이미 저장된 구형 복구 기록을 서버 키 방식으로 추정 변환하지 않는다. 구형 접수의 10,000개 ID 한도, 저장 공간 부족, 저장소 접근 실패는 구분해 안내한다.

상태 조회도 이 버전에서 최대 100개 ID를 한 번에 읽고 `FOUND`, `NOT_FOUND`, `REMOVED`를 구분한다. 배치 항목의 ID·개수·중복과 요청 참조를 검증한다. 현재 일반 API와 같은 접근 범위를 사용하며 별도 사용자 권한 모델을 추가하지 않는다. 구형 서버에서는 개별 조회를 유지한다. 최대 동시 HTTP 조회는 4개이며 각 응답을 도착하는 대로 반영한다. 반복 미확인은 최대 60초 간격으로 늦추고, 5회 이상·2분 이상 지속되면 자동 조회를 일시 중지한다. 사용자는 상태 확인을 재개할 수 있고, 미확인을 분석 실패나 삭제로 바꾸지 않는다. 명시적인 `REMOVED`만 추적에서 제거한다.

프로젝트 수정·제거와 페이지 제거는 실행 전에 최신 overview로 원하는 변경이 이미 반영됐는지 확인한다. 상태 조회는 5초, PATCH는 15초로 제한하며, 불명확한 PATCH 결과는 GET으로 한 번 더 확인한다. 처리 여부를 확인하지 못하면 모달에 안내하고 취소·Escape를 다시 허용한다. PATCH를 자동 재전송하지 않으며 사용자가 다시 시도하거나 모달을 다시 열어도 먼저 서버 상태를 확인한다. 확인 조회가 실패하면 변경 요청을 보내지 않는다. 대시보드를 떠나면 진행 중 요청을 취소하고 늦은 완료가 화면 이동을 일으키지 않도록 한다. 클라이언트의 대기 중단은 서버 작업 취소를 보장하지 않는다.

프로젝트 삭제 후 이동은 갱신된 목록과 현재 URL을 검사하는 효과가 결정한다. 삭제를 시작했을 때 선택했던 프로젝트를 기준으로 이동하지 않으므로, 대기 중 다른 프로젝트로 이동한 사용자의 현재 경로를 유지한다.

## 라이브 리포트

현재 외부 페이지를 격리한 viewer를 표시한다. 분석 당시 정적 화면과 동일한 내용임을 보장하지 않으며, 캡처 크기와 locator를 현재 문서에 맞춰 해석한다.

뷰어의 Tab 순서는 이슈 마커와 상세 안내의 조작 요소로 제한한다. 원본의 `tabindex`는 변경하지 않는다. 대시보드의 진입 컨트롤이 인증된 브리지로 `FOCUS_REPORT_UI`를 보내고, 뷰어는 Tab·Shift+Tab을 처리해 현재 표시 중인 리포트 컨트롤로 이동한다. 양 끝에서는 `REPORT_FOCUS_EXIT`를 보내 대시보드가 iframe 앞뒤 컨트롤로 이동시킨다. 활성 문서 토큰을 확인하며, 사용자가 이미 다른 곳으로 이동한 경우 늦은 이탈 메시지는 무시한다. 원본 메뉴의 Tab 처리도 차단하지만 기존에 허용된 마우스 탐색과 스크롤은 유지한다.

Shadow DOM 안에서 시작한 키보드 이벤트도 같은 경로로 처리한다. 접근 가능한 하위 iframe은 문서 로드·교체 시 키보드 리스너를 연결한다. 접근할 수 없는 iframe은 포인터 작업이 끝난 뒤 뷰어의 포커스 대기 위치로 복귀시켜 다음 키보드 이동을 처리한다. 원본 속성을 관찰하며 덮어쓰는 observer는 사용하지 않는다. 실제 rewriter 문서와 React 화면 사이에서 양방향 진입·이탈, 원본 포커스 복원 코드, 클릭 후 이동, 빈 마커 목록을 검증한다.

동적 리소스 주소 변환은 바뀐 요소의 속성만 처리한다. 같은 관찰자 호출에 모인 동일 속성 변경은 마지막 값으로 합치며, 새로 추가된 하위 트리만 탐색한다. 스타일시트 텍스트 변경은 별도로 변환한다. 이 처리 범위는 마커 위치 재탐색과 별개이며, [런타임 URL 회귀](../scripts/verify-live-report-runtime-urls.mjs)에서 주소 변환과 반복 탐색 비용을 검증한다.

마커 대상 탐색은 한 번의 갱신 안에서 같은 문서·Shadow root와 선택자의 조회 결과를 공유한다. 단순한 문서 경로에서는 대상에 영향을 주지 않는 속성 변경의 재탐색을 생략하며, 텍스트 내용 대조가 필요한 문제만 다시 확인한다. 자식 구조·ID 변경이나 복잡한 선택자·프레임·Shadow 경로는 보수적으로 전체 대상을 다시 확인한다. 확인 결과가 달라진 대상의 마커만 교체하고 나머지 마커와 선택 상태는 유지한다. 위치 계산은 별도로 계속 수행하므로 이 최적화를 모든 레이아웃 계산의 제거로 해석하지 않는다.

묶음 마커의 구성원은 `Set`으로 관리해 위치 갱신마다 구성원 배열 전체를 반복해서 필터링하지 않는다. 화면에 보여주는 문제 순서는 기존 심각도·ID 정렬을 유지한다. [마커 성능 회귀](../scripts/verify-live-report-marker-performance.mjs)는 실제 Java 뷰어에서 선택자 조회·구성원 연산 수와 대상 교체·선택 복구를 검증한다.

마커는 각 대상 요소의 가로 위치를 유지한다. 같은 줄이라는 이유로 균등 간격으로 옮기지 않으며, 공간이 부족하면 기존 묶음 마커로 문제를 확인할 수 있다. 분석 문장이 저장된 텍스트 문제는 현재 요소의 텍스트·안내 속성과도 대조한다. 순번 경로가 다른 내용을 가리키면 같은 경로 구조에서 순번만 풀어 원문이 일치하는 요소를 찾는다. 공백을 제외한 원문이 20자 이상이고 후보가 하나일 때만 다시 연결하며, 여러 후보가 일치하거나 원문이 없으면 잘못된 요소에 마커를 붙이지 않는다. 문서 내용이 갱신될 때 다시 확인한다. 텍스트 추출기는 숨김 요소를 제거하기 전의 형제 순번을 보존해 분석 경로를 만든다.

마커의 상세 팝오버는 불투명한 배경을 사용한다. iframe 축소와 팝오버의 역배율 확대가 겹칠 때 배경 블러가 패널 바깥에 합성되는 현상을 피하기 위해 `backdrop-filter`를 사용하지 않는다. 묶음 문제를 넘길 때의 높이 고정과 글자 크기 보정은 유지한다. 팝오버는 대상 요소가 아니라 가리킨 칩 바로 아래에 붙고, 공간이 없으면 칩 위, 그것도 없으면 칩 옆에 둔다. 묶음 문제를 넘겨도 기준 칩이 그대로라 팝오버는 움직이지 않고 하이라이트만 이동한다. 팝오버 안을 누르거나 문제를 넘기면 팝오버가 고정되어 포인터가 벗어나도 닫히지 않으며, 바깥 클릭·Escape·다른 마커 선택으로 닫힌다.

시각 검사(CV) 결과처럼 DOM 경로 없이 분석 화면의 좌표만 있는 문제는 좌표 문구를 선택자로 쓰지 않는다. 대시보드는 캡처의 `deviceScaleFactor`로 스크린샷 픽셀을 문서 CSS px로 바꾼 `box`를 보내고, 뷰어는 마커 레이어에 같은 크기의 투명한 좌표 대상을 둔다. 이 대상은 요소와 같은 마커·스크롤·설명창 경로를 사용하며 DOM 변경에 영향을 받지 않는다. 좌표는 분석 당시 배치를 기준으로 하므로 상세 안내에서 ‘분석 당시 좌표에 표시’로 구분한다. 좌표가 없거나 올바르지 않으면 기존처럼 요소 경로 없음으로 보고한다.

요소 자체는 화면에 없지만 사용자에게 전달되는 문제는 속한 요소에 마커를 붙인다. 뷰어는 계산된 스타일로 판단하며 클래스 이름에 의존하지 않는다.

| 대상 | 판정 | 마커 | 사유(`reason`) |
|---|---|---|---|
| 스크린리더 전용 텍스트 | 1px 이하로 잘렸거나 화면 밖으로 밀려남 | 속한 링크·버튼·입력 요소·표(caption)·영역(제목) 또는 가장 가까운 보이는 상위 요소 | `SCREEN_READER_ONLY` + `ownerKind` |
| 투명한 요소 | 투명도 0이지만 크기와 위치가 있음(복구할 수 없는 슬라이드 포함) | 요소 자체의 박스 | `TRANSPARENT_ELEMENT` |
| `visibility:hidden` 요소 | 숨겨졌지만 크기와 위치가 있음 | 요소 자체의 박스 | `HIDDEN_IN_PLACE` |
| 닫힌 탭·메뉴·`<details>` 안 요소 | 숨은 패널을 `aria-labelledby` 탭, `aria-controls`·`href="#id"`·`data-target`으로 가리키는 컨트롤, 또는 닫힌 `<details>`의 `<summary>`가 보임 | 그 컨트롤(점선) | `REVEALED_BY_CONTROL` + `ownerKind` |
| 닫힌 Shadow DOM 안 요소 | 호스트는 보이지만 루트에 들어갈 수 없음. 크기 없는 호스트는 나중에 열린 루트가 붙을 수 있어 제외 | 호스트(점선) | `SHADOW_HOST` |
| 크기가 없는 요소 | 표시 영역 없음(투명하면서 크기도 없는 경우 포함) | 속한 링크·버튼·입력 요소·표·영역 또는 가장 가까운 보이는 상위 요소 | `INVISIBLE_ELEMENT` + `ownerKind` |
| 포커스하면 나타나는 요소 | 숨은 요소 자체가 링크·버튼 등 포커스 가능 요소(본문 바로가기)이거나, 표시 영역 없는 요소의 상위·하위에 그런 링크가 있음(높이 0인 건너뛰기 링크 목록) | ‘문제 위치로 이동’ 때 초점을 옮겨 표시 | `HIDDEN_STATE`, `FOCUS_TO_REVEAL`, 복구 가능 |
| 숨겨진 영역의 요소 | `display:none`·`visibility:hidden`·`hidden`·`content-visibility:hidden`, 표시 영역 없음(닫힌 탭, 접힌 메뉴) | 가장 가까운 보이는 상위 요소. 페이지 면적의 25%를 넘거나 `body`에 닿으면 표시하지 않음. 정확한 위치가 아니므로 점선 마커 | `APPROXIMATE_AREA` + `ownerKind` |
| iframe 안 요소 | 경로에 프레임 단계가 있음. iframe 선택자가 바뀌었으면 저장된 `frameUrl`과 같은 페이지를 불러오는 iframe이 하나일 때 그것을 사용 | 해당 iframe | `FRAME_CONTENT` |
| `aria-hidden`·`inert`이지만 보이는 요소 | 시각적 숨김이 없음 | 요소 자체 | `ASSISTIVE_HIDDEN`, `ASSISTIVE_INERT` |
| 페이지 설정(`<head>` 안, `<html>`) | 화면에 그리지 않음 | 없음 | `UNAVAILABLE`, `DOCUMENT_METADATA` |

캐러셀 슬라이드 안의 요소는 슬라이드 전환으로 보여 주므로 위 판정을 적용하지 않는다. 뷰어가 전환할 수 없는 슬라이드(캐러셀로 인식되지 않은 페이드 슬라이더 등)는 투명하면 투명한 요소로, 그 밖에는 숨겨진 영역의 요소로 다룬다. 슬라이드 전환이나 포커스로 요소를 보여 주지 못하면 그 문제는 이후 숨겨진 영역의 요소(대략적 위치)로 표시한다. 스타일·클래스 변경으로 판정이 바뀌면 해당 문제만 다시 탐색한다. 마커 팝오버는 요소가 아닌 곳에 표시한 이유를 한 줄로 안내한다. 과거 분석의 경로에 캐러셀 검사용 임시 속성(`data-ua-audit-*`)이 남아 있으면 그 속성을 빼고 저장된 슬라이드 순번과 일치하는 요소를 찾는다.

대시보드는 위치 상태를 [locator-labels.ts](../src/components/dashboard/panels/site-dashboard/locator-labels.ts)의 한 분류로 나눠 오른쪽 목록과 리포트가 같은 기준을 쓴다.

| 분류 | 조건 | 표시 |
|---|---|---|
| 페이지에서 확인 가능 | `VISIBLE`, `CONNECTED`, `OFFSCREEN`(숨겨진 영역의 대략적 위치 포함) | 마커 |
| 다른 화면 상태 | 복구 가능한 `HIDDEN_STATE`(슬라이드, 포커스) | ‘다른 화면 상태의 문제’ |
| 페이지 전체 설정 | `DOCUMENT_METADATA` | ‘페이지 전체 설정’ |
| 위치 표시 불가 | 그 밖의 `UNAVAILABLE`·`HIDDEN_STATE`. 분석 이후 사라지거나 내용이 바뀐 요소(`SELECTOR_NOT_FOUND`, `ELEMENT_CONTENT_CHANGED`)도 여기에 속함 | ‘화면에 표시되지 않은 문제’ |

분석 이후 사라지거나 바뀐 요소는 지금 페이지에 없으므로 마커를 붙이지 않는다. 이 문제들은 ‘화면에 표시되지 않은 문제’에 사유와 함께 들어가고, 따로 세어 리포트 안내에 쓴다. 방문마다 바뀌는 동적 영역도 같은 사유가 되어 페이지가 실제로 바뀐 것인지 확실하지 않으므로, 페이지 상단에는 따로 표시하지 않는다. 분석 당시 결과이므로 점수와 문제 수에는 그대로 포함한다. 재분석은 자동으로 요청하지 않는다. 리포트의 ‘위치 표시 불가’ 수치와 필터는 모두 페이지 전체 설정을 포함한다. 위치 목록 카드는 위치 확인이 끝난 뒤 채워지므로 지연 로딩한다.

오른쪽 목록의 카드는 문제가 많아도 한눈에 보이도록 짧게 둔다. 카드에는 심각도·항목 코드·제목과 함께 ‘이유’(뷰어가 전달한 사유)와 ‘위치’(경로의 마지막 요소, 프레임·Shadow DOM 안이면 그 표시, 경로가 없으면 좌표나 분석 문장) 한 줄만 싣고, ‘화면에 표시되지 않은 문제’ 목록 위에는 이유별 건수를 둔다. 전체 설명과 개선 안내는 ‘문제 상세’ 대화상자와 최종 리포트에서 읽는다. ‘문제 상세’ 대화상자는 열 때 지연 로딩하며, 분석 당시 요소 경로, 프레임·Shadow DOM 경로, HTML과 좌표도 제공한다. 대화상자 본문은 키보드로 스크롤할 수 있다. 저장된 HTML은 텍스트로만 렌더링하며, 과거 좌표를 현재 페이지의 정확한 위치로 표시하지 않는다.

위치 보고서는 한 번의 순회로 위치 확인 완료와 분류 목록을 계산하고, 변하지 않은 상태 객체를 유지해 전체 JSON 직렬화 비교를 피한다. 보고 전달은 일반 effect에서 수행하며 문서·세션 동기화와 좌표 측정에 필요한 layout effect는 유지한다. 전체 상태 스냅샷과 분류 계산의 O(N) 비용 자체가 없어진 것은 아니다. 계산 구간은 `node scripts/measure-locator-report.mjs`로 측정하며 React 전체 렌더링 시간과 구분한다.

위치 확인 경로에서 사용하는 열린 Shadow DOM은 별도로 관찰한다. 늦게 생성된 root·요소, 내용 변경과 제거도 기존 위치 갱신 큐로 처리하고, 이슈 재초기화·host 제거·문서 종료 때 관찰자를 해제한다. 상태가 같더라도 미표시 이유가 달라지면 새 이유를 전달한다.

문제 목록의 페이지당 개수는 실제 목록 높이, 카드의 최소 높이와 간격으로 계산한다. 창 크기·브라우저 배율·주변 패널이 바뀌면 다시 측정하고, 보고 있던 문제를 포함하는 페이지를 유지한다. 목록 내용이 부모 높이를 늘려 표시 개수가 계속 증가하지 않도록 CSS 크기 격리를 적용한다.

## 최종 리포트

페이지 상세 상단의 탭으로 분석 결과와 최종 리포트를 전환한다. 선택한 보기는 `?view=report`로 URL에 남고, 읽기 전용 미리보기는 주소를 바꾸지 않고 로컬 상태로 전환한다. 리포트 화면은 처음 열 때 지연 로딩한다.

리포트는 이미 조회한 최신 완료 요청의 이슈, 대시보드 개요의 요청·점수 기록과 뷰어의 위치 보고를 재사용하며 별도 API를 호출하지 않는다. 요약(점수 추이와 지난 분석 대비 변화, 심각도, 검사 범위, 같은 규칙으로 고칠 수 있는 항목을 심각도 가중치와 건수로 정렬한 우선순위)과 KWCAG 항목별 전체 문제를 제공한다. 집계·정렬·필터는 [final-report.ts](../src/components/dashboard/panels/site-dashboard/final-report.ts), 점수 추이는 오른쪽 추이 패널과 같은 [score-trend.ts](../src/components/dashboard/panels/site-dashboard/score-trend.ts)가 소유한다.

KWCAG 33개 항목 현황은 [kwcag-criteria.ts](../src/components/dashboard/panels/site-dashboard/kwcag-criteria.ts)의 항목별 검사 엔진 표로 판정한다. 문제가 있으면 ‘문제 있음’, 검사하는 엔진 중 하나라도 완료했으면 ‘문제 없음’, 검사하는 엔진이 모두 실패·미측정이면 ‘검사 못 함’, 검사하는 엔진이 없으면 ‘직접 확인’이다. 규칙 검사는 완료된 것으로 보고, 텍스트는 `textStatus`, 시각은 `cvStatus`로 판단한다. 엔진 표는 `AI-module`의 `rule-based-analyzer/mapping.js`(axe `runOnly` 태그로 실제 실행되는 규칙과 WCAG 태그 대체 매핑), `text-level-analyzer/text_standard_mapper.py`, `cv-analyzer/cv_runner.py`를 기준으로 하며, 엔진의 매핑을 바꾸면 함께 갱신한다. 5.3.2와 6.5.3은 매핑에 axe 규칙이 있지만 해당 규칙이 실행 태그에 포함되지 않아 ‘직접 확인’이다. 좌표만 있는 시각 검사 결과는 좌표를 CSS 선택자처럼 표시하지 않는다.

시각(CV) 이슈의 `locator.content`는 분석 때 그 위치에 있던 요소의 글자(공백 제거)와 이미지 경로·쿼리다. 뷰어는 `pathSteps`의 요소가 같은 글자와 이미지를 보여줄 때만 마커를 달고, 다르면 `ELEMENT_CONTENT_CHANGED`로 보고한다. `content`가 없는 이전 CV 이슈는 분석 당시 좌표에 표시한다.

이슈의 `exclusionReason`이 `AD`(광고), `DYNAMIC`(두 번 불러올 때 내용이 바뀐 영역) 또는 `POPUP`(열린 채 검사한 레이어 팝업)이면 AI 모듈이 점수 계산에서 뺀다. `AD`와 `DYNAMIC` 이슈는 분석 대상이 아니므로 화면에 출력하지 않는다. 문제 수, 뷰어 마커, 결과 목록, 심각도 분포, KWCAG 항목 현황과 리포트 어디에도 넣지 않는다. `POPUP` 이슈는 점수에서만 빠지고 화면에서는 다른 이슈와 똑같이 위의 모든 곳에 포함한다. 팝업이 닫혀 현재 페이지에서 위치를 찾지 못하면, 다른 이슈와 같은 규칙으로 ‘화면에 표시되지 않은 문제’에 들어간다. 별도의 ‘점수에서 제외된 문제’ 구역은 두지 않는다.

리포트를 보는 동안에도 분석 결과 패널은 마운트된 채 레이아웃을 유지하고 숨겨진다. 라이브 세션과 위치 확인이 계속되므로 리포트의 위치 상태가 갱신되며, ‘페이지에서 보기’는 뷰어를 다시 불러오지 않고 결과 보기로 전환한 뒤 기존 `FOCUS_ISSUE` 경로로 해당 마커를 연다. 위치를 표시할 수 없는 문제는 사유와 저장된 코드 위치를 보여 주고 문제 상세 대화상자를 연다. 인쇄·PDF 저장은 모든 항목을 펼친 리포트만 출력한다.

[viewer origin 설정](../src/config/live-report.ts)과 백엔드 설정을 맞춘다. iframe은 API가 제공한 viewer identity를 검증하고, MessageChannel은 session·secret·document token·순서를 확인한다. 다른 문서에서 도착한 메시지가 현재 선택과 위치 상태를 갱신하지 못해야 한다.

상단 제목은 같은 채널의 `DOCUMENT_TITLE` 이벤트로 라이브 문서의 `document.title`을 받는다. 최대 300자 텍스트만 허용하고 현재 문서 토큰이 일치할 때만 표시한다. 문서 전환 시 이전 제목을 지우며, 수신 전에는 제목을 불러오는 중임을 표시하고 빈 제목은 제목 없음으로 표시한다. 프로젝트 이름이나 주소를 제목 대신 사용하지 않는다. 브리지는 head의 제목 변경을 감시하되 값이 바뀔 때만 전송한다.

검증을 통과한 위치 상태는 [locator-state-batch.ts](../src/components/dashboard/panels/site-dashboard/locator-state-batch.ts)에 이슈별 마지막 값으로 모아 화면 프레임당 한 번의 새 Map으로 반영한다. 상태·사유·복구 가능 여부가 모두 같으면 갱신하지 않는다. 프레임 콜백이 지연될 때는 100ms 타이머로 반영을 시도하며, 탭이 다시 보일 때도 대기 중인 값을 처리한다. 문서 초기화·연결 교체·종료 때 대기 중인 값을 버리고 세대를 바꿔 이미 예약된 이전 콜백이 새 문서에 반영되지 않도록 한다. [상태 일괄 반영 회귀](../scripts/verify-locator-state-batching.mjs)는 실제 React 훅의 대량 수신·타이머 대체·초기화·종료 동작을 검증한다.

원본 리다이렉트 뒤의 최종 본문은 조건을 충족하면 같은 세션의 후속 canonical viewer 또는 mirror GET에서 한 번 재사용한다. 원본이 명시한 `public`·양수 `max-age`와 유효한 신선도, 지원하는 `Vary`, 일치하는 요청 문맥을 확인하며, 요청 쿠키·응답 `Set-Cookie`·Origin 등 재사용을 배제하는 조건이 있으면 기존 조회를 유지한다. URL·origin·연결 검증 규칙은 바꾸지 않는다. 보관 기간은 원본 신선도·세션 만료·기본 5초 중 가장 짧은 값이며, 기본 한도는 전체 64건/64MiB, 세션당 4건/16MiB다. 캐시 미스·만료·한도 초과는 기존 조회로 복귀한다. 구현과 회귀는 [LiveReportRedirectHandoffStore.java](../../ap-backend/src/main/java/com/accessibility/platform/livereport/LiveReportRedirectHandoffStore.java), [LiveReportRedirectHandoffTest.java](../../ap-backend/src/test/java/com/accessibility/platform/livereport/LiveReportRedirectHandoffTest.java)에 둔다.

초기 연결, 문서 표시 가능 여부, 이슈별 위치 확인은 별개의 상태다. 정상 연결만으로 모든 문제의 위치 확인이 완료됐다고 표시하지 않는다. 라이브 뷰어에는 처음 5,000개 이슈만 전송하며 초기 선택·후속 명령·응답 ID 검증도 이 범위를 사용한다. 초과 항목은 응답을 기다리지 않고 표시 한도 초과로 안내하되 전체 문제와 저장된 위치 상세는 유지한다.

폼 차단의 `FORM_BLOCKED` 이벤트는 연결 실패가 아니다. `GET`, `POST`, `DIALOG` 형식을 검증해 수신 순서를 유지하고, 차단 후에도 마커 선택을 계속 처리한다. 기존 폼 차단과 연결 identity 검증은 유지한다.

| 책임 | 구현 |
|---|---|
| viewer URL·origin 설정 | [src/config](../src/config/) |
| 메시지 변환·검증 | [page-replay-protocol.ts](../src/components/dashboard/panels/site-dashboard/page-replay-protocol.ts) |
| iframe 연결·문서 수명·위치 상태 | [use-page-evidence-connection.ts](../src/components/dashboard/panels/site-dashboard/use-page-evidence-connection.ts) |
| 리포트 표시·크기 측정 | [rendered-page-evidence-card.tsx](../src/components/dashboard/panels/site-dashboard/rendered-page-evidence-card.tsx) |
| HTML·리소스 URL 변환과 출력 예산 | [LiveReportDocumentRewriter.java](../../ap-backend/src/main/java/com/accessibility/platform/livereport/LiveReportDocumentRewriter.java) |
| 브리지 설정 직렬화·클래스패스 자산 조립 | [LiveReportBridgeAssets.java](../../ap-backend/src/main/java/com/accessibility/platform/livereport/LiveReportBridgeAssets.java) |
| 브라우저 연결·요청·관찰자 수명 | [bridge-runtime.js](../../ap-backend/src/main/resources/livereport/bridge-runtime.js) |
| 요소 탐색·클러스터 소속·팝오버 표시 | [livereport 자산](../../ap-backend/src/main/resources/livereport/)의 `locator-resolver.js`, `marker-clusters.js`, `popover-view.js` |

브리지 모듈은 의존성을 인자로 받는 팩토리로 조립하며, 기존처럼 하나의 인라인 스크립트로 삽입한다. 외부 자산 요청이나 전역 API를 추가하지 않는다. 선택한 문제와 무관한 요소 교체는 진행 중인 위치 이동을 취소하지 않는다. 선택 대상 교체는 다시 탐색하고, Escape·다른 문제 선택·선택 해제는 이전 비동기 처리가 팝오버를 다시 열지 못하도록 한다.

POST 시작과 종료 시 해당 세션의 리다이렉트 본문을 무효화한다. 진행 중인 POST 개수와 세대를 함께 확인해 POST 전·도중 시작한 GET 응답이 뒤늦게 캐시에 들어가지 못하게 한다. 성공 응답이 유실된 경우도 같은 규칙을 적용하며 다른 세션에는 영향을 주지 않는다.

규칙 기반 설명은 [rule-issue-description.ts](../src/components/dashboard/panels/site-dashboard/rule-issue-description.ts)의 한국어 안내를 사용한다. 엔진의 `axe_rule_id`를 nullable `issue_result.rule_id`에 저장해 API의 `ruleId`로 전달한다. 현재 10개 규칙을 지원하며, 과거 데이터는 정확히 일치하는 첫 줄 도움말만 식별한다. 알 수 없는 규칙은 원문을 유지하고, 한국어로 표시한 항목도 상세 화면에서 영어 원문을 펼칠 수 있다. KWCAG 번호만으로 규칙을 추측하지 않는다.

요청 제한시간과 부모 취소 신호의 연결·정리는 [async-cancellation.ts](../src/services/async-cancellation.ts)의 `createRequestDeadline`이 담당한다. 수정 요청, 대시보드 조회·상태 폴링, 페이지 생성 확인이 이를 공유한다. 재시도 여부와 생성·삭제 결과의 불확실성 판단은 각 복구 흐름이 유지한다.

## 파비콘 표시와 저장

프로젝트 목록과 페이지 상세는 서버가 검증한 `/api/favicons/{sha256}.png|svg`만 표시한다. 외부 URL·누락·캐시 실패는 기본 지구본으로 표시하며 브라우저가 원본 `/favicon.ico`를 다시 내려받지 않는다. 별도 API origin은 공통 API 설정을 따른다.

백엔드는 HTML 256KiB, 아이콘 후보 4개, 후보별 다운로드 64KiB, 요청 5초·전체 조회 10초로 제한한다. 래스터는 실제 디코딩 전 최대 128px를 확인하고 긴 변 최대 64px PNG로 변환한다. 작은 원본은 확대하지 않는다. SVG는 외부 자원·스크립트를 거부하고 64px 표시 크기로 저장한다. 표시 파일은 최대 32KiB, 디스크 캐시는 512개·최대 16MiB이며 재시작 후에도 유지한다. 경로는 `accessibility.favicon.cache-directory`로 지정할 수 있다.

`POST /api/targets/{id}/favicon/refresh`는 분석을 실행하지 않는다. 외부 조회는 DB 트랜잭션 밖에서 수행하고, 조회를 시작한 URL이 여전히 같으며 삭제되지 않은 경우에만 파비콘 필드를 갱신한다. 실패하면 기존 값을 보존한다. 과거 외부 주소나 캐시에서 제거된 아이콘은 이 API로 다시 수집할 수 있다. [파비콘 브라우저 회귀](../scripts/verify-favicons.mjs)는 두 화면의 로딩·실패 표시와 외부 원본 미요청을 검증한다.

## 회귀 검증과 추이 차트

재분석 실패의 작업 간 격리와 삭제 후 현재 경로 보존은 기본 CI의 [재분석 회귀](../scripts/verify-rescan-recovery-isolation.mjs)와 [삭제 회귀](../scripts/verify-directory-mutation-recovery.mjs)가 검증한다. 대량 이슈와 폼 차단은 실제 React 카드와 Java 문서를 연결하는 [리포트 경계 회귀](../scripts/verify-live-report-boundaries.mjs), Shadow DOM과 이유 변경은 [마커 회귀](../scripts/verify-live-report-markers.mjs)가 검증한다.

[추이 차트](../src/components/dashboard/panels/site-dashboard/analysis-trend-panel.tsx)는 최근 기록이 부족하면 앞쪽 빈 구간을 0점 자리로 채워 선 그래프 모양을 유지한다.

기록이 전혀 없으면 차트 대신 빈 상태를 표시한다. 실제 0점은 그대로 표시하고 요약의 문제 수가 없으면 `— / 미확인`으로 표시한다. 툴팁과 읽기용 설명에는 실제 기록만 사용한다.

## 오류와 코드 분할

앱·패널·모달의 오류 경계는 해당 범위에서 재시도할 수 있게 한다. 상세 조회 하나의 실패가 다른 자료를 지우지 않아야 한다.

랜딩·대시보드·제품 미리보기, 상세 패널과 모달은 사용 시점에 지연 로딩한다. 정확한 청크와 예산은 [verify-bundle-boundaries.mjs](../scripts/verify-bundle-boundaries.mjs)가 관리한다. 새 분할은 실제 초기 로딩 비용과 사용자 대기 시간을 근거로 결정한다.

페이지 생성·재분석의 네트워크 실행과 복구 구현은 제출할 때 불러오며, 훅은 취소 신호와 복구 lease의 수명을 소유한다. 상태 조회 구현은 추적할 요청의 첫 조회 때 불러온다. 모듈 로딩 중 취소된 작업은 요청을 보내지 않고, 상태 조회 모듈의 로딩 실패는 안내 후 다음 조회 때 다시 시도한다. 완료된 결과만 열람하는 초기 경로에 이 실행 코드를 포함하지 않는다.

추이 차트는 Recharts의 크기 컨테이너와 기존 전용 tooltip을 직접 사용한다. 한 차트에서 사용하지 않던 범용 테마·범례·컨텍스트 계층을 두지 않는다. 상세 패널의 지연 로딩 경계와 그래프 표시·키보드 접근은 유지한다.

랜딩 영상은 첫 장면(오프닝)을 페이지를 열 때 받고, 나머지는 화면에 가까운 장면만 내려받으며 화면 크기·배율에 따라 해상도를 선택한다. 첫 장면의 세 해상도는 H.264, CRF 26, 최대 8프레임 키프레임 간격, `faststart`로 압축했다. 기존 해상도·프레임 수·길이는 유지해 스크롤 탐색에 사용한다. [랜딩 검증](../scripts/verify-landing-design.mjs)은 초기 1080p 영상 한 개의 전송 예산 3MiB, 각 해상도의 프레임 탐색과 reduced-motion의 영상 미요청을 확인한다.

영상 보간이 목표 프레임에 도달하면 scrub RAF를 멈추고 스크롤·영상 준비·seek 완료·화면 복귀 때 다시 실행한다.

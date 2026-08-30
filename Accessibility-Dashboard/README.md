# Accessibility Dashboard

Vite, React, TypeScript, Tailwind CSS 기반의 접근성 진단 대시보드입니다. 프로젝트와 대상 페이지의 접근성 평가 상태, 점수 추이, 이슈 분포, 최근 스캔 작업을 한 화면에서 확인하고 관리할 수 있습니다.

## 주요 기능

- 프로젝트와 대상 페이지 목록 관리
- 대시보드 요약 지표와 최근 스캔 작업 확인
- 월별 접근성 점수 추이 시각화
- 현재 미해결 이슈의 심각도별 집계
- 이슈 분야별 비율과 분석 유형별 평균 점수 차트
- 페이지 상세 접근성 리포트와 반복 이슈 확인
- 라이트/다크 테마 전환

## 기술 스택

- React 18
- TypeScript
- Vite
- Tailwind CSS
- React Router
- Recharts
- Framer Motion
- Lucide React

## 시작하기

### 요구 사항

- Node.js LTS 권장
- npm

### 설치

```bash
npm install
npx playwright install chromium
```

브라우저 검증은 Playwright Chromium 실행 파일을 사용합니다. Linux CI에서는 시스템 의존성까지 함께 설치하도록 `npx playwright install --with-deps chromium`을 실행합니다.

### 환경 변수

`.env.example`을 참고해 로컬에서만 `.env`를 구성합니다. `.env`는 커밋하지 않습니다.

```bash
VITE_API_BASE_URL=http://localhost:9090/api
VITE_DEV_PROXY_TARGET=
```

`VITE_API_BASE_URL`이 설정되어 있으면 모든 API 요청은 해당 주소를 기준으로 호출됩니다.

`VITE_API_BASE_URL`을 비우면 기본 API 경로는 `/api`입니다. 이 경우 개발 서버에서 백엔드로 프록시하려면 `VITE_DEV_PROXY_TARGET`을 설정합니다.

```bash
VITE_API_BASE_URL=
VITE_DEV_PROXY_TARGET=http://localhost:9090
```

### 개발 서버 실행

```bash
npm run dev
```

기본 주소는 Vite가 출력하는 로컬 URL입니다. 일반적으로 `http://localhost:5173` 또는 `http://127.0.0.1:5173`에서 확인할 수 있습니다.

### 프로덕션 빌드

```bash
npm run build
```

### 번들 분석

```bash
npm run analyze:bundle  # dist/bundle-analysis.json에 청크·모듈별 기여도 기록
npm run test:bundle     # 분석 빌드 + 경로별 JS 예산 및 지연 로딩 경계 검증
```

랜딩과 앱 셸은 서로 다른 지연 로딩 경계이며, 닫힌 설정·프로젝트 생성·페이지 생성 모달도 최초 앱 진입에서 내려받지 않습니다. Recharts는 페이지 상세처럼 차트를 실제로 표시하는 경로에서만 로드되고 `/`, `/analyze`, 프로젝트 상세에서는 제외됩니다. Pretendard는 기존과 동일하게 유지합니다. 제거된 `/dashboard` 주소는 `/analyze`로 이동합니다.

### 빌드 결과 미리보기

```bash
npm run preview
```

## 프론트엔드 테스트

기본 검증은 별도의 개발 서버나 백엔드 없이 실행됩니다. `npm test`가 프로덕션 분석 빌드와 경로별 번들 예산을 먼저 확인하고, `127.0.0.1:41901`에 전용 Vite 서버를 시작한 뒤 API가 격리된 브라우저 검증을 순차 실행하고 서버를 종료합니다.

```bash
npm test                 # 빌드 + CI용 격리 브라우저 검증
npm run test:browser     # 페이지 증거 full 계약을 포함한 전체 격리 브라우저 검증
npm run test:recovery    # Quick Analyze mutex·timeout·reload·SPA 복구 검증
npm run test:visual      # 랜딩 화면 시각 검증
npm run test:replay      # 백엔드 sanitizer 소스와 맞추는 replay 계약 검증
```

개별 `npm run verify:*` 명령도 같은 관리형 runner를 사용하므로 필요한 Vite 서버를 직접 시작하고, 격리된 API fixture를 주입한 뒤 종료합니다. 번들 경계 단독 검증도 항상 새 분석 빌드를 먼저 생성합니다.

기본 포트가 사용 중이면 임의 포트로 우회하지 않고 실패합니다. 필요할 때만 `TEST_PORT`로 명시적으로 바꿉니다.

```bash
TEST_PORT=41911 npm test
```

PowerShell에서는 다음처럼 설정합니다.

```powershell
$env:TEST_PORT = "41911"; npm test
```

실제 백엔드와 연결하는 사이드바 통합 검증은 기본 CI에서 분리되어 있습니다.

```bash
TEST_BACKEND_URL=http://127.0.0.1:9090 npm run test:backend
```

PowerShell에서는 다음처럼 실행합니다.

```powershell
$env:TEST_BACKEND_URL = "http://127.0.0.1:9090"; npm run test:backend
```

### 이전 브라우저 검증 분류

구 API fan-out과 삭제된 재스캔·replay-only 화면을 전제로 하던 검증은 실행 가능한 suite에서 제거했습니다. `verify-partial-result-isolation.mjs`, `verify-rescan-result-retention.mjs`, `verify-site-detail-design.mjs`의 계약은 각각 aggregate overview/API 계약·페이지 증거 full 검증으로 대체되어 폐기했습니다.

`verify-quick-rescan-recovery-guards.mjs`는 삭제된 재스캔 동작을 실행하지 않고, 현재도 유효한 Quick Analyze mutex·timeout·reload·SPA·잘못된 checkpoint 차단 시나리오만 기본 CI, `test:recovery`, `test:browser`에서 검증합니다. `verify-organization-create-frontend-guards.mjs`와 `verify-site-create-guards.mjs`의 중첩 recovery lease 및 모바일·저장소 실패 시나리오는 aggregate overview fixture로 이관하기 전까지 참고 구현으로 보존하며, [scripts/frontend-test-suites.mjs](scripts/frontend-test-suites.mjs)의 migration catalog와 인프라 검증이 상태와 대체 테스트를 강제합니다.

CI fixture는 등록되지 않은 API 호출을 실패 처리하여 실제 DB나 개발자 로컬 데이터로 조용히 빠지는 일을 막습니다. 기본 suite의 request-budget 회귀 검증은 조직·페이지·완료 기록이 많은 fixture에서도 초기 화면이 `GET /api/dashboard/overview`만 사용하고, 조직별 대상 및 완료 요청별 summary/issues/score fan-out을 만들지 않는지 확인합니다. 전체 issues는 페이지 상세 진입 전에는 요청하지 않으며, 진입 후 선택된 최신 완료 요청에 대해서만 가져옵니다. 응답 계약 회귀 검증은 HTTP 200/201이어도 필드 타입·enum·중첩 배열·연관 ID가 잘못되면 렌더링 전에 거부되는지, mutation 결과가 불확실할 때 POST를 반복하지 않고 overview 조회로 복구하는지 확인합니다. overview 회귀 검증은 15초 제한시간, 중단된 background 요청 교체, 오래된 응답 격리, unmount 정리, 오류 후 사용자 재시도까지 확인합니다. 부팅 접근성 검증은 초기 overview가 대기 중일 때 화면 뒤의 대시보드가 `inert`로 키보드와 접근성 트리에서 제외되고, 로딩 상태가 라이브 영역으로 공지되며, 완료 후 키보드 탐색이 다시 열리는지 확인합니다.

테스트 선택자는 버튼·대화상자·입력란의 role과 접근성 이름을 우선 사용합니다. 한국어 레이블 자체가 사용자/접근성 계약인 경우에는 그대로 검증하며, CSS 클래스와 고정 픽셀 비율 검사는 기능 smoke와 분리합니다.

## API 연결

프론트엔드 API 진입점은 [src/config/api.ts](src/config/api.ts)와 [src/services/backend-api.ts](src/services/backend-api.ts)입니다.

- `src/config/api.ts`: API base URL과 경로 조합 담당
- `src/services/backend-api.ts`: HTTP 요청, 응답 envelope 처리, 계약 오류 변환, 대시보드 ViewModel 조립 담당
- `src/services/api-contracts.ts`: overview·이슈·조직·페이지·평가 요청·artifact 응답의 런타임 계약 검증과 안전한 정규화 담당

목 서버는 제거되어 있습니다. 로컬 실행 시 실제 백엔드 API를 실행하거나 Vite 프록시를 사용해야 합니다.

현재 대시보드는 실제 백엔드 API 응답을 기준으로 아래 요청을 사용합니다.

- `GET http://localhost:9090/api/dashboard/overview`: 프로젝트·페이지·요청·점수·최신 이슈 집계
- `GET http://localhost:9090/api/results/requests/{requestId}/issues`: 선택한 페이지 상세 이슈 지연 로딩
- `GET http://localhost:9090/api/results/requests/{requestId}/artifact`: 선택한 페이지 재현 문서

백엔드 성공 응답은 `{ success, data, message }` envelope를 반드시 포함해야 합니다. `success`가 `false`이면 API 에러로 처리하고, `true`여도 `data`를 바로 타입 단언하지 않고 엔드포인트별 런타임 파서로 검증한 뒤 화면용 모델로 변환합니다. 계약이 어긋나면 잘못된 필드 경로와 요청 경로를 포함한 `ApiRequestError`가 렌더링 전에 발생합니다. 페이지 주소는 새로 등록할 때 최대 500자의 절대 `http/https` URL만 허용하며, 기존 DB의 빈 주소는 링크 없이 안전하게 표시합니다. 프로젝트·페이지 생성과 분석 요청 같은 mutation은 각 작업의 전용 API를 사용하고, 성공 후 overview를 다시 불러와 화면 상태를 조정합니다.

초기 overview 요청은 15초 안에 끝나지 않으면 강제로 중단됩니다. 부팅 오버레이를 닫고 모든 대시보드 경로에 오류와 `다시 시도` 동작을 표시하며, 재시도나 mutation 갱신은 이전에 멈춘 요청을 기다리지 않고 새 요청으로 교체합니다.

## 주요 디렉터리

```text
src/
  components/
    dashboard/
      modals/                 # 프로젝트/페이지 생성 모달
      panels/                 # 새 분석, 프로젝트·페이지 상세 패널
      panels/site-dashboard/  # 페이지 상세 화면 위젯
      shared/                 # 공통 훅, 상수, 유틸리티
    ui/                       # 공용 UI 컴포넌트
  config/                     # API 설정
  services/                   # 백엔드 API 어댑터
  types/                      # 접근성 도메인 타입
```

## 아키텍처 메모

- 대시보드 데이터 로딩은 `use-dashboard-data`로 분리되어 있으며, 5초 갱신은 진행 중인 평가 요청이 있을 때만 동작합니다.
- overview에는 이슈 원문·selector·locator를 넣지 않고 최신 이슈 집계만 포함합니다. 전체 이슈는 페이지 상세 진입 시 지연 로딩합니다.
- 프로젝트 생성 폼 상태는 `use-organization-model-create-form`에 격리되어 있습니다.
- 대시보드 차트는 Recharts 기반 위젯으로 분리되어 수동 SVG 계산 부담을 줄였습니다.
- API 에러는 `ApiRequestError`로 표준화되어 HTTP 상태, 요청 경로, 응답 payload를 추적할 수 있으며, 응답 계약 오류는 문제가 된 `data` 필드 경로까지 표시합니다.

## 스크립트

```bash
npm run dev      # 개발 서버 실행
npm run build    # 타입 체크 후 프로덕션 빌드
npm run preview  # 빌드 결과 미리보기
```

## 배포 참고

배포 환경에서는 다음 중 하나를 선택합니다.

- `VITE_API_BASE_URL`을 실제 API 서버 주소로 설정
- 같은 origin에서 `/api` 경로를 백엔드로 라우팅

빌드 산출물은 `dist/`에 생성됩니다.

# Accessibility Dashboard

Vite, React, TypeScript, Tailwind CSS 기반의 접근성 진단 대시보드입니다. 프로젝트와 대상 페이지의 접근성 평가 상태, 점수 추이, 이슈 분포, 최근 스캔 작업을 한 화면에서 확인하고 관리할 수 있습니다.

## 주요 기능

- 프로젝트와 대상 페이지 목록 관리
- 대시보드 요약 지표와 최근 스캔 작업 확인
- 월별 접근성 점수 추이 시각화
- 현재 미해결 이슈의 심각도별 집계
- 이슈 분야별 비율과 분석 유형별 평균 점수 차트
- 페이지 상세 접근성 리포트와 반복 이슈 확인
- 대상 페이지 재스캔 요청
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
```

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

### 빌드 결과 미리보기

```bash
npm run preview
```

## API 연결

프론트엔드 API 진입점은 [src/config/api.ts](src/config/api.ts)와 [src/services/backend-api.ts](src/services/backend-api.ts)입니다.

- `src/config/api.ts`: API base URL과 경로 조합 담당
- `src/services/backend-api.ts`: HTTP 요청, 응답 envelope 처리, 에러 변환, 대시보드 ViewModel 조립 담당

목 서버는 제거되어 있습니다. 로컬 실행 시 실제 백엔드 API를 실행하거나 Vite 프록시를 사용해야 합니다.

현재 대시보드는 실제 백엔드 API 응답을 기준으로 아래 요청을 사용합니다.

- `GET http://localhost:9090/api/requests`
- `GET http://localhost:9090/api/results/requests/{requestId}/summary`

백엔드 응답 envelope의 `success`가 `false`이면 API 에러로 처리하고, `success`가 `true`이면 `data`만 화면용 모델로 변환합니다. 재스캔 API는 아직 연결된 백엔드 엔드포인트가 없으므로 버튼 클릭 시 미지원 안내를 표시합니다.

## 주요 디렉터리

```text
src/
  components/
    dashboard/
      modals/                 # 프로젝트/페이지 생성 모달
      panels/                 # 대시보드, 프로젝트, 리포트, 페이지 상세 패널
      panels/dashboard/       # 대시보드 위젯과 집계 모델
      panels/site-dashboard/  # 페이지 상세 화면 위젯
      shared/                 # 공통 훅, 상수, 유틸리티
    ui/                       # 공용 UI 컴포넌트
  config/                     # API 설정
  services/                   # 백엔드 API 어댑터
  types/                      # 접근성 도메인 타입
```

## 아키텍처 메모

- 대시보드 데이터 로딩과 5초 폴링은 `use-dashboard-data`로 분리되어 있습니다.
- 재스캔 요청과 결과 대기는 `use-evaluation-target-rescan`에서 관리합니다.
- 프로젝트 생성 폼 상태는 `use-organization-model-create-form`에 격리되어 있습니다.
- 대시보드 차트는 Recharts 기반 위젯으로 분리되어 수동 SVG 계산 부담을 줄였습니다.
- API 에러는 `ApiRequestError`로 표준화되어 HTTP 상태, 요청 경로, 응답 payload를 추적할 수 있습니다.

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

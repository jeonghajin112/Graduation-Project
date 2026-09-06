# Accessibility Dashboard

React·TypeScript·Vite 기반 접근성 분석 화면이다. 프로젝트와 페이지를 관리하고 분석 진행 상태, 점수, 문제 목록과 라이브 리포트를 확인한다. 점수 추이는 최근 분석 기록을 사용한다.

## 설치와 실행

이 디렉터리에서 Node.js와 npm을 사용한다. 의존성은 [package.json](package.json)과 잠금 파일을 기준으로 설치한다.

```powershell
npm ci
npm run dev
```

브라우저 검증을 실행할 때는 Chromium도 설치한다.

```powershell
npx playwright install chromium
```

Linux CI에서 시스템 의존성까지 필요하면 `npx playwright install --with-deps chromium`을 사용한다.

## API 연결

[.env.example](.env.example)을 참고해 로컬 `.env`를 만든다. 개발 프록시를 쓰는 설정은 다음과 같다.

```dotenv
VITE_API_BASE_URL=
VITE_DEV_PROXY_TARGET=http://localhost:9090
VITE_LIVE_REPORT_VIEWER_BASE_URL=http://localhost:9090
```

API 서버에 직접 연결하려면 `VITE_API_BASE_URL=http://localhost:9090/api`를 지정한다. 값이 비어 있으면 앱은 같은 origin의 `/api`로 요청한다.

라이브 리포트는 허용된 별도 viewer origin을 사용한다. `VITE_LIVE_REPORT_VIEWER_BASE_URL`과 백엔드의 `LIVE_REPORT_VIEWER_BASE_URL`을 맞춘다. 자세한 연결 계약은 [아키텍처](docs/architecture.md)를 따른다.

로컬 백엔드를 다른 포트(예: 19090)로 실행할 때는 프록시 주소와 viewer 주소를 함께 변경한다. 백엔드의 `LIVE_REPORT_VIEWER_BASE_URL`, `LIVE_REPORT_GATEWAY_BASE_URL`도 실제 포트와 맞춰야 한다. API만 연결되더라도 viewer 포트가 다르면 결과 점수는 보이고 페이지 렌더링은 거부될 수 있다.

## 빌드와 검증

```powershell
npm run build
npm run preview
```

빌드 결과는 `dist/`에 생성된다. `npm run preview`는 빌드 결과를 로컬에서 확인하는 명령이다. 배포 호스트는 `/analyze`, `/projects/...`, `/recent-pages/...` 같은 SPA 경로를 `index.html`로 연결하고 `/api`는 백엔드로 보내거나 빌드 시 API base를 지정해야 한다.

기본 통합 검증은 `npm test`다. 변경 범위에 따른 단위·브라우저·리포트 검증은 [테스트 가이드](docs/testing.md), 번들 분석은 `npm run analyze:bundle`, 번들 경계 검사는 `npm run test:bundle`을 사용한다.

`npm run test:list`로 테스트를 확인하고 `npm run test:run -- --test <파일>`로 필요한 회귀만 실행할 수 있다. 실행별 결과와 로그는 `artifacts/frontend-tests/`에 저장한다.

## 개발 문서

- [문서 색인](docs/README.md)
- [아키텍처](docs/architecture.md)
- [테스트 가이드](docs/testing.md)
- [디자인 시스템](docs/design-system.md)
- [GPT-6 Astra 프런트 개발 기준](docs/engineering.md)
- 현재 확인된 프런트 오류는 [아키텍처](docs/architecture.md)의 해당 절에 기록한다.

`/product-preview`는 fixture를 사용하는 읽기 전용 화면이다. 일반 대시보드의 데이터는 백엔드에서 받는다.

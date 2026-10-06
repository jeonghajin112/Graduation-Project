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

## 배포 설정

프로덕션 빌드(`npm run build`)는 빌드 환경 변수와 로컬 `.env.production` 파일(저장소에 올리지 않음)을 읽는다. 다음 값을 배포 환경에 맞춘다.

| 변수 | 필수 | 설명 |
|---|---|---|
| `VITE_API_BASE_URL` | 아니요 | 기본값 `/api`. 호스트가 같은 origin의 `/api`를 백엔드로 프록시한다. 다른 origin을 쓰면 전체 URL을 지정하고 백엔드 CORS를 맞춘다. |
| `VITE_LIVE_REPORT_VIEWER_BASE_URL` | 예 | 배포된 라이브 리포트 viewer origin(예: `https://viewer.example.com`). 경로·쿼리 없는 https origin이어야 하며 백엔드 `LIVE_REPORT_VIEWER_BASE_URL`과 같아야 한다. |

`VITE_LIVE_REPORT_VIEWER_BASE_URL`은 배포마다 달라 저장소에 넣지 않는다. CI 변수로 주입하거나 추적되지 않는 `.env.production.local`에 둔다.

```powershell
$env:VITE_LIVE_REPORT_VIEWER_BASE_URL = "https://viewer.example.com"
npm run build
```

값이 비었거나 `localhost`·`127.0.0.1`을 가리키거나 https origin이 아니면 `vite.config.ts`가 빌드를 멈춘다. 이 검사가 없으면 번들에 `http://localhost:9090`이 기본값으로 들어가 배포 환경의 viewer 프레임이 모두 거부되고, 점수만 보이고 페이지 렌더링은 나오지 않는다. 로컬 백엔드를 대상으로 일부러 프로덕션 빌드를 만들 때만 `LIVE_REPORT_VIEWER_ALLOW_LOCAL=true`를 함께 지정한다.

`index.html`은 첫 페인트 전에 저장된 테마(`bridge-theme`)를 대시보드 경로에 적용하고, 랜딩 이미지 preload는 `/` 경로에서만 추가한다. `robots.txt`는 대시보드 경로(`/analyze`, `/dashboard`, `/projects/`, `/recent-pages/`)와 `/api/`를 크롤링 대상에서 뺀다.

## 검사와 CI

`npm run lint`(ESLint)와 `npm run typecheck`를 제공한다. GitHub Actions의 [frontend 워크플로](../.github/workflows/frontend.yml)가 lint, 타입 검사, `npm test`, 라이브 리포트 replay suite를 실행한다. 세부 범위는 [테스트 가이드](docs/testing.md)를 따른다.

기본 통합 검증은 `npm test`다. 변경 범위에 따른 단위·브라우저·리포트 검증은 [테스트 가이드](docs/testing.md), 번들 분석은 `npm run analyze:bundle`, 번들 경계 검사는 `npm run test:bundle`을 사용한다.

`npm run test:list`로 테스트를 확인하고 `npm run test:run -- --test <파일>`로 필요한 회귀만 실행할 수 있다. 실행별 결과와 로그는 `artifacts/frontend-tests/`에 저장한다.

## 로컬 녹화·감사 산출물 보관

`npm run record:landing`은 모든 장면의 캡처·인코딩·검증과 요청한 배포용 복사가 성공한 뒤 연속 PNG 프레임만 자동 정리한다. 최종 MP4·WebP, 대표 PNG, 녹화 manifest는 보존한다. `--stills-only`, 실패한 녹화, `--keep-frames`를 지정한 녹화는 프레임을 남긴다. 다시 인코딩할 원본이 필요하면 다음처럼 실행한다.

```powershell
npm run record:landing -- --report-only --keep-frames
```

기존 녹화의 재개는 인코딩된 미디어를 재사용하므로 정리 이후에도 가능하다. 작업 도중 실패하면 프레임을 정리하지 않으며, 해당 녹화 폴더의 `.keep` 파일로도 정리를 막을 수 있다. 실제 서비스 연결과 페이지 ID 등 녹화 입력은 [녹화 스크립트](scripts/record-landing-demo.mjs)의 안내를 따른다.

테스트 runner는 오래된 성공 로그에 보관 정책을 자동 적용한다. `npm run artifacts:clean`으로 대상만 확인하고 `-- --apply`를 붙여 수동 적용할 수 있다. 실패 기록·보고서·DB 백업·임시 스크립트의 보존 범위는 [테스트 가이드](docs/testing.md)를 참고한다. 별도로 만든 감사용 ZIP·빌드 복사본은 이 명령의 대상이 아니므로 작업 종료 후 필요한 자료를 선별해 정리한다.

## 개발 문서

- [문서 색인](docs/README.md)
- [아키텍처](docs/architecture.md)
- [테스트 가이드](docs/testing.md)
- [디자인 시스템](docs/design-system.md)

`/product-preview`는 fixture를 사용하는 읽기 전용 화면이다. 일반 대시보드의 데이터는 백엔드에서 받는다.

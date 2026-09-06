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

## 랜딩 화면 녹화

랜딩의 주소 입력·분석 진행·라이브 리포트·프로젝트 장면은 실제 실행 중인 서비스에서 녹화한다. 프런트와 백엔드, 분석 모듈이 정상 실행 중일 때 기존 페이지 ID를 지정한다. 아래 명령은 해당 URL의 **실제 분석을 한 번 실행**하며, API 응답이나 분석 결과를 예시 데이터로 바꾸지 않는다.

```powershell
$env:BASE_URL = 'http://127.0.0.1:5173'
$env:LANDING_TARGET_ID = '195' # 현재 서비스에 존재하는 녹화 대상 페이지 ID
npm run record:landing -- --publish
```

FFmpeg가 PATH에 있어야 한다. 각 장면의 표시 완료를 확인한 뒤 4K 원본 프레임에서 WebP와 1080p·1440p·4K 영상을 만든다. `--publish`는 네 장면이 모두 준비된 후 `public/landing/scroll-world/`의 UI 이미지·영상만 교체한다. 오프닝은 유지한다. 원본 프레임과 녹화 정보는 `artifacts/landing-recordings/`에 남는다. `--publish`를 생략하면 결과 검토만 가능하며, `--stills-only`는 이미지 확인용이다. 두 경우에도 실제 분석이 실행된다.

분석을 접수하면 입력 화면이 다음 URL을 받을 수 있는 상태로 돌아온다. 녹화기는 사이드바의 최근 페이지를 클릭해 진행 화면을 열고, 접수된 요청이 실제로 완료된 뒤 결과를 촬영한다. 요청 ID도 녹화 정보에 기록한다. 입력 영상까지 저장한 뒤 촬영이 중단되었다면 `LANDING_RECORDING_DIR`에 해당 폴더를 지정하고 `--resume-analysis`로 아직 진행 중인 같은 요청의 촬영을 이어갈 수 있다. 이 옵션은 새 분석을 요청하지 않는다.

교체 후 `npm run verify:landing-design`으로 반응형 화면과 영상 디코딩·탐색을 확인한다.

리포트에서는 실제 마커를 클릭해 설명을 연 뒤 프로젝트 화면으로 이어진다. 별도의 문제 위치 정보 모달은 녹화에 포함하지 않는다. 자동으로 바뀌는 배너 위의 마커를 피하려면 `LANDING_MARKER_ID`에 해당 페이지에서 확인한 실제 문제 ID를 지정한다.

분석이 실패한 경우에는 자동으로 성공 결과를 만들지 않고 녹화를 중단한다. 이미 녹화한 입력·진행 화면에 서비스의 기존 완료 결과를 이어 붙이려면 `LANDING_RECORDING_DIR`을 해당 녹화 폴더의 절대 경로로 지정하고 `npm run record:landing -- --resume-results --publish`를 실행한다. 이 명령은 새 분석을 요청하지 않으며, 녹화 정보에도 기존 완료 결과 사용을 기록한다.

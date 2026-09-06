# 프런트 테스트 가이드

실행 명령은 [package.json](../package.json), suite 구성은 [frontend-test-suites.mjs](../scripts/frontend-test-suites.mjs)가 원본이다. 문서에 테스트 전체 목록이나 개수를 중복 유지하지 않는다.

## 준비

프런트 디렉터리에서 다음을 실행한다.

```powershell
npm ci
npx playwright install chromium
```

관리형 runner가 필요한 Vite 서버를 시작·공유·종료한다. 기본 CI는 API fixture를 사용하며 실행 중인 백엔드가 필요 없다. Linux의 Chromium 시스템 의존성 설치는 `npx playwright install --with-deps chromium`으로 수행한다.

## 이번 변경에 맞는 명령

| 명령 | 범위 |
|---|---|
| `npm run test:list` | suite와 테스트를 JSON으로 조회. 서버·테스트 실행 없음 |
| `npm run test:run -- --test <파일>` | 선택한 CI 테스트만 실행. `--test` 반복 가능 |
| `npm run test:unit -- <테스트 경로>` | 지정한 Vitest 테스트 |
| `npm run test:unit` | 전체 단위 테스트 |
| `npm run build` | TypeScript 검사와 프로덕션 빌드 |
| `npm run test:bundle` | 새 분석 빌드와 번들 경계·예산 검사 |
| `npm test` | 번들 검사 → 전체 단위 테스트 → 격리 CI suite |
| `npm run test:browser` | 브라우저 suite, page evidence의 full 범위 포함 |
| `npm run test:recovery` | 빠른 분석의 복구 시나리오 |
| `npm run test:visual` | 랜딩 시각 검증 |
| `npm run test:replay` | 실제 백엔드 rewriter를 이용한 리포트 회귀 |
| `npm run test:backend` | 실행 중인 실제 백엔드를 사용하는 통합 검증 |

`test:ci`는 `npm test`의 별칭이다. 개별 suite 명령에는 `npm test`의 pretest가 자동으로 붙지 않는다. 이미 실행한 검사와 같은 범위를 이유 없이 반복하지 않는다.

기능별 npm 별칭은 `npm run`으로 확인한다. 먼저 목록을 보고 필요한 테스트를 한 번에 선택할 수 있다.

```powershell
npm run test:list -- --suite ci
npm run test:run -- --test verify-dashboard-request-budget.mjs --test verify-sidebar-route-selection.mjs
npm run test:run -- --suite scale
```

`--test`에는 해당 suite의 파일명 또는 표시명을 지정한다. 여러 선택은 manifest 순서로 실행하고 중복 선택은 한 번만 실행한다. 잘못된 옵션·누락된 값·존재하지 않는 선택은 실행 전에 거절한다. 선택 없이 `test:run`을 호출하면 도움말을 표시한다.

선택 실행에는 `npm test -- ...` 대신 `test:run`을 사용한다. `npm test`는 npm의 pretest로 빌드·단위 검사를 먼저 실행하므로 부분 확인용 명령이 아니다. `--list`와 `--help`는 포트·백엔드 설정이나 Vite 준비 없이 조회할 수 있다. suite 변경은 manifest와 실제 runner 진입점으로 검증한다.

## 검증할 동작

- 순수 로직·파서는 실제 함수를 호출해 정상·누락·잘못된 범위와 참조 관계를 검증한다.
- 화면 테스트는 role과 접근성 이름으로 조작하고 사용자가 보는 결과를 확인한다.
- 생성·분석 흐름은 중복 submit, 응답 유실, 명시적 재시도, reload와 취소를 확인한다. 프로젝트 fixture는 요청 키별 같은 결과를 반환해야 한다.
- 리포트는 실제 메시지 수신과 표시 상태를 확인한다. 프로토콜 한도는 직전·경계·직후 입력으로 검증한다.
- 레이아웃·색상·픽셀 검증은 시각 또는 해당 레이아웃 회귀에 둔다. 일반 기능 검사를 Tailwind 클래스나 DOM 깊이에 결합하지 않는다.

함수명, 변수명, 소스의 `if`문, 특정 Promise 작성 형태를 정규식으로 고정하지 않는다. 회귀를 수정할 때는 기존 기대값의 사용자 의미를 확인하고, 실제 기능을 유지하는 검증으로 바꾼다.

## Fixture와 실제 서버

`ci`, `browser`, `recovery`, `visual`, `scale`은 API를 가로채는 격리 suite다. 공용 fixture의 미등록 API 호출은 실패해야 한다. runner는 개발자 환경의 API base와 프록시 설정이 실제 DB로 연결되지 않도록 자식 프로세스 설정을 주입한다.

리포트 fixture는 `localhost:9090` 뷰어를 사용한다. 로컬 `.env`가 다른 뷰어 포트를 지정한 경우 테스트 명령을 실행하는 셸에서 `$env:VITE_LIVE_REPORT_VIEWER_BASE_URL = "http://localhost:9090"`을 설정한다. 실제 개발 서버의 `.env`는 변경하지 않는다.

`replay`는 실제 Java rewriter를 사용한다. `AP_LIVE_REPORT_FIXTURE_PATH`가 없으면 인접한 백엔드에서 Gradle exporter를 실행한다. 미리 생성한 fixture가 있을 때만 해당 변수를 지정한다.

`backend`는 실제 서버가 필요하다. `/api`를 붙이지 않은 origin을 지정한다.

```powershell
$env:TEST_BACKEND_URL = "http://127.0.0.1:9090"
npm run test:backend
```

이 suite는 실제 데이터의 프로젝트·페이지 ID에 의존한다. 필요한 `SIDEBAR_TEST_*` 입력과 기본값은 [verify-sidebar-browser.mjs](../scripts/verify-sidebar-browser.mjs)를 확인한다. 기본 CI에 포함하지 않는다.

## 포트와 제한시간

| 변수 | 용도 |
|---|---|
| `TEST_PORT` | 기본 41901. 이미 사용 중이면 다른 포트를 명시 |
| `TEST_TIMEOUT_MS` | 파일당 제한시간, 기본 180000ms |
| `TEST_BACKEND_URL` | backend suite의 실제 서버 origin |
| `AP_LIVE_REPORT_FIXTURE_PATH` | replay suite가 사용할 기존 HTML fixture |

```powershell
$env:TEST_PORT = "41911"
npm test
```

`BASE_URL`, `SIDEBAR_TEST_BASE_URL`, `PAGE_EVIDENCE_SCOPE`는 runner가 선택한 suite에 맞춰 주입한다. 개별 테스트에서 다른 기본값을 추가하지 않는다.

## 실패와 완료 판단

실행마다 `artifacts/frontend-tests/<suite>-<고유값>/`에 `results.json`과 테스트별 stdout·stderr 로그를 저장한다. 실행 폴더가 분리되어 이전 결과나 다른 실행을 덮어쓰지 않는다. 기본 출력은 진행·결과와 실패 로그의 끝부분이며, 전체 출력을 실시간으로 보려면 `--verbose`를 붙인다.

```powershell
npm run test:run -- --test verify-sidebar-route-selection.mjs --verbose
```

결과에는 선택한 테스트, 실행 시간, 종료 코드·signal, 로그 파일, 미실행 개수가 남는다. 테스트 상태는 `passed`, `failed`, `timed_out`, `interrupted`, `error`로 구분한다. suite 준비 오류도 최종 보고서에 남으며 실패·시간 초과·중단은 모두 명령 실패로 반환한다. `running`이거나 완료 시각이 없는 보고서를 최종 통과로 해석하지 않는다.

시간 초과나 중단 시 하네스가 시작한 테스트의 프로세스 트리/그룹을 종료한다. 실행한 Vite 서버도 정리한다. 실패한 항목과 미실행 항목을 다시 선택할 명령은 출력에서 확인할 수 있다. 자동 재시도로 실패를 숨기지 않는다.

실패한 테스트의 이름, 실제 입력·출력, 제품 결함인지 환경 문제인지를 기록한다. 전체 검사를 실행하지 않았다면 실행한 범위를 정확히 보고한다. 과거 통과 개수를 현재 검증 결과로 인용하지 않는다.

인프라 검증은 등록·suite 격리·옵션·포트 해석을 확인하며, 실제 프로세스로 출력 보존·실패·시간 초과·중단도 검사한다. 폐기 테스트의 목록과 마이그레이션 이력은 Git에서 확인하며 실행 시 재검사하지 않는다.

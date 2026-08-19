# UNI ACCESS v2 Design Migration

## 범위와 상태

- 기록일: 2026-07-28
- 현재 실행: **Stage 0 문서화 완료 + Stage 1 기반 구현 완료**.
- 이 작업 묶음의 구현 승인 상한: **Stage 0 + Stage 1**.
- Stage 2–6은 순서와 경계만 계획하며 **구현하지 않는다**.
- 정규 목표: [DESIGN.md](./DESIGN.md).
- Git 저장소가 유효하지 않음 → `git restore`/`reset`/`checkout` 미사용. before 스냅샷·SHA256·inverse rollback map으로 복구한다.

## 출처

1. Apple/HIG verified_v2 reference: `C:\Users\hajin\Downloads\DESIGN.md` (verified 2026-07-11).
2. Stage 0 직전 프로젝트 `DESIGN.md` v2.0.
3. 현재 프런트: `src/index.css`, `src/styles/theme-tokens.css`, `src/styles/landing.css`.
4. 현재 공용 UI: `src/components/ui/button.tsx`, `input.tsx`, `sidebar.tsx`.
5. 검증 설정: `package.json`, `tailwind.config.ts`, `vite.config.ts`.

Apple 자료는 apple.com marketing, Apple Store product, HIG documentation chrome라는 서로 다른 증거 영역이다. exact focus/hover/disabled, 범용 semantic status, exact motion/easing은 해당 reference에서 확인되지 않았으므로 `미확인`이다.

## Stage 0 이전 상태 인벤토리

### 기존 문서 보존 기록

Stage 0 직전 `DESIGN.md`의 frontmatter와 핵심 결정:

- `version: "2.0"`, `status: normative-target`, `legacy_code: may-differ`.
- 기본 surface D5 dashboard, 보조 surface D2 landing.
- D5 gap 12–16px, body 14–16px, meta 12–14px, title 24–28px.
- 44px major control, 8px control radius, 18px surface radius.
- `#f5f5f7/#ffffff/#1d1d1f/#6e6e73`, action `#0071e3`, link `#0066cc`.
- dark `#111113/#1c1c1e/#242426`, Pretendard-first, Coral 폐기.
- 56px hero, 980px app pill, Liquid Glass, pure black, decorative blur/shadow/scale 거부.
- 상태 복구, 한국어 typography, WCAG AA, reduced motion, 단계적 migration.

이번 정리는 위 결정을 폐기하지 않고, 출처·채택·거부·로컬 확장과 실제 코드 비교, 보호 범위, rollback 절차를 명시적으로 추가했다.

### 실제 토큰/표현 위치

| 파일 | Stage 0 확인 내용 | v2와의 차이 |
|---|---|---|
| `src/index.css:28-68` | root/dark semantic-like 변수. light foreground `#0f172a`, primary `#0f172a`; dark background `#000000`, card `#0a0a0a`, ring Slate | v2 color, action, off-black와 불일치 |
| `src/index.css:75-131,139-148` | Pretendard 정적 font-face 100–900; body Pretendard/Noto Sans KR/Apple SD Gothic Neo/Malgun Gothic, background `#f6f3ef` | 한국어 우선은 일치, Variable/system stack과 canvas 불일치 |
| `src/index.css:153-180` | dashboard control `clamp(42px,5.1vh,52px)`, account row 44px | 일부 44px 충족; 계정 토큰은 보호 |
| `src/index.css:247-262` | dashboard card radius 28px, light card shadow, blur 18px | 18px/flat D5 목표와 불일치 |
| `src/index.css:1292-1315` | skip link 44px, Coral border/focus | geometry는 일치, focus 역할색 불일치 |
| `src/index.css:1320-1425` | modal overlay blur 8px, radius 24px, drawer shadow, Coral focus | Stage 5 대상. 이번 변경 금지 |
| `src/styles/theme-tokens.css:2-5` | dashboard accent `#ef6a50`, hover `#e85d43`, danger `#dc2626` | action/focus와 danger 역할 혼재 |
| `src/styles/theme-tokens.css:14-52` | light page `#ffffff`, card `#fbfaf7/#f7f7f7`, strong `#171412`, muted `#8a8178`, drawer/header shadow | v2 light canvas/text/flat와 불일치 |
| `src/styles/theme-tokens.css:61-101` | dark page `#000000`, card `#0a0a0a`, nested `#050505`, raised/menu variants, strong/muted gray | pure black 금지와 불일치 |
| `src/styles/landing.css:1-35` | Apple color alias는 v2 값과 대체로 일치. high Coral, SF Pro-first stack 존재 | semantic danger와 Pretendard-first로 후속 정리 필요 |
| `src/styles/landing.css:107-111` | 3px blue focus + 3px offset + surface halo | v2 focus 방향과 일치; contrast 재검증 필요 |
| `src/components/ui/button.tsx:12-36` | Slate variants, shadow, 32/36/40px sizes, 8px radius, Slate focus | 주요 action 44px/action blue/flat 목표와 불일치 |
| `src/components/ui/input.tsx:4-20` | 36px height, 8px radius, shadow, Slate focus ring | 주요 input 44px/flat/action focus와 불일치 |
| `src/components/ui/sidebar.tsx:117` | 8px nav radius, Coral focus variable | Stage 2 대상이며 현재 비대상 |

## 3-way 비교

| 항목 | Apple/HIG verified_v2 | Stage 0 이전 프로젝트 문서 | 현재 구현 | v2 결정 |
|---|---|---|---|---|
| 색상 | `#1d1d1f`, `#6e6e73` | 동일 | Slate/warm neutral 혼재 | 문서 값 채택 |
| 캔버스/표면 | `#f5f5f7`, `#ffffff` | 동일 | `#ffffff`, `#f6f3ef`, `#fbfaf7`, `#f7f7f7` | canvas/surface 의미 토큰으로 통합 |
| 행동/링크 | `#0071e3`, `#0066cc`, dark `#2997ff` | 동일 | landing blue, dashboard Coral, global Slate | blue 역할로 통합 |
| 의미 상태 | 범용 palette `미확인` | danger/warning/success/info local | red/rose/amber/green/blue/Coral 혼재 | 로컬 semantic으로 분류 |
| 타이포그래피 | SF Pro와 Apple web scale | Pretendard-first, D5/D2 scale | global Pretendard, landing SF Pro-first | Pretendard Variable/Pretendard/Noto/system |
| 컨트롤 높이 | 44px large, 36px compact | 주요 44px | 공용 32–40px, 일부 dashboard 44px | 주요 최소 44px |
| 반경 | 8px control, 18px docs card, 980px marketing pill | 8px/18px, pill badge only | 8px/28px/980px/full 혼재 | 8px/18px, pill 역할 제한 |
| focus | capture에서 시각 `미확인` | visible, 3:1 | blue/Coral/Slate 혼재 | 3px action blue + 2px offset 기본 |
| shadow/blur | canonical shadow 없음, 관찰 표면 flat | D5 decorative depth 거부 | card/drawer/header/modal shadow·blur | D5 flat/hairline; 기능성 예외만 |
| dark mode | Apple web pure black | off-black | pure black/near-black | `#111113/#1c1c1e/#242426` |

## 채택·거부·로컬 확장 요약

- **채택:** light canvas/surface, foreground/secondary, blue action/link, 44px 주요 control, 8px/18px radius, flat/content-first, concise/reversible state.
- **거부:** D5 56px hero, 980px CTA pill, Liquid Glass, pure black, SF Pro-first, decorative blur/shadow/scale, Coral action/selected/focus.
- **로컬 확장:** 한국어 우선 stack과 D5 density, off-black dark, semantic statuses, WCAG/keyboard/recovery, 고정 검증 viewport.

## Stage 0 변경

- `DESIGN.md`를 normative source of truth로 명확히 했다.
- verified reference, 이전 문서, 실제 코드의 3-way 비교 및 v2 결정을 추가했다.
- 채택/거부/로컬 확장과 `미확인` 표기 원칙을 명시했다.
- 이 문서에 이전 상태 인벤토리, 단계별 적용/비대상/사전 점검/rollback을 추가했다.
- 이 Stage 0 worker의 write set은 `DESIGN.md`와 `DESIGN-MIGRATION.md`뿐이다. 프런트 코드/CSS, backend, 기능, routing, chart data는 변경하지 않았다.
- 같은 시간대에 다른 작업이 만든 프런트/빌드 산출물 변경은 이 Stage 0의 변경으로 간주하거나 롤백하지 않는다.

## Stage 1 — 기반

### 상태: **완료** (2026-07-28)

Stage 1 worker 구현 범위만 적용. Stage 2–6 미구현. `landing.css` 조건부 항목은 Stage 6 계획으로 유지(미수정).

### 대상

- global semantic tokens: canvas, surface, foreground, muted, action/primary, ring, destructive.
- typography stack과 기본 body 배경/문자색.
- light/dark canvas·surface, off-black dark.
- 공통 `:focus-visible` 기반과 주요 control 44px.
- UI 구조/API를 바꾸지 않는 범위의 공용 Button/Input foundation.

### 변경 파일 (write set)

| 파일 | 요약 |
|---|---|
| `src/index.css` | `:root`/`.dark` semantic 값 v2 매핑; body canvas/text + Pretendard Variable stack; low-specificity global focus-visible 3px/`--ring` + 2px offset; 기존 `@font-face`·변수명 유지 |
| `src/styles/theme-tokens.css` | accent/danger → action/danger alias; page/card/text light·dark → global semantic; pure black page/card 제거; nav selector·shadow geometry 유지 |
| `src/components/ui/button.tsx` | semantic primary/destructive/focus; default/lg/icon `h-11`(44px); sm `h-9`(36px compact); shadow 제거; API 유지 |
| `src/components/ui/input.tsx` | `h-11`/8px; semantic border/bg/text/focus/error; shadow 제거; disabled/file/placeholder 유지 |
| `DESIGN-MIGRATION.md` | 본 Stage 1 결과 기록 |
| `artifacts/design-migration/stage1/*` | before 스냅샷, 해시, 빌드/a11y 로그, 렌더 체크 로그/스크린샷 |

### 실제 before → after (핵심 토큰)

| 토큰/표현 | Before | After |
|---|---|---|
| light `--background` (canvas) | `#ffffff` / body `#f6f3ef` | `#f5f5f7` + body `var(--background)` |
| light surface `--card`/`--popover` | `#ffffff` | `#ffffff` |
| light `--foreground` | `#0f172a` | `#1d1d1f` |
| light `--muted-foreground` | `#64748b` | `#6e6e73` |
| light `--primary` / `--ring` | `#0f172a` / `#94a3b8` | `#0071e3` / `#0071e3` |
| `--destructive` | `#ef4444` | `#d70015` |
| dark canvas/surface | `#000000` / `#0a0a0a` | `#111113` / `#1c1c1e` |
| dark `--foreground` / muted | `#f5f5f5` / `#a3a3a3` | `#f5f5f7` / `#a1a1a6` |
| body font | Pretendard → Noto → Apple SD → Malgun | `"Pretendard Variable", Pretendard, "Noto Sans KR", system-ui, sans-serif` |
| `--dashboard-accent` | `#ef6a50` | `var(--primary, #0071e3)` |
| `--dashboard-danger` | `#dc2626` | `var(--destructive, #d70015)` |
| light page/card/text | white/warm neutrals | canvas/surface/foreground semantic alias |
| Button default/lg/icon | h-9/h-10/h-9 + shadow | h-11 + semantic, no decorative shadow |
| Input | h-9 + shadow + slate focus | h-11 + semantic focus/error, no shadow |

미존재 token: 전역 `--link` / warning / success / info CSS 변수는 Stage 0 코드에 없었으므로 **새 API를 만들지 않음**. light link 역할은 dashboard accent-hover `#0066cc` 및 기존 landing alias에만 간접 존재.

### 사전 점검 (실행)

1. Git 무효 → before 파일 복사: `artifacts/design-migration/stage1/before-*`.
2. baseline `npm run build` **exit 0**.
3. baseline `npm run verify:a11y-p0` **exit 1** (기존 실패: `418 !== 390` viewport assert; Stage 1 원인 아님).
4. 보호 파일 SHA256 before 기록 (`protected-before.txt`).

### 검증 결과

| 명령 | Before exit | After exit | 비고 |
|---|---:|---:|---|
| `npm run build` (`tsc -b && vite build`) | 0 | 0 | 악화 없음 |
| `npm run verify:a11y-p0` | 1 (baseline) | **0** | 동일 스크립트; 실패 악화 없음, after 통과 |
| Playwright token/focus (`:5174`) | — | 0 | light body `#f5f5f7`/`#1d1d1f`; dark `#111113`/`#f5f5f7`; focus outline `3px solid #0071e3` offset 2px; dashboard accent/danger/page/card 확인 |
| 새 의존성 설치 | — | 없음 | 기존 playwright/vite만 사용 |

로그/스크린샷: `artifacts/design-migration/stage1/`.

#### Manager 후속 감사

- Stage 1 산출물 수집 후 `npm run build`와 `npx tsc -b --pretty false`를 다시 실행해 각각 **exit 0**을 확인했다.
- 개발 서버 없이 실행한 `npm run verify:a11y-p0`는 예상대로 `127.0.0.1:5173` 연결 거부로 종료됐다.
- 이어 현재 열려 있던 5173 서버를 대상으로 재실행했을 때 `scripts/verify-accessibility-p0.mjs:218`의 계정 모달 외부 클릭 후 계정 트리거 focus 복원 assertion에서 실패했다. 이는 계정 드롭다운 보호 범위이며 Stage 1 대상 파일이 아니다.
- Stage 1 worker의 동일 검사 통과 로그는 `after-a11y-p0.log`에 보존되어 있고, 네 Stage 1 파일의 current SHA256은 아래 after hash와 일치한다. 보호한 sidebar/controller/landing hash도 worker 전후 및 manager 감사 시점에 동일했다.
- 따라서 Stage 1 foundation은 완료로 유지하되, 현재 동시 작업 상태의 계정 focus 회귀는 해당 파일 소유 작업에서 다시 검증해야 한다. 이 migration에서 수정하거나 롤백하지 않는다.

### 잔존 예외 (의도적 / Stage 2+)

| 위치 | 잔존 | 이유 |
|---|---|---|
| `src/index.css` dark drawer/sidebar/table hardcode `#000000` | pure black class 규칙 | Stage 2 navigation / Stage 3 panel 범위. Stage 1은 foundation token만 |
| `src/index.css` account avatar `#ef6a50` | Coral | 계정 크롬 인접; 계정 드롭다운 보호 범위 침범 금지, 전역 Coral 치환 금지 |
| `button.tsx` `sm: h-9` | 36px | compact 허용 (문서: 보조·비주요 36px) |
| `theme-tokens.css` drawer/header shadow, sidebar active/hover | 기존 값 | selector/navigation/modal/shadow geometry 비대상 |
| 기타 컴포넌트 하드코딩 Coral/slate height | 다수 | Stage 2+; 이번 write set 밖 |
| warning/success/info global vars | 없음 | 기존 API 없음 → 신설 안 함 |

### 보호 범위 증거 (read-before = read-after SHA256)

| 파일 | SHA256 (불변) |
|---|---|
| `src/components/dashboard/sidebar-demo.tsx` | `F67A121B24B379368223C0981E58026956B5F76B10CC971A19748DE06AB504D6` |
| `src/components/dashboard/shared/use-dashboard-controller.tsx` | `E4969E25390E18FE7EA7CC3F1484CE1F7175484488F4426076B9220D59836DB7` |
| `src/styles/landing.css` | `5B2E0CF5B5759D376C0861A4E681754922A036CB37B904C247AC70C902BA483D` |

계정 드롭다운 관련 파일: **열지 않음 / 쓰지 않음**. 변경 목록에 없음.

### 파일별 inverse rollback map

Git 불가 환경. 복구는 before 스냅샷 복사만 사용 (`git restore` 금지).

| 파일 | After SHA256 | Before SHA256 | Inverse 복구 |
|---|---|---|---|
| `src/index.css` | `2156ED70051F1D2EB0B340691E3B988D2A6AEC6ED7B5690CFF659801418A0B7C` | `34B10BBFB7E9F195D80CF1FF8A8733C1A40AE1F67FD2DE1ECE585E6AE7E7743C` | `Copy-Item artifacts/design-migration/stage1/before-src_index.css src/index.css` |
| `src/styles/theme-tokens.css` | `31D74F2266260DCFC356878E2EB38BCF8497EF095D92CA9855FE24F7DC957B57` | `C41DCCF85B1E87464AC85E04065B9D44246CE7CC313B9773DD8F9CE2886AE1C5` | `Copy-Item artifacts/design-migration/stage1/before-src_styles_theme-tokens.css src/styles/theme-tokens.css` |
| `src/components/ui/button.tsx` | `C43671C741AD83AAA3F72548B357CB8DDBC6B3133F0156524B88C3FD3C5746D5` | `636C941597BC1E09F937A62E904ABD1B409D785E4A3CB5AFE5BE55E9F603B22D` | `Copy-Item artifacts/design-migration/stage1/before-src_components_ui_button.tsx src/components/ui/button.tsx` |
| `src/components/ui/input.tsx` | `2CEBF20C17C39A0B618732BD8F547EB673C389ABC6D4CB6DAAB37874EDF57D9F` | `84E0CF4B902E8D9FA5480AE28CB3D4A35EB798BCBBA5AA807C569FBCB25F243E` | `Copy-Item artifacts/design-migration/stage1/before-src_components_ui_input.tsx src/components/ui/input.tsx` |

권장 롤백 순서(최근 파일 우선): `input.tsx` → `button.tsx` → `theme-tokens.css` → `index.css`. 한 파일 복구 후 `npm run build` 재검증. 보호 파일은 롤백 대상 아님.

### 비대상 (유지)

- sidebar/navigation selector와 레이아웃.
- dashboard panel/card/chart의 개별 class와 data.
- modal/form layout과 동작.
- landing composition, animation, hero, CTA geometry (`landing.css` 미수정).
- 모든 보호 파일과 기능 범위, backend, routing, chart data.

### 계획 매핑 (참고, Stage 0과 동일)

| 우선 | 파일 | 계획 매핑 |
|---:|---|---|
| 1 | `src/index.css` | foundation tokens / body / focus — **적용됨** |
| 2 | `src/styles/theme-tokens.css` | dashboard semantic alias — **적용됨** |
| 3 | `src/components/ui/button.tsx` | 44px / action / flat — **적용됨** |
| 4 | `src/components/ui/input.tsx` | 44px / semantic focus — **적용됨** |
| 조건부 | `src/styles/landing.css` | Stage 6까지 보류 — **미적용** |

## Stage 2 — Navigation

### 대상

sidebar/nav의 action, selected, focus, 44px target, 8px radius, hairline 계층.

### 비대상

계정 드롭다운 전체, dashboard data panel, routing, 프로젝트/최근 페이지 기능.

### 사전 점검

keyboard 순서, active route, collapse/responsive, 320–1440 baseline, 보호 파일 diff 0 확인.

### 롤백 포인트

navigation 스타일/구성 파일만 파일 단위 복원. route와 controller에는 손대지 않는다.

## Stage 3 — Dashboard

### 대상

D5 canvas/surface 적용, page spacing/type density, primary action과 상태 표현.

### 비대상

chart data/query/mapping, 프로젝트/최근 페이지 기능, modal/form, landing, 보호 파일.

### 사전 점검

loading/empty/error/success, light/dark, real/sample data 구분, overflow 및 route 회귀.

### 롤백 포인트

panel 단위 스타일 diff를 분리하고 panel별 checkpoint로 복원. controller/data 변경은 허용하지 않는다.

## Stage 4 — Card/Chart

### 대상

18px surface, hairline/flat depth, semantic legend, 색 외 label/pattern, dark/print/PDF legibility.

### 비대상

chart data, domain 계산, API, routing, modal, landing.

### 사전 점검

series/tooltip/legend 값 baseline, color-blind/contrast, resize, print/PDF.

### 롤백 포인트

card 또는 chart presentation 파일별 복원. data/constants/mappers는 수정하지 않는다.

## Stage 5 — Modal/Form

### 대상

44px 주요 input/action, 8px control, 18px dialog, label/error/helper, focus trap/restore/Escape, reversible destructive state.

### 비대상

계정 드롭다운 관련 파일 전부, API payload, submit workflow, validation business rule.

### 사전 점검

open/close focus, keyboard, values preserved on error, busy/double-submit, mobile viewport.

### 롤백 포인트

modal/form presentation 파일별 복원. hook/controller/API 변경이 감지되면 해당 diff를 전부 제외한다.

## Stage 6 — Landing

### 대상

D2 canvas/type, 40–48px Korean hero ceiling, 44px/8px CTA, 18px stage, restrained/reduced motion, honest sample labels.

### 비대상

dashboard, auth/routing/API, 56px/980px/Liquid Glass의 기본 도입.

### 사전 점검

320–1440, Korean line breaks, CTA nowrap/full-width fallback, reduced motion, LCP/asset loading, claims.

### 롤백 포인트

`src/styles/landing.css`와 landing presentation component를 별도 checkpoint로 복원. Stage 1 global token은 되돌리지 않는다.

## 보호 파일과 기능

### 절대 수정 금지

- `src/components/dashboard/sidebar-demo.tsx`
- `src/components/dashboard/shared/use-dashboard-controller.tsx`
- 계정 드롭다운 관련 파일 전부

### 보호 기능

- 컴포넌트 구조와 public API
- API와 routing
- chart data
- 프로젝트 페이지와 최근 페이지 기능
- backend와 프로젝트 외부 디렉터리

## 파일 단위 rollback 절차

1. 작업 전 `git status --short`와 `git diff -- <파일>`을 저장 가능한 작업 기록에 남긴다.
2. 해당 stage의 대상 파일만 한 파일씩 수정한다.
3. 각 파일 후 build/a11y/screenshot 또는 stage별 검증을 수행한다.
4. 실패하면 최근 대상 파일에 한해 `git restore --source=<stage-checkpoint> -- <파일>` 또는 승인된 역패치를 사용한다.
5. 사용자/다른 manager의 기존 변경과 겹치면 restore하지 말고 해당 hunk를 분리해 역패치한다.
6. `git diff --name-only`로 보호 파일과 비대상 파일이 0개인지 다시 확인한다.

현재 작업 공간의 `.git` 디렉터리가 유효한 저장소가 아니라면 `git diff`/`git restore`를 실행할 수 없다. 저장소를 임의 초기화하지 않는다. Stage 1은 사용자 지시에 따라 Git 없이 before 스냅샷(`artifacts/design-migration/stage1/before-*`)과 SHA256 inverse rollback map으로 대체했다.

## 최신 구현 재감사: P1/P2/P3 인수 계약

이 절은 2026-07-28 18:45–18:54 KST의 최신 파일을 기준으로 한다. 위 Stage 0 인벤토리는 역사적 before 기록으로 보존하고, 현재 구현 판정에는 이 절과 완료된 Stage 1 결과를 우선 적용한다.

### 감사 입력, Git, 동시 dirty 증거

- 최초 확인(18:45:43): `DESIGN.md` SHA256 `70879E51F309B01DFA459C6C81358B6B7475F6900A25D6C2E766F25BD7798C5B`, mtime `18:38:33.580`; 당시 `DESIGN-MIGRATION.md` SHA256 `60B9F6B650AFE5E5146DA9C29412959C85C0C78CCE3A2078153AEFD743AB58C8`, mtime `18:40:03.034`. 5초 뒤 값도 같아 DESIGN 입력은 안정적이었다.
- 이후 Stage 1 owner가 `DESIGN-MIGRATION.md`를 18:51:00에 갱신했다. 재독 후 최신 본문을 보존하고 이 절만 추가했다.
- `.git` 저장소가 아니며 초기화하지 않았다. 여기서 `dirty`는 Git 상태가 아니라 관찰 구간의 path+SHA256/mtime 변화다.
- 최초 `src/**` path+SHA256 집합은 79개, aggregate SHA256 `76E734CA0C0C68C40BBCD66E0B641A552D5CBA6021CC57452AF241161896E41F`(18:45:59)였다. 다른 owner 작업 이후 18:54 기준은 79개, `ECD7647D4F08423F8B341D4714D213CB8F1362C66C4C2B97D5867EAD3C48356F`다.

| 관찰 구간 변경 파일 | 최초 SHA256 | 최신 SHA256 | P1 보호 판정 |
|---|---|---|---|
| `src/components/dashboard/panels/dashboard-panel.tsx` | `9D3D0396D6B10D12DCB25EE23FA383FD295370DA74999D9E6B62C303876F55D4` | `5708DAB91F7DA54A56FD81A75723A694A8862E720CA679BAB563F13037A28491` | `/dashboard` 경로에서 사용하는 기본 대시보드 패널 |
| `src/index.css` | `4880CBFCBB31EE115C8C91A2EE4FAFAB730A5A7C037ACB8DCFC47792A8D25117` | `2156ED70051F1D2EB0B340691E3B988D2A6AEC6ED7B5690CFF659801418A0B7C` | 완료된 P1 write set; 추가 작업은 foundation hunk만 |
| `src/styles/theme-tokens.css` | `C41DCCF85B1E87464AC85E04065B9D44246CE7CC313B9773DD8F9CE2886AE1C5` | `31D74F2266260DCFC356878E2EB38BCF8497EF095D92CA9855FE24F7DC957B57` | 완료된 P1 write set |
| `src/components/ui/button.tsx` | `636C941597BC1E09F937A62E904ABD1B409D785E4A3CB5AFE5BE55E9F603B22D` | `C43671C741AD83AAA3F72548B357CB8DDBC6B3133F0156524B88C3FD3C5746D5` | 완료된 P1 write set |
| `src/components/ui/input.tsx` | `84E0CF4B902E8D9FA5480AE28CB3D4A35EB798BCBBA5AA807C569FBCB25F243E` | `2CEBF20C17C39A0B618732BD8F547EB673C389ABC6D4CB6DAAB37874EDF57D9F` | 완료된 P1 write set |

프로필 대시보드 모달과 전용 CSS는 2026-08-11 제거됐다. 계정 메뉴는 설정과 로그아웃만 제공하며, 기본 대시보드는 `/dashboard` 경로에서만 렌더링한다.

### 설치된 디자인 시스템 실체

- `npm.cmd ls --depth=0`: React 18.3.1, Vite 5.4.21, TypeScript 5.9.3, Tailwind CSS/`@tailwindcss/vite` 4.2.1, `tailwind-merge` 3.5.0, `clsx` 2.1.1, `lucide-react` 0.575.0, `framer-motion` 12.34.3, `recharts` 3.8.1.
- Tailwind 연결: `src/index.css:1`의 `@import "tailwindcss"`, `:5-25`의 `@theme inline`, `vite.config.ts:3,23`. `tailwind.config.ts`는 class dark mode, `src/**/*.{ts,tsx}` content, plugin 없음.
- `components.json`은 shadcn schema와 CSS variables/`@/components/ui` alias를 선언하지만 shadcn/Radix package는 설치되어 있지 않다. 현재 공용 UI의 실제 source of truth는 `src/components/ui/**` 로컬 컴포넌트다.
- 전역 CSS는 `main.tsx:5` → `index.css:1-3` → Tailwind + `theme-tokens.css`; D2 CSS는 `hero-section-1.tsx:14` → `landing.css` 순으로 로드된다.

### DESIGN v2와 현행 1:1 매핑

| v2 계약 | 현행 파일·selector/변수/컴포넌트 | 판정 및 phase 경계 |
|---|---|---|
| D5 대시보드 기본값 | D5 root는 `sidebar-demo.tsx:172-179`의 `.bridge-dashboard.theme-light/theme-dark`와 `.dashboard-shell`; `/dashboard`는 `dashboard-route.ts:85-92`에서 `menu: "dashboard"`. 그러나 `App.tsx:52-55`의 `/`는 D2 `HeroDemo`, wildcard는 dashboard shell이며 알 수 없는 path는 `dashboard-route.ts:95-100`에서 `analyze`가 된다. | 디자인 기본 surface와 현재 최초 route는 불일치. routing/API/data는 P1–P3 모두 비대상으로 고정한다. |
| light/dark/system 3상태 | `toggle-theme.tsx:6`의 type; `account-settings-modal.tsx:9-33,81-107`의 3개 radio; `use-dashboard-theme.ts:6-28`의 상태/해석, `30-36`의 저장/`.dark`, `38-53`의 system listener; `index.css:27-71`의 `:root/.dark`. | 실제 설정 modal은 3상태. `ToggleTheme` component 자체는 binary이고 사용처가 검색되지 않았다. UI/API 변경 없이 회귀 검증만 한다. |
| control 8px | `button.tsx:34`, `input.tsx:10`의 `rounded-lg`; `theme-tokens.css:8`의 `--dashboard-sidebar-item-radius: 0.5rem`과 `sidebar.tsx:117`; `index.css:1312` skip link. | shared foundation은 일치. account/sidebar의 `rounded-xl/2xl/full`은 P2에서 역할별 판정한다. |
| large surface 18px | `index.css:963`의 `.recent-scan-card`는 18px. `.dashboard-card`는 `index.css:258-268`에서 28px이고 TSX에도 `rounded-[28px]`가 다수다. | D5 주요 surface는 아직 불일치. P2 대상이며 P1에서 전역 치환 금지. |
| D5 gap 12–16px | `dashboard-panel.tsx:485-492`와 `site-dashboard-panel.tsx:103`의 `gap-3`(12px), `sidebar-demo.tsx:349`의 `py-3/sm:py-4/lg:py-4`(12/16px), 공용 `gap-4`(16px). | 핵심 grid 일부 일치. sidebar `gap-6`, compact 세부 gap은 역할별 예외라 P2에서 확인한다. |
| D5 body 14–16px | Button/Input/Label과 dashboard card 다수의 `text-sm`(14px), skip link `index.css:1315`의 `0.875rem`; global body는 `141-148`에서 font stack/color만 지정. D2 `.uni-landing`은 `landing.css:44`에서 17px. | D5는 14px 중심이나 14–16 전역 scale 변수는 없다. D2 17px는 P1/P2에서 건드리지 않는다. |
| 접근성 | global focus `index.css:150-154` 3px/2px action ring; dashboard skip link `sidebar-demo.tsx:176-177` + `index.css:1302-1325`; dialog focus trap/restore/Escape는 `use-dialog-accessibility.ts`; settings는 labelled radiogroup; `index.css:2117-2131`, `landing.css:2359-2399`은 forced-colors/reduced-motion. | 기반은 있으나 sidebar/settings의 Coral 2px focus, 일부 36/28px control이 남는다. P2에서 44px/focus/color-only와 함께 처리한다. |
| 320/390/768/1024/1440 | D5 shell `sidebar-demo.tsx:179`의 `md:flex-row`, content `:349`의 `px-4/sm:px-7/lg:px-10`; `index.css:445` min 768, modal `1977/1992/2064` max 1023/767/479. D2 `landing.css:1857/1885/1948/2146/2332` max 1279/1023/767/639/359, `:295` min 1440+height 900. `verify-accessibility-p0.mjs:5,19-30,72-83`이 정확한 5개 폭에서 overflow를 검사한다. | 320/390은 별도 breakpoint가 아니라 검증 viewport다. 768/1024 경계 양쪽, 1440 wide layout을 light/dark/system과 함께 확인한다. |

`landing.css:1-35`는 v2 light 색을 `--ora-*`로 보유하지만 high Coral, SF Pro-first가 남아 있다. `:107-112`의 3px focus와 44px CTA는 일치하나 hero 3.5rem(56px) ceiling, CTA 980px pill, pure-black hero는 P3 대상이다.

### P1 → P2 → P3

1. **P1 — foundation 인수/잠금:** 완료된 Stage 1의 정확한 4개 write set과 검증 결과를 인수한다. 새 구현은 하지 않고 최신 SHA256, missing token, shared control 사용처, a11y/build를 재검증해 기준점을 잠근다.
2. **P2 — D5 presentation:** sidebar/navigation, dashboard card/chart, account settings modal/form을 8px control, 18px surface, 12–16px gap, 14–16px body, 44px target, flat/hairline로 정리한다. account/sidebar/dashboard owner가 모두 정지한 뒤 presentation hunk만 수행한다.
3. **P3 — D2 landing:** `landing.css`와 landing presentation만 Pretendard-first, 40–48px hero, 44px/8px CTA, 18px stage, semantic severity, reduced motion에 맞춘다.

P1–P3 공통 비대상은 UI 구조, component public API/props/variant 이름, API, routing, data/query/chart 계산, controller, backend다.

### P1의 정확한 대상·alias·테마 경계

P1 write set은 `src/index.css`, `src/styles/theme-tokens.css`, `src/components/ui/button.tsx`, `src/components/ui/input.tsx` 네 파일뿐이다. 현재 완료 상태를 기준으로 추가 도입할 CSS 변수는 없다. 기존 API를 유지한 정확한 alias는 다음과 같다.

| role | light | dark | 실제 변수/alias |
|---|---:|---:|---|
| canvas | `#f5f5f7` | `#111113` | `--background`; dashboard page/top/content → `var(--background)` |
| surface | `#ffffff` | `#1c1c1e` | `--card`, `--popover`; dashboard card/content-card → `var(--card)` |
| foreground | `#1d1d1f` | `#f5f5f7` | `--foreground`; dashboard strong/primary → `var(--foreground)` |
| secondary text | `#6e6e73` | `#a1a1a6` | `--muted-foreground`; dashboard muted/secondary → `var(--muted-foreground)` |
| action/focus | `#0071e3` | `#0071e3` | `--primary`, `--ring`; `--dashboard-accent: var(--primary, #0071e3)` |
| link | `#0066cc` | `#2997ff` | 전역 신설 없음; light dashboard hover `--dashboard-accent-hover: #0066cc`, D2 `--ora-apple-link/link-dark` |
| on-action | `#ffffff` | `#ffffff` | `--primary-foreground` |
| danger | `#d70015` | `#d70015` | `--destructive`; `--dashboard-danger: var(--destructive, #d70015)` |
| warning/success/info | `#9a6700` / `#047857` / `#0066cc` | DESIGN 값 동일 | 전역 CSS 변수 미도입. 새 public token API는 별도 승인 전 P1에서 만들지 않음 |
| control geometry | 44px / 8px | 동일 | Button default/lg/icon `h-11`, Input `h-11`, 공통 `rounded-lg`; compact Button `sm:h-9` 유지 |
| focus geometry | 3px / 2px offset | 동일 | global `:focus-visible`, Button/Input의 `var(--ring)` |

테마 저장/초기화 경계는 read-only다.

- key는 `bridge-theme` 하나다(`use-dashboard-theme.ts:11,31`).
- SSR/window 없음, key 없음, 또는 `light/dark` 이외 값이면 `system`으로 초기화한다(6-19).
- `system`은 `prefers-color-scheme: dark`를 실시간으로 따른다(25,28,43-52).
- 모든 변경은 `light|dark|system` 문자열을 저장한다(30-32). `removeItem` 기반 물리 초기화는 없다.
- 현재 “초기화”는 settings modal에서 system radio를 선택해 `bridge-theme=system`으로 저장하는 논리 초기화다. key 삭제/default/hydration/storage schema 변경은 P1 비대상이다.

### 바로 실행 가능한 P1 체크리스트

- [ ] 네 P1 파일과 account/settings/dashboard/sidebar owner 정지를 확인한다.
- [ ] 5초 이상 간격으로 DESIGN 문서와 `src/**` path+SHA256 집합을 두 번 기록해 안정성을 확인한다.
- [ ] `.git` 부재를 재확인하되 초기화하지 않는다.
- [ ] `rg -n -- "--(background|card|foreground|muted-foreground|primary|destructive|ring|dashboard-accent|dashboard-danger)" src/index.css src/styles/theme-tokens.css`로 alias 값을 확인한다.
- [ ] `rg -n -F -e "bridge-theme" -e "ThemeMode" -e "setThemeMode" -e "removeItem" src`로 테마 경계를 확인한다.
- [ ] `rg -n -F -e "h-11" -e "rounded-lg" -e "var(--ring)" src/components/ui/button.tsx src/components/ui/input.tsx`로 44px/8px/focus를 확인한다.
- [ ] `npx.cmd tsc -b --pretty false`와 `npm.cmd run build`가 exit 0인지 확인한다.
- [ ] 별도 터미널에서 `npm.cmd run dev -- --host 127.0.0.1` 실행 후 `$env:BASE_URL='http://127.0.0.1:5173'; npm.cmd run verify:a11y-p0`를 실행한다.
- [ ] 320×900, 390×844, 768×900, 1024×900, 1440×900에서 light/dark/system, 200% zoom, 긴 한국어/URL, page/modal overflow를 확인한다.
- [ ] keyboard-only, 첫 Tab skip link, focus order, 3px/2px focus, dialog trap/restore/Escape, radio label/selected, reduced motion을 확인한다.
- [ ] WCAG AA: 일반 텍스트 4.5:1, 큰 텍스트 3:1, UI/focus 3:1, 주요 target 44×44px, color-only 금지를 확인한다.
- [ ] 최종 `src/**` path+SHA256 집합이 잠금 기준과 같고 예상 밖 파일 변화가 0인지 확인한다.

### 이 재감사의 baseline 명령 증거

- `npx.cmd tsc -b --pretty false`: `18:48:36.693` 시작, `18:48:39.790 +09:00` 종료, exit `0`, `3.097s`, 진단 출력 없음.
- `npm.cmd run build`: `18:48:45.335` 시작, `18:48:51.835 +09:00` 종료, exit `0`, `6.5s`.
- build 핵심 출력: prebuild `node scripts/clean-dist.mjs`; Vite `5.4.21`; `2888 modules transformed`; `✓ built in 3.55s`; CSS `168.09 kB`(gzip `28.03 kB`), main JS `331.06 kB`(gzip `107.97 kB`).
- 이 성공은 18:46:55까지 유입된 다른 owner의 Stage 1 변경을 포함한다. 시각/a11y 적합성과 owner 충돌 해소를 단독으로 증명하지 않는다.

### 비-Git rollback 보호

1. exact after SHA256와 owner 정지를 먼저 확인한다.
2. 실패 시 방금 적용한 자기 hunk만 역패치한다. full-file copy는 최신 hash가 자기 적용 직후 hash와 같을 때만 허용한다.
3. 특히 `index.css` foundation 밖의 dashboard/account/modal selector는 복원하지 않는다.
4. 보호 파일 변화, 예상 밖 selector diff, type/build/a11y 실패가 하나라도 있으면 중단하고 파일·selector·전/후 hash·실패 명령을 manager에게 전달한다.

## 최종 인수 재검증 — 2026-07-28

- Git 저장소가 아니어서 `git status`/`git diff`는 실행 불가였고 `.git`을 새로 만들지 않았다. Stage 1 before 스냅샷과 SHA256을 rollback 기준으로 유지한다.
- 동시 작업 중 `sidebar-demo.tsx`와 `use-dashboard-controller.tsx`가 다른 owner에 의해 변경됐다. 이 migration은 두 파일, 계정 드롭다운, `landing.css`, `clean-dist.mjs`를 수정하지 않았다. 위 “보호 범위 증거”의 hash는 Stage 1 적용 시점 기록이며 현재 동시 작업 상태의 hash로 해석하지 않는다.
- 최신 상태에서 `npm run build`와 `npx tsc -b --pretty false`는 모두 exit `0`이다.
- 프로필 대시보드 모달 제거 후 계정 메뉴는 설정·로그아웃 2개 항목으로 축소됐으며, `verify:a11y-p0`에서 키보드 이동·Escape·trigger focus 복원을 검증한다.
- `http://127.0.0.1:5173/analyze`를 `1440×900`, `1024×768`, `768×1024`, `390×844`, `320×700`의 light/dark로 캡처했다. 모든 폭의 문서 수평 overflow는 `0`, 브라우저 warn/error는 `0`, body는 light `rgb(245,245,247)`, dark `rgb(17,17,19)`였다.
- 한국어 제목은 768px 이하에서 줄바꿈되고 390/320에서도 글자 잘림은 보이지 않았다. 좁은 화면은 세로 스크롤로 전체 내용을 제공한다.
- 보호 대상 sidebar의 pure black dark surface, Coral 계정 avatar/자체 focus ring, 28–40px bespoke control은 남아 있다. foundation 전체를 되돌리지 않고 Stage 2 navigation의 owner 합의 후 처리한다.
- 증거: `artifacts/design-migration/stage1/final-audit/`.

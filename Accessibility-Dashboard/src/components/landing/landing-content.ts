/**
 * Landing copy and sample data.
 *
 * Every figure quoted here is taken from the implementation, not from
 * marketing: the analyser weights and thresholds come from `AI-module/README.md`
 * and `run_all.py`, the KWCAG item numbers and names come from
 * `AI-module/rule-based-analyzer/mapping.js` (KWCAG 2.2, 33 items), and the
 * text metrics come from `text-level-analyzer/difficulty_engine.py`.
 *
 * No customer counts, detection rates or institution names are invented.
 */

export const brand = {
  wordmark: "UNI ACCESS",
  purpose: "웹 접근성 문제를 발견 위치와 KWCAG 기준, 권장 수정까지 이어서 보여주는 분석 도구",
} as const;

export const actionLabels = {
  primary: "새 페이지 분석",
  login: "로그인",
} as const;

export const hero = {
  /* Split explicitly so the display line breaks where the meaning breaks. */
  headline: ["찾고, 고치고,", "다시 확인합니다"],
  subcopy:
    "규칙 기반·텍스트 난이도·시각 명암비 분석을 한 번에 실행하고, 발견 위치와 KWCAG 기준, 권장 수정까지 이어서 보여줍니다.",
} as const;

export const navLinks = [
  { href: "#highlights", label: "분석 기능" },
  { href: "#closer", label: "직접 살펴보기" },
  { href: "#story", label: "결과 읽기" },
  { href: "#boundary", label: "검사 범위" },
] as const;

/* ------------------------------------------------------------------ */
/* C. 핵심 기능 하이라이트 — horizontal highlight rail                 */
/* ------------------------------------------------------------------ */

/**
 * Total score composition, taken verbatim from `AI-module/run_all.py` and the
 * weighting table in `AI-module/README.md`.
 */
export const scoreModel = {
  label: "총점 구성",
  weights: [
    { module: "규칙 기반", weight: "50%", basis: "KWCAG 검사항목 감점" },
    { module: "텍스트 난이도", weight: "30%", basis: "난이도 점수 반전" },
    { module: "시각 명암비", weight: "20%", basis: "명도 대비 통과율" },
  ],
  note: "세 모듈의 결과를 가중 합산해 한 페이지의 총점을 냅니다. 등급 구간은 A+ 95점, A 90점, B+ 85점, B 80점, C 70점, D 60점입니다.",
} as const;

export type HighlightVisual = "rule" | "difficulty" | "contrast" | "guide" | "history";

export type Highlight = {
  id: string;
  kicker: string;
  value: string;
  evidenceLabel: string;
  evidence: string;
  visual: HighlightVisual;
};

export const highlights: readonly Highlight[] = [
  {
    id: "rule",
    kicker: "규칙 기반 분석",
    value: "페이지 코드를 읽어 반복 확인이 가능한 항목을 KWCAG 검사항목에 연결합니다.",
    evidenceLabel: "매핑 기준",
    evidence: "KWCAG 2.2 검사항목 33개",
    visual: "rule",
  },
  {
    id: "difficulty",
    kicker: "텍스트 난이도 분석",
    value: "문장을 형태소로 나눠 길이와 어휘 등급을 확인하고 읽기 어려운 문장을 표시합니다.",
    evidenceLabel: "판단 지표",
    evidence: "문장 길이 25어절 · 어절 길이 4.5자 · 고난이도 어휘 40%",
    visual: "difficulty",
  },
  {
    id: "contrast",
    kicker: "시각·명암비 분석",
    value: "화면에 실제로 보이는 글자를 찾아 배경과의 명도 대비를 측정합니다.",
    evidenceLabel: "판정 기준",
    evidence: "AA 4.5:1 · 큰 텍스트 3:1",
    visual: "contrast",
  },
  {
    id: "guide",
    kicker: "개선 가이드",
    value: "이슈마다 권장사항과 수정 전·후 예시를 남겨 다음 작업으로 바로 넘어갑니다.",
    evidenceLabel: "함께 제공",
    evidence: "권장사항 · 예시 코드 · 확인 기준",
    visual: "guide",
  },
  {
    id: "history",
    kicker: "분석 이력",
    value: "같은 페이지를 다시 검사하면 무엇이 해결되고 무엇이 남았는지 비교합니다.",
    evidenceLabel: "비교 단위",
    evidence: "평가 요청 · 분석 모듈 · 이슈 상태",
    visual: "history",
  },
] as const;

/* ------------------------------------------------------------------ */
/* D-1. 직접 살펴보기 — three analysis lenses over one sample page      */
/* ------------------------------------------------------------------ */

export type LensId = "rule" | "difficulty" | "contrast";

export type Lens = {
  id: LensId;
  label: string;
  /* Which block of the sample page the lens marks. */
  target: "media" | "copy" | "link";
  marker: string;
  finding: string;
  criterion: string;
  criterionName: string;
  selector: string;
  reading: string;
  module: string;
};

export const lenses: readonly Lens[] = [
  {
    id: "rule",
    label: "규칙",
    target: "media",
    marker: 'alt=""',
    finding: "대표 이미지에 대체 텍스트가 없습니다",
    criterion: "KWCAG 5.1.1",
    criterionName: "적절한 대체 텍스트 제공",
    selector: "main .hero-visual img",
    reading: "이미지가 전달하는 내용을 대체 텍스트로 읽을 수 없습니다.",
    module: "규칙 기반 분석",
  },
  {
    id: "difficulty",
    label: "난이도",
    target: "copy",
    marker: "34어절",
    finding: "한 문장이 권장 길이를 넘습니다",
    criterion: "KWCAG 5.3.3",
    criterionName: "명확한 지시사항 제공",
    selector: "main .notice p",
    reading: "문장이 길고 어려운 어휘가 많아 내용을 한 번에 이해하기 어렵습니다.",
    module: "텍스트 난이도 분석",
  },
  {
    id: "contrast",
    label: "명암비",
    target: "link",
    marker: "2.6 : 1",
    finding: "링크 글자의 명도 대비가 기준에 미치지 못합니다",
    criterion: "KWCAG 5.4.3",
    criterionName: "텍스트 콘텐츠의 명도 대비",
    selector: "main .notice a.more",
    reading: "배경과 글자가 충분히 구분되지 않아 저시력 사용자가 링크를 찾기 어렵습니다.",
    module: "시각·명암비 분석",
  },
] as const;

export const closerLook = {
  title: "직접 살펴보세요",
  lead: "같은 페이지를 규칙, 난이도, 명암비 관점으로 번갈아 보며 무엇이 어떻게 발견되는지 확인합니다.",
} as const;

/* ------------------------------------------------------------------ */
/* D-2. 분석 과정 스토리텔링 — 발견 → 영향 → 기준 → 수정                */
/* ------------------------------------------------------------------ */

export type StoryStep = {
  id: string;
  index: string;
  kicker: string;
  title: string;
  body: string;
  visual: "locate" | "impact" | "criterion" | "fix";
};

export const storySteps: readonly StoryStep[] = [
  {
    id: "locate",
    index: "01",
    kicker: "발견",
    title: "문제가 있는 요소를 다시 찾을 수 있게 남깁니다",
    body: "화면 경로와 DOM 선택자를 함께 기록해, 결과를 받은 사람이 같은 요소를 바로 열어볼 수 있습니다.",
    visual: "locate",
  },
  {
    id: "impact",
    index: "02",
    kicker: "영향",
    title: "누가 어떤 상황에서 막히는지 먼저 읽습니다",
    body: "이슈를 심각도 숫자로만 두지 않고, 그 요소 때문에 실제로 어떤 이용이 끊기는지 문장으로 설명합니다.",
    visual: "impact",
  },
  {
    id: "criterion",
    index: "03",
    kicker: "기준",
    title: "판단의 근거가 된 KWCAG 검사항목을 붙입니다",
    body: "규칙 기반 분석 결과는 KWCAG 2.2 검사항목에 매핑되어, 어떤 기준으로 문제라고 판단했는지 확인할 수 있습니다.",
    visual: "criterion",
  },
  {
    id: "fix",
    index: "04",
    kicker: "수정",
    title: "고친 뒤 다시 검사해 달라진 항목을 확인합니다",
    body: "권장사항과 수정 전·후 예시를 함께 제공하고, 재검사 결과를 이전 기록과 나란히 비교합니다.",
    visual: "fix",
  },
] as const;

export const story = {
  title: "이슈 하나를 끝까지 읽을 수 있게",
  lead: "발견에서 멈추지 않고, 영향과 기준과 수정까지 같은 흐름에서 이어집니다.",
} as const;

/** Concrete example used by the story visuals. */
export const storyExample = {
  path: ["메인 화면", "소개", "대표 이미지"],
  selector: "main .hero-visual img",
  criterion: "KWCAG 5.1.1",
  criterionName: "적절한 대체 텍스트 제공",
  module: "규칙 기반 분석",
  severity: "심각",
  impact: "화면을 보지 못하는 사용자는 이 이미지가 무엇을 안내하는지 알 수 없습니다.",
  recommendation: "이미지가 전달하는 핵심 내용을 짧고 구체적인 대체 텍스트로 설명합니다.",
  before: '<img src="/campus.jpg" alt="">',
  after: '<img src="/campus.jpg" alt="중앙도서관에서 공부하는 학생들">',
  reviewState: "검토 필요",
} as const;

/**
 * The two-step mapping the rule engine actually performs. The example is the one
 * documented in `AI-module/rule-based-analyzer/adapter.js`
 * (`resolveKwcagIds('image-alt', ['wcag2a', 'wcag111'])`), and the deduction
 * method comes from `scorer.js`.
 */
export const criterionChain = {
  steps: [
    { label: "axe-core 규칙", value: "image-alt" },
    { label: "WCAG 태그", value: "wcag111" },
    { label: "KWCAG 검사항목", value: "5.1.1 적절한 대체 텍스트 제공" },
  ],
  scoring: "항목마다 정해진 심각도와 가중치를 곱해 100점에서 감점합니다.",
} as const;

/* ------------------------------------------------------------------ */
/* E. 자동 분석과 사람 검토의 경계                                      */
/* ------------------------------------------------------------------ */

export const boundary = {
  title: "자동 분석이 찾는 것과,\n사람이 확인해야 하는 것",
  lead: "규칙으로 반복 확인할 수 있는 항목은 자동으로 찾습니다. 목적과 맥락에 따라 달라지는 판단은 사람이 함께 봅니다.",
  automated: {
    label: "자동으로 찾는 항목",
    caption: "코드와 화면에서 같은 방식으로 반복 확인할 수 있는 것",
    items: [
      { criterion: "KWCAG 5.1.1", text: "대체 텍스트가 비어 있는 이미지" },
      { criterion: "KWCAG 5.4.3", text: "기준에 못 미치는 텍스트 명도 대비" },
      { criterion: "KWCAG 6.4.2", text: "빠진 제목과 건너뛴 제목 단계" },
      { criterion: "KWCAG 6.4.3", text: "목적을 알 수 없는 링크 텍스트" },
      { criterion: "KWCAG 6.5.3", text: "이름이 없는 버튼과 입력 요소" },
    ],
  },
  human: {
    label: "사람이 확인할 맥락",
    caption: "목적과 이용 환경에 따라 판단이 달라지는 것",
    items: [
      { criterion: "대체 텍스트의 적절성", text: "채워진 설명이 실제로 이미지의 목적을 전하는지" },
      { criterion: "작업 흐름", text: "키보드만으로 처음부터 끝까지 과업을 마칠 수 있는지" },
      { criterion: "콘텐츠 의미", text: "안내 문장이 대상 이용자에게 이해되는지" },
      { criterion: "보조기술 경험", text: "실제 스크린 리더에서 읽히는 순서와 내용이 맞는지" },
    ],
  },
  note: "자동 분석 결과만으로 웹 접근성 준수를 보장하지 않습니다. 콘텐츠의 맥락과 보조기술 이용 환경은 사람이 함께 검토해야 합니다.",
} as const;

/* ------------------------------------------------------------------ */
/* F. 마무리 CTA와 푸터                                                */
/* ------------------------------------------------------------------ */

export const final = {
  title: "첫 페이지부터 확인해 보세요",
  lead: "주소를 등록하면 규칙·난이도·명암비 분석이 순서대로 실행되고, 결과를 바로 읽을 수 있습니다.",
} as const;

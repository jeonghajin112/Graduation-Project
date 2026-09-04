import { useEffect, useRef, useState } from "react";
import "@/styles/landing-engine.css";
import { RuleVisual, TextVisual, ContrastVisual } from "@/components/landing/landing-engine-visuals";

/**
 * 분석 엔진 소개 + 분석 과정.
 *  - 분석 엔진: 제목과 모듈 카드 3개 (SVG 루프는 화면에 보일 때만 재생)
 *  - 분석 과정: 6단계 레일. 화면에 들어오면 1 → 6 단계가 자동으로 차례로 켜지고(약 7초), 벗어나면 되감겨 다시 들어올 때 재생된다
 *  - 그 아래 총점 구성 · 등급 기준
 * 내용은 AI-module/README.md 와 run_all.py 의 실제 동작을 옮긴 것. 수치를 바꿀 때는 그 문서와 함께 바꿀 것.
 * 900px 이하와 모션 축소 설정에서는 레일을 완료 상태의 정적 목록으로 보여준다.
 */

type Module = {
  id: string;
  kicker: string;
  title: string;
  reads: string;
  judges: string;
  outputs: string;
  facts: readonly string[];
  icon: JSX.Element;
  visual: () => JSX.Element;
};

const iconProps = { width: 22, height: 22, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round" } as const;

const MODULES: readonly Module[] = [
  {
    id: "rule",
    kicker: "규칙 기반 분석", title: "코드가 말하는 것",
    reads: "실제 브라우저로 연 페이지의 DOM",
    judges: "KWCAG 2.2 검사항목 33개 기준으로 감점",
    outputs: "이슈별 항목 · 심각도 · 요소 위치",
    facts: ["axe-core", "대체 텍스트 · 제목 구조 · 버튼 레이블", "숨은 캐러셀 슬라이드까지 검사"],
    visual: RuleVisual,
    icon: (<svg {...iconProps} aria-hidden="true"><path d="M8 4 4 12l4 8" /><path d="m16 4 4 8-4 8" /><path d="m14 4-4 16" /></svg>),
  },
  {
    id: "text",
    kicker: "텍스트 난이도 분석", title: "문장이 읽히는가",
    reads: "본문 문장을 형태소 단위로",
    judges: "문장 길이 · 어절 길이 · 어려운 어휘 비율",
    outputs: "쉽게 고쳐 쓴 문장 제안",
    facts: ["25어절 · 4.5자 · 40% 기준", "위치 의존 표현 탐지", "규칙 + GPT-4o-mini"],
    visual: TextVisual,
    icon: (<svg {...iconProps} aria-hidden="true"><path d="M4 6h16" /><path d="M4 12h10" /><path d="M4 18h13" /></svg>),
  },
  {
    id: "contrast",
    kicker: "시각 명암비 분석", title: "눈에 실제로 보이는가",
    reads: "렌더된 화면의 글자, 이미지 속 글자까지",
    judges: "WCAG 명도 대비 (AA 4.5:1 · 큰 글자 3:1)",
    outputs: "통과하는 색 추천",
    facts: ["KWCAG 5.4.3", "이미지 · 캔버스 텍스트 포함", "화면 이미지는 분석 후 즉시 삭제"],
    visual: ContrastVisual,
    icon: (<svg {...iconProps} aria-hidden="true"><circle cx="12" cy="12" r="8.5" /><path d="M12 3.5v17" /><path d="M12 3.5a8.5 8.5 0 0 1 0 17Z" fill="currentColor" stroke="none" /></svg>),
  },
];

type Step = { id: string; label: string; detail: string; caption: string; icon?: JSX.Element };
const stepIcon = { width: 26, height: 26, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round", strokeLinejoin: "round" } as const;
const STEPS: readonly Step[] = [
  { id: "open", label: "페이지 열기", detail: "Playwright", caption: "실제 브라우저로 페이지를 열어 DOM과 화면을 확보합니다.",
    icon: (<svg {...stepIcon} aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M3 9h18" /><circle cx="6.5" cy="6.5" r=".6" fill="currentColor" /><circle cx="9" cy="6.5" r=".6" fill="currentColor" /></svg>) },
  { id: "rule", label: "규칙 기반", detail: "axe-core · KWCAG", caption: "코드를 검사한 결과를 KWCAG 2.2 검사항목에 매핑해 감점합니다.",
    icon: (<svg {...stepIcon} aria-hidden="true"><path d="M8 4 4 12l4 8" /><path d="m16 4 4 8-4 8" /><path d="m14 4-4 16" /></svg>) },
  { id: "text", label: "텍스트 난이도", detail: "MeCab", caption: "문장을 형태소로 나눠 길이와 어휘 난이도를 잽니다.",
    icon: (<svg {...stepIcon} aria-hidden="true"><path d="M4 6h16" /><path d="M4 12h10" /><path d="M4 18h13" /></svg>) },
  { id: "contrast", label: "시각 명암비", detail: "OCR · WCAG", caption: "화면의 글자를 읽어 배경과의 명도 대비를 판정합니다.",
    icon: (<svg {...stepIcon} aria-hidden="true"><circle cx="12" cy="12" r="8.5" /><path d="M12 3.5v17" /><path d="M12 3.5a8.5 8.5 0 0 1 0 17Z" fill="currentColor" stroke="none" /></svg>) },
  { id: "score", label: "총점 · 등급", detail: "50 / 30 / 20", caption: "규칙 50%, 난이도 30%, 명암비 20%를 합산해 등급을 매깁니다." },
  { id: "report", label: "라이브 리포트", detail: "마커 표시", caption: "찾아낸 문제를 실제 페이지 위의 마커로 보여줍니다.",
    icon: (<svg {...stepIcon} aria-hidden="true"><path d="M12 21s-6-5.2-6-10a6 6 0 0 1 12 0c0 4.8-6 10-6 10Z" /><circle cx="12" cy="11" r="2.2" /></svg>) },
];

const WEIGHTS = [
  { label: "규칙 기반", pct: 50, basis: "KWCAG 감점 점수" },
  { label: "텍스트 난이도", pct: 30, basis: "난이도 점수 (높을수록 좋음)" },
  { label: "시각 명암비", pct: 20, basis: "명도 대비 통과율" },
] as const;

const GRADES = [
  { grade: "A+", from: 95 }, { grade: "A", from: 90 }, { grade: "B+", from: 85 }, { grade: "B", from: 80 },
  { grade: "C", from: 70 }, { grade: "D", from: 60 }, { grade: "F", from: 0 },
] as const;

const STEP_MS = 1200;                      // 단계 하나가 켜져 있는 시간
const PLAY_MS = STEP_MS * STEPS.length;    // 레일 한 바퀴
const clamp = (x: number, a = 0, b = 1) => Math.min(b, Math.max(a, x));

export function LandingEngineSection() {
  const sectionRef = useRef<HTMLElement>(null);
  const processRef = useRef<HTMLDivElement>(null);
  const [staticMode, setStaticMode] = useState(false);
  const [inView, setInView] = useState(false);
  const [flow, setFlow] = useState(0);              // 레일 진행 0..1
  const [score, setScore] = useState(0);            // 5번 단계 점수 카운터
  const [hover, setHover] = useState<number | null>(null);   // 재생이 끝난 뒤 호버/포커스로 펼친 단계

  useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
    const narrow = window.matchMedia("(max-width: 900px)");
    const update = () => setStaticMode(reduce.matches || narrow.matches);
    update();
    reduce.addEventListener("change", update); narrow.addEventListener("change", update);
    return () => { reduce.removeEventListener("change", update); narrow.removeEventListener("change", update); };
  }, []);

  // 화면 안에 있을 때만 SVG 루프 재생
  useEffect(() => {
    const el = sectionRef.current;
    if (!el || typeof IntersectionObserver === "undefined") { setInView(true); return; }
    const io = new IntersectionObserver(([e]) => setInView(e.isIntersecting), { rootMargin: "-10% 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // 레일: 화면에 절반 가까이 들어오면 1 → 6 단계 재생, 벗어나면 되감기
  useEffect(() => {
    if (staticMode) { setFlow(1); return; }
    const el = processRef.current;
    if (!el || typeof IntersectionObserver === "undefined") { setFlow(1); return; }
    let raf = 0;
    const stop = () => { if (raf) cancelAnimationFrame(raf); raf = 0; };
    const play = () => {
      stop();
      const t0 = performance.now();
      const tick = (t: number) => { const k = clamp((t - t0) / PLAY_MS); setFlow(k); raf = k < 1 ? requestAnimationFrame(tick) : 0; };
      raf = requestAnimationFrame(tick);
    };
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) play(); else { stop(); setFlow(0); setHover(null); } }, { threshold: 0.45 });
    io.observe(el);
    return () => { io.disconnect(); stop(); };
  }, [staticMode]);

  const active = flow <= 0 ? -1 : Math.min(STEPS.length - 1, Math.floor(flow * STEPS.length));
  const played = flow >= 1;                                   // 한 바퀴 끝: 이후에는 호버로 단계를 고른다
  const focus = played && hover !== null ? hover : active;    // 펼쳐 보이는 카드

  // 총점 단계가 켜지면 0 → 84.8 로 카운트
  useEffect(() => {
    if (active < 4) { setScore(0); return; }
    let raf = 0; const t0 = performance.now();
    const tick = (t: number) => { const k = Math.min(1, (t - t0) / 900); const e = 1 - Math.pow(1 - k, 3); setScore(+(84.8 * e).toFixed(1)); if (k < 1) raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active]);

  return (
    <section className={`ua-engine${inView ? " is-live" : ""}${staticMode ? " is-static" : ""}`} id="engine" aria-labelledby="ua-engine-title" ref={sectionRef}>
      <div className="ua-engine__inner">
        <header className="ua-engine__head">
          <span className="ua-engine__eyebrow">분석 엔진</span>
          <h2 className="ua-engine__title" id="ua-engine-title">세 개의 분석기가 한 페이지를 세 번 읽습니다</h2>
          <p className="ua-engine__lead">주소 하나를 넣으면 코드, 문장, 화면 세 관점에서 검사하고 결과를 하나의 총점으로 합칩니다. 규칙으로 잡히는 것만 보지 않고, 사람이 실제로 읽고 볼 수 있는지까지 봅니다.</p>
        </header>

        <div className="ua-engine__modules">
          {MODULES.map((m) => (
            <article className="ua-engine__module" key={m.id} aria-labelledby={`ua-engine-${m.id}`}>
              <div className="ua-engine__module-media"><m.visual /></div>
              <div className="ua-engine__module-text">
                <div className="ua-engine__module-top">
                  <span className="ua-engine__module-icon">{m.icon}</span>
                  <span className="ua-engine__module-kicker">{m.kicker}</span>
                </div>
                <h3 className="ua-engine__module-title" id={`ua-engine-${m.id}`}>{m.title}</h3>
                <dl className="ua-engine__module-body">
                  <div><dt>읽는 것</dt><dd>{m.reads}</dd></div>
                  <div><dt>판단 기준</dt><dd>{m.judges}</dd></div>
                  <div><dt>남기는 것</dt><dd>{m.outputs}</dd></div>
                </dl>
                <ul className="ua-engine__facts">{m.facts.map((f) => <li key={f}>{f}</li>)}</ul>
              </div>
            </article>
          ))}
        </div>
      </div>

      <div className="ua-engine__process" ref={processRef} role="region" aria-labelledby="ua-process-title">
        <div className="ua-engine__stage">
          <header className="ua-engine__head ua-engine__head--process">
            <span className="ua-engine__eyebrow">분석 과정</span>
            <h2 className="ua-engine__title" id="ua-process-title">주소 하나가 리포트가 되기까지</h2>
          </header>

          <div className="ua-engine__progress" aria-hidden="true">
            <i className="ua-engine__progress-fill" style={{ transform: `scaleX(${flow.toFixed(3)})` }} />
          </div>

          <ol className={`ua-engine__rail${played ? " is-played" : ""}`} aria-label="분석 단계">
            {STEPS.map((step, i) => {
              const done = played ? i !== focus : i < active;
              const state = i === focus ? " is-active" : done ? " is-done" : "";
              return (
                <li key={step.id} className={`ua-engine__step${state}`} aria-current={i === focus ? "step" : undefined}
                  tabIndex={played ? 0 : -1} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(i)} onBlur={() => setHover(null)}>
                  <span className="ua-engine__step-num" aria-hidden="true">{String(i + 1).padStart(2, "0")}</span>
                  <div className="ua-engine__step-top">
                    {step.id === "score" ? (
                      <span className="ua-engine__step-score" aria-hidden="true"><b>{played || active >= 4 ? score.toFixed(1) : "—"}</b><small>점</small></span>
                    ) : (
                      <span className="ua-engine__step-icon">{step.icon}</span>
                    )}
                    <span className="ua-engine__step-badge" aria-hidden="true">
                      {done ? (<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="m5 12 5 5 9-10" /></svg>) : i + 1}
                    </span>
                  </div>
                  <span className="ua-engine__step-label">{step.label}</span>
                  <span className="ua-engine__step-detail">{step.detail}</span>
                  <span className="ua-engine__step-caption">{step.caption}</span>
                </li>
              );
            })}
          </ol>
        </div>
      </div>

      <div className="ua-engine__after">
        <ScoreBreakdown />
        <p className="ua-engine__limit">
          자동 검사는 반복 확인이 가능한 항목을 빠짐없이 찾는 데 강하고, 문맥과 의미 판단은 사람의 몫으로 남깁니다.
          그래서 결과는 점수로 끝나지 않고, 실제 페이지 위에 마커로 표시되는 라이브 리포트로 이어집니다.
        </p>
      </div>
    </section>
  );
}

/** 총점 구성 + 등급 기준 */
export function ScoreBreakdown() {
  return (
    <div className="ua-engine__score">
      <div className="ua-engine__score-formula">
        <span className="ua-engine__score-kicker">총점 구성</span>
        <div className="ua-engine__bar" role="img" aria-label="총점은 규칙 기반 50%, 텍스트 난이도 30%, 시각 명암비 20%로 합산됩니다">
          {WEIGHTS.map((w) => (
            <span className={`ua-engine__bar-seg ua-engine__bar-seg--${w.pct}`} key={w.label} style={{ flexBasis: `${w.pct}%` }}>
              <b>{w.pct}%</b><span>{w.label}</span>
            </span>
          ))}
        </div>
        <ul className="ua-engine__weights">
          {WEIGHTS.map((w) => (<li key={w.label}><span>{w.label}</span><span>{w.basis}</span></li>))}
        </ul>
        <p className="ua-engine__note">한 모듈이 실패하면 나머지 모듈의 가중치를 다시 나눠 계산합니다. 규칙 기반 결과는 필수라서, 이 단계가 실패하면 완료로 처리하지 않습니다.</p>
      </div>
      <div className="ua-engine__grades">
        <span className="ua-engine__score-kicker">등급 기준</span>
        <ol className="ua-engine__grade-list">
          {GRADES.map((g) => (<li key={g.grade}><b>{g.grade}</b><span>{g.from > 0 ? `${g.from}점 이상` : "60점 미만"}</span></li>))}
        </ol>
      </div>
    </div>
  );
}

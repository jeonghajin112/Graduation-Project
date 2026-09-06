import { AnimatePresence, m } from "framer-motion";

import { lenses, criterionChain, storyExample, type HighlightVisual, type Lens } from "./landing-content";
import { SWAP_DURATION, useLandingReducedMotion } from "./landing-motion";

/**
 * Original landing visuals.
 *
 * Everything here is drawn with DOM elements and inline SVG rather than bitmap
 * exports: the composition stays crisp from 320px to 4K, weighs nothing, and
 * shows the product's real vocabulary (KWCAG item numbers, DOM selectors,
 * contrast ratios) instead of a screenshot pasted at large size.
 */

/* ------------------------------------------------------------------ */
/* Focus bracket — the recurring accessibility marker of the page      */
/* ------------------------------------------------------------------ */

export function FocusBracket({ tone = "accent" }: { tone?: "accent" | "quiet" }) {
  return (
    <span className={`ua-bracket ua-bracket--${tone}`} aria-hidden="true">
      <i />
      <i />
      <i />
      <i />
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Sample page used by the lens explorer                              */
/* ------------------------------------------------------------------ */

export function SamplePage({ lens }: { lens: Lens }) {
  const targetClass = (target: Lens["target"]) =>
    `ua-sample__target${lens.target === target ? " is-target" : ""}`;
  const marker = (target: Lens["target"]) =>
    lens.target === target ? (
      <span className="ua-sample__marker" aria-hidden="true">
        {lens.marker}
      </span>
    ) : null;

  return (
    <div className="ua-sample" aria-hidden="true">
      <div className="ua-sample__chrome">
        <span className="ua-sample__dots">
          <i />
          <i />
          <i />
        </span>
        <span className="ua-sample__address">example.ac.kr / notice</span>
      </div>

      <div className="ua-sample__canvas">
        <div className="ua-sample__nav">
          <strong>예시 대학교</strong>
          <span>대학 안내</span>
          <span>입학</span>
          <span>공지</span>
        </div>

        <div className="ua-sample__hero">
          <div className="ua-sample__copy">
            <span className="ua-sample__eyebrow">공지사항</span>
            <strong className="ua-sample__title">2026학년도 수강신청 안내</strong>
            <p className={targetClass("copy")}>
              수강신청은 학사일정에 따라 학년별로 구분하여 진행되며 신청 기간 이후에는 정정 기간에만
              변경이 가능하므로 반드시 공지된 일정을 확인한 뒤 신청하시기 바랍니다.
              {marker("copy")}
            </p>
            <span className={`ua-sample__link ${targetClass("link")}`}>
              자세히 보기
              {marker("link")}
            </span>
          </div>

          <div className={`ua-sample__media ${targetClass("media")}`}>
            <span className="ua-sample__media-art">
              <i />
              <i />
            </span>
            {marker("media")}
          </div>
        </div>
      </div>
    </div>
  );
}

export function LensResult({ lens }: { lens: Lens }) {
  const reduce = useLandingReducedMotion();

  return (
    <div className="ua-lens-result" aria-live="polite" aria-atomic="true">
      <AnimatePresence mode="wait" initial={false}>
        <m.div
          key={lens.id}
          initial={reduce ? false : { opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduce ? undefined : { opacity: 0, y: -10 }}
          transition={{ duration: reduce ? 0 : SWAP_DURATION, ease: "easeOut" }}
        >
          <p className="ua-lens-result__module">{lens.module}</p>
          <p className="ua-lens-result__finding">{lens.finding}</p>
          <p className="ua-lens-result__reading">{lens.reading}</p>

          <dl className="ua-lens-result__facts">
            <div>
              <dt>확인 기준</dt>
              <dd>
                <span className="ua-criterion">{lens.criterion}</span>
                {lens.criterionName}
              </dd>
            </div>
            <div>
              <dt>대상 요소</dt>
              <dd>
                <code>{lens.selector}</code>
              </dd>
            </div>
          </dl>
        </m.div>
      </AnimatePresence>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Highlight rail visuals                                             */
/* ------------------------------------------------------------------ */

const DIFFICULTY_METRICS = [
  { label: "평균 문장 길이", value: "34어절", limit: "25어절", ratio: 100 },
  { label: "평균 어절 길이", value: "4.1자", limit: "4.5자", ratio: 62 },
  { label: "고난이도 어휘", value: "46%", limit: "40%", ratio: 92 },
] as const;

const CONTRAST_SAMPLES = [
  { ratio: "2.6 : 1", verdict: "기준 미달", tone: "fail" as const, fg: "#9f9f9f", bg: "#ffffff" },
  { ratio: "5.9 : 1", verdict: "AA 통과", tone: "pass" as const, fg: "#656565", bg: "#ffffff" },
] as const;

const RULE_ROWS = [
  { criterion: "KWCAG 5.1.1", name: "적절한 대체 텍스트 제공", state: "위반 2건" },
  { criterion: "KWCAG 5.4.3", name: "텍스트 콘텐츠의 명도 대비", state: "위반 4건" },
  { criterion: "KWCAG 6.4.2", name: "제목 제공", state: "통과" },
] as const;

const HISTORY_ROWS = [
  { when: "1차 검사", resolved: "해결 0", remaining: "남은 이슈 12" },
  { when: "재검사", resolved: "해결 7", remaining: "남은 이슈 5" },
] as const;

export function HighlightArt({ kind }: { kind: HighlightVisual }) {
  if (kind === "rule") {
    return (
      <div className="ua-art ua-art--rule" aria-hidden="true">
        {RULE_ROWS.map((row) => (
          <div key={row.criterion} className="ua-art__row">
            <span className="ua-criterion">{row.criterion}</span>
            <span className="ua-art__name">{row.name}</span>
            <span className={`ua-art__state${row.state === "통과" ? " is-pass" : ""}`}>{row.state}</span>
          </div>
        ))}
      </div>
    );
  }

  if (kind === "difficulty") {
    return (
      <div className="ua-art ua-art--difficulty" aria-hidden="true">
        {DIFFICULTY_METRICS.map((metric) => (
          <div key={metric.label} className="ua-art__metric">
            <span className="ua-art__metric-head">
              <span>{metric.label}</span>
              <strong>{metric.value}</strong>
            </span>
            <span className="ua-art__track">
              <span className="ua-art__fill" style={{ inlineSize: `${metric.ratio}%` }} />
              <span className="ua-art__limit" style={{ insetInlineStart: "74%" }} />
            </span>
            <span className="ua-art__metric-foot">권장 {metric.limit}</span>
          </div>
        ))}
      </div>
    );
  }

  if (kind === "contrast") {
    return (
      <div className="ua-art ua-art--contrast" aria-hidden="true">
        {CONTRAST_SAMPLES.map((sample) => (
          <div key={sample.ratio} className={`ua-art__swatch is-${sample.tone}`}>
            <span className="ua-art__chip" style={{ background: sample.bg }}>
              <i style={{ background: sample.fg }} />
              <i style={{ background: sample.fg }} />
            </span>
            <strong>{sample.ratio}</strong>
            <span className="ua-art__swatch-verdict">{sample.verdict}</span>
          </div>
        ))}
      </div>
    );
  }

  if (kind === "guide") {
    return (
      <div className="ua-art ua-art--guide" aria-hidden="true">
        <div className="ua-art__code is-before">
          <span>수정 전</span>
          <code>{storyExample.before}</code>
        </div>
        <div className="ua-art__code is-after">
          <span>수정 후</span>
          <code>{storyExample.after}</code>
        </div>
      </div>
    );
  }

  return (
    <div className="ua-art ua-art--history" aria-hidden="true">
      {HISTORY_ROWS.map((row, index) => (
        <div key={row.when} className={`ua-art__run${index === 1 ? " is-latest" : ""}`}>
          <span className="ua-art__run-when">{row.when}</span>
          <span className="ua-art__run-resolved">{row.resolved}</span>
          <span className="ua-art__run-remaining">{row.remaining}</span>
        </div>
      ))}
      <span className="ua-art__run-note">같은 페이지, 두 번의 기록</span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Story visuals — 발견 / 영향 / 기준 / 수정                            */
/* ------------------------------------------------------------------ */

export function StoryArt({ kind }: { kind: "locate" | "impact" | "criterion" | "fix" }) {
  if (kind === "locate") {
    return (
      <div className="ua-story-art ua-story-art--locate" aria-hidden="true">
        <div className="ua-story-art__path">
          {storyExample.path.map((part, index) => (
            <span key={part}>
              {index > 0 && <i>/</i>}
              <b>{part}</b>
            </span>
          ))}
        </div>
        <div className="ua-story-art__frame">
          <span className="ua-story-art__block">
            <span className="ua-story-art__block-art">
              <i />
              <i />
            </span>
            <FocusBracket />
          </span>
        </div>
        <div className="ua-story-art__selector">
          <span>DOM 선택자</span>
          <code>{storyExample.selector}</code>
        </div>
      </div>
    );
  }

  if (kind === "impact") {
    return (
      <div className="ua-story-art ua-story-art--impact" aria-hidden="true">
        <div className="ua-story-art__pane">
          <span className="ua-story-art__pane-label">화면으로 볼 때</span>
          <span className="ua-story-art__block-art is-filled">
            <i />
            <i />
          </span>
        </div>
        <div className="ua-story-art__pane is-empty">
          <span className="ua-story-art__pane-label">대체 텍스트로 읽을 때</span>
          <span className="ua-story-art__void">읽을 내용 없음</span>
        </div>
      </div>
    );
  }

  if (kind === "criterion") {
    return (
      <div className="ua-story-art ua-story-art--criterion" aria-hidden="true">
        <ol className="ua-chain">
          {criterionChain.steps.map((step, index) => (
            <li key={step.label} className={index === criterionChain.steps.length - 1 ? "is-final" : undefined}>
              <span className="ua-chain__label">{step.label}</span>
              <span className="ua-chain__value">{step.value}</span>
            </li>
          ))}
        </ol>

        <dl>
          <div>
            <dt>판단한 모듈</dt>
            <dd>{storyExample.module}</dd>
          </div>
          <div>
            <dt>심각도</dt>
            <dd>{storyExample.severity}</dd>
          </div>
          <div>
            <dt>검사항목 집합</dt>
            <dd>KWCAG 2.2 · 33개</dd>
          </div>
        </dl>

        <p className="ua-story-art__recommendation">{criterionChain.scoring}</p>
      </div>
    );
  }

  return (
    <div className="ua-story-art ua-story-art--fix" aria-hidden="true">
      <div className="ua-art__code is-before">
        <span>수정 전</span>
        <code>{storyExample.before}</code>
      </div>
      <div className="ua-art__code is-after">
        <span>수정 후</span>
        <code>{storyExample.after}</code>
      </div>
      <p className="ua-story-art__recommendation">{storyExample.recommendation}</p>
    </div>
  );
}

export const lensOrder = lenses.map((lens) => lens.id);

import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { ArrowRight, ChevronLeft, ChevronRight } from "lucide-react";

import "@/styles/landing.css";

import {
  actionLabels,
  boundary,
  brand,
  closerLook,
  final,
  hero,
  highlights,
  lenses,
  navLinks,
  scoreModel,
  story,
  storySteps,
  type LensId,
} from "./landing-content";
import { LandingMotionProvider, Reveal, useLandingReducedMotion } from "./landing-motion";
import { HighlightArt, LensResult, SamplePage, StoryArt } from "./landing-visuals";
import { ProductDemoPreview } from "./product-demo-preview";

type LandingPageProps = {
  /** Enters the analysis app. Wired to `/analyze` by the route component. */
  onEnterApp?: () => void;
};

/* ------------------------------------------------------------------ */
/* Shared controls                                                     */
/* ------------------------------------------------------------------ */

function PrimaryAction({
  onClick,
  marker,
  size = "regular",
}: {
  onClick?: () => void;
  marker: string;
  size?: "regular" | "compact";
}) {
  const markerProps = { [marker]: "true" } as Record<string, string>;
  return (
    <button
      type="button"
      className={`ua-action ua-action--${size}`}
      onClick={onClick}
      {...markerProps}
    >
      <span>{actionLabels.primary}</span>
      <ArrowRight size={size === "compact" ? 16 : 19} strokeWidth={2} aria-hidden="true" />
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* Header — thin sticky local navigation                               */
/* ------------------------------------------------------------------ */

function LandingHeader({ onEnterApp }: { onEnterApp?: () => void }) {
  return (
    <header className="ua-header">
      <div className="ua-header__inner" data-container="true">
        <span className="ua-wordmark">{brand.wordmark}</span>

        <nav className="ua-header__nav" aria-label="페이지 안 이동">
          {navLinks.map((link) => (
            <a key={link.href} href={link.href}>
              {link.label}
            </a>
          ))}
        </nav>

        <div className="ua-header__actions">
          <button type="button" className="ua-text-action" onClick={onEnterApp} data-login-cta="true">
            {actionLabels.login}
          </button>
          <PrimaryAction onClick={onEnterApp} marker="data-header-cta" size="compact" />
        </div>
      </div>
    </header>
  );
}

/* ------------------------------------------------------------------ */
/* B. Hero                                                             */
/* ------------------------------------------------------------------ */

function HeroSectionBlock({ onEnterApp }: { onEnterApp?: () => void }) {
  return (
    <section className="ua-section ua-section--fog ua-hero" data-section="hero" aria-labelledby="ua-hero-title">
      <div className="ua-hero__inner" data-container="true">
        <Reveal className="ua-hero__copy" immediate distance={16}>
          <h1 className="ua-hero__headline" id="ua-hero-title" data-hero-headline="true">
            {hero.headline.map((line) => (
              <span key={line}>{line}</span>
            ))}
          </h1>
          <p className="ua-hero__subcopy" data-hero-subcopy="true">
            {hero.subcopy}
          </p>
          <div className="ua-hero__action">
            <PrimaryAction onClick={onEnterApp} marker="data-hero-cta" />
          </div>
        </Reveal>

        <Reveal className="ua-hero__media" immediate distance={22} delay={0.08} as="figure">
          <ProductDemoPreview />
        </Reveal>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* C. Highlight rail                                                   */
/* ------------------------------------------------------------------ */

function HighlightRail() {
  const railRef = useRef<HTMLDivElement>(null);
  const [atStart, setAtStart] = useState(true);
  const [atEnd, setAtEnd] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  const cardAnchor = (rail: HTMLDivElement) =>
    rail.getBoundingClientRect().left +
    (parseFloat(getComputedStyle(rail).paddingInlineStart) || 0);

  const syncEdges = useCallback(() => {
    const rail = railRef.current;
    if (!rail) return;
    const travel = rail.scrollWidth - rail.clientWidth;
    setAtStart(rail.scrollLeft <= 2);
    setAtEnd(rail.scrollLeft >= travel - 2);

    const cards = [...rail.querySelectorAll<HTMLElement>(".ua-highlight")];
    if (cards.length === 0) return;
    const anchor = cardAnchor(rail);
    let nearest = 0;
    let best = Number.POSITIVE_INFINITY;
    cards.forEach((card, index) => {
      const distance = Math.abs(card.getBoundingClientRect().left - anchor);
      if (distance < best) {
        best = distance;
        nearest = index;
      }
    });
    setActiveIndex(nearest);
  }, []);

  useEffect(() => {
    syncEdges();
    const rail = railRef.current;
    if (!rail) return;
    rail.addEventListener("scroll", syncEdges, { passive: true });
    window.addEventListener("resize", syncEdges);
    return () => {
      rail.removeEventListener("scroll", syncEdges);
      window.removeEventListener("resize", syncEdges);
    };
  }, [syncEdges]);

  const step = (direction: -1 | 1) => {
    const rail = railRef.current;
    if (!rail) return;
    const card = rail.querySelector<HTMLElement>(".ua-highlight");
    const distance = card ? card.getBoundingClientRect().width + 24 : rail.clientWidth * 0.8;
    rail.scrollBy({ left: direction * distance, behavior: "smooth" });
  };

  const goToCard = (index: number) => {
    const rail = railRef.current;
    if (!rail) return;
    const card = rail.querySelectorAll<HTMLElement>(".ua-highlight")[index];
    if (!card) return;
    rail.scrollBy({
      left: card.getBoundingClientRect().left - cardAnchor(rail),
      behavior: "smooth",
    });
  };

  return (
    <section
      id="highlights"
      className="ua-section ua-section--white ua-highlights"
      data-section="highlights"
      aria-labelledby="ua-highlights-title"
    >
      <div className="ua-highlights__head" data-container="true">
        <Reveal>
          <h2 className="ua-section-title" id="ua-highlights-title">
            분석이 하는 일
          </h2>
        </Reveal>
        <div className="ua-rail-controls">
          <button
            type="button"
            className="ua-rail-button"
            onClick={() => step(-1)}
            disabled={atStart}
            aria-label="이전 기능 보기"
          >
            <ChevronLeft size={22} strokeWidth={2} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="ua-rail-button"
            onClick={() => step(1)}
            disabled={atEnd}
            aria-label="다음 기능 보기"
          >
            <ChevronRight size={22} strokeWidth={2} aria-hidden="true" />
          </button>
        </div>
      </div>

      <Reveal
        className="ua-rail"
        distance={22}
        // The rail scrolls horizontally, so cards past the fold would never
        // satisfy an in-view check. The whole rail reveals once instead.
      >
        <div
          className="ua-rail__viewport"
          ref={railRef}
          tabIndex={0}
          role="group"
          aria-label="분석 기능 목록, 좌우 방향키로 이동할 수 있습니다"
          data-allow-overflow="true"
        >
          <ul className="ua-rail__track">
            {highlights.map((highlight) => (
              <li className="ua-highlight" key={highlight.id}>
                <article className="ua-highlight__body">
                  <h3 className="ua-highlight__kicker">{highlight.kicker}</h3>
                  <p className="ua-highlight__value">{highlight.value}</p>
                  <div className="ua-highlight__art">
                    <HighlightArt kind={highlight.visual} />
                  </div>
                  <p className="ua-highlight__evidence">
                    <span>{highlight.evidenceLabel}</span>
                    <strong>{highlight.evidence}</strong>
                  </p>
                </article>
              </li>
            ))}
          </ul>
        </div>
      </Reveal>
      <div className="ua-highlights__foot" data-container="true" data-section="score">
        <div className="ua-rail-steps" role="group" aria-label="기능 카드 위치">
          {highlights.map((highlight, index) => (
            <button
              key={highlight.id}
              type="button"
              className="ua-rail-step"
              aria-label={`${index + 1}번째 기능, ${highlight.kicker}`}
              aria-current={index === activeIndex ? "true" : undefined}
              onClick={() => goToCard(index)}
            >
              <span aria-hidden="true" />
            </button>
          ))}
        </div>

        <Reveal className="ua-score" as="article">
          <h3 className="ua-score__label">{scoreModel.label}</h3>
          <dl className="ua-score__weights">
            {scoreModel.weights.map((entry) => (
              <div key={entry.module}>
                <dt>{entry.module}</dt>
                <dd>
                  <strong>{entry.weight}</strong>
                  <span>{entry.basis}</span>
                </dd>
              </div>
            ))}
          </dl>
          <p className="ua-score__note">{scoreModel.note}</p>
        </Reveal>
      </div>
    </section>
  );
}

function CloserLook() {
  const [activeLens, setActiveLens] = useState<LensId>("rule");
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const lens = lenses.find((entry) => entry.id === activeLens) ?? lenses[0];

  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next = index;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (index + 1) % lenses.length;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp")
      next = (index - 1 + lenses.length) % lenses.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = lenses.length - 1;
    else return;

    event.preventDefault();
    setActiveLens(lenses[next].id);
    tabRefs.current[next]?.focus();
  };

  return (
    <section
      id="closer"
      className="ua-section ua-section--fog ua-closer"
      data-section="closer"
      aria-labelledby="ua-closer-title"
    >
      <div className="ua-closer__inner" data-container="true">
        <Reveal className="ua-closer__head">
          <h2 className="ua-section-title" id="ua-closer-title">
            {closerLook.title}
          </h2>
          <p className="ua-section-lead">{closerLook.lead}</p>
        </Reveal>

        <Reveal className="ua-closer__panel" distance={22}>
          <div className="ua-tabs" role="tablist" aria-label="분석 관점 선택">
            {lenses.map((entry, index) => {
              const selected = entry.id === activeLens;
              return (
                <button
                  key={entry.id}
                  ref={(node) => {
                    tabRefs.current[index] = node;
                  }}
                  id={`ua-lens-tab-${entry.id}`}
                  type="button"
                  role="tab"
                  className="ua-tab"
                  aria-selected={selected}
                  aria-controls={`ua-lens-panel-${entry.id}`}
                  tabIndex={selected ? 0 : -1}
                  onClick={() => setActiveLens(entry.id)}
                  onKeyDown={(event) => onTabKeyDown(event, index)}
                >
                  {entry.label}
                </button>
              );
            })}
          </div>

          {lenses.map((entry) => (
            <div
              key={entry.id}
              id={`ua-lens-panel-${entry.id}`}
              role="tabpanel"
              aria-labelledby={`ua-lens-tab-${entry.id}`}
              className="ua-closer__viewer"
              hidden={entry.id !== activeLens}
            >
              {/* Only the selected panel holds content, so there is exactly one
                  live region and one copy of the sample in the DOM. */}
              {entry.id === activeLens && (
                <>
                  <div className="ua-closer__sample">
                    <SamplePage lens={lens} />
                  </div>
                  <LensResult lens={lens} />
                </>
              )}
            </div>
          ))}
        </Reveal>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* D-2. Story — 발견 → 영향 → 기준 → 수정                               */
/* ------------------------------------------------------------------ */

function StorySection() {
  return (
    <section
      id="story"
      className="ua-section ua-section--white ua-story"
      data-section="story"
      aria-labelledby="ua-story-title"
    >
      <div className="ua-story__head" data-container="true">
        <Reveal>
          <h2 className="ua-section-title" id="ua-story-title">
            {story.title}
          </h2>
          <p className="ua-section-lead">{story.lead}</p>
        </Reveal>
      </div>

      <div className="ua-story__steps">
        {storySteps.map((step, index) => (
          <div
            key={step.id}
            className="ua-story-step"
            data-flow={index % 2 === 0 ? "media-end" : "media-start"}
            data-section={`story-${step.id}`}
          >
            <div className="ua-story-step__inner" data-container="true">
              <Reveal className="ua-story-step__copy">
                <p className="ua-story-step__kicker">
                  <span className="ua-story-step__index">{step.index}</span>
                  {step.kicker}
                </p>
                <h3 className="ua-story-step__title">{step.title}</h3>
                <p className="ua-story-step__body">{step.body}</p>
              </Reveal>
              <Reveal className="ua-story-step__art" distance={22} delay={0.06}>
                <StoryArt kind={step.visual} />
              </Reveal>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* E. Automatic analysis vs human review                               */
/* ------------------------------------------------------------------ */

function BoundarySection() {
  const columns = [boundary.automated, boundary.human] as const;

  return (
    <section
      id="boundary"
      className="ua-section ua-section--ink ua-boundary"
      data-section="boundary"
      aria-labelledby="ua-boundary-title"
    >
      <div className="ua-boundary__inner" data-container="true">
        <Reveal className="ua-boundary__head">
          <h2 className="ua-section-title ua-section-title--onInk" id="ua-boundary-title">
            {boundary.title.split("\n").map((line) => (
              <span key={line}>{line}</span>
            ))}
          </h2>
          <p className="ua-section-lead ua-section-lead--onInk">{boundary.lead}</p>
        </Reveal>

        <div className="ua-boundary__columns">
          {columns.map((column, index) => (
            <Reveal
              key={column.label}
              as="article"
              className="ua-boundary__column"
              delay={index * 0.06}
            >
              <h3>{column.label}</h3>
              <p className="ua-boundary__caption">{column.caption}</p>
              <ul>
                {column.items.map((item) => (
                  <li key={item.criterion}>
                    <span className="ua-criterion ua-criterion--onInk">{item.criterion}</span>
                    <span>{item.text}</span>
                  </li>
                ))}
              </ul>
            </Reveal>
          ))}
        </div>

        <Reveal className="ua-boundary__note" as="p">
          {boundary.note}
        </Reveal>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* F. Closing CTA and footer                                           */
/* ------------------------------------------------------------------ */

function FinalSection({ onEnterApp }: { onEnterApp?: () => void }) {
  return (
    <section
      className="ua-section ua-section--fog ua-final"
      data-section="final"
      aria-labelledby="ua-final-title"
    >
      <Reveal className="ua-final__inner" distance={16}>
        <div data-container="true">
          <h2 className="ua-section-title" id="ua-final-title">
            {final.title}
          </h2>
          <p className="ua-section-lead">{final.lead}</p>
          <div className="ua-final__action">
            <PrimaryAction onClick={onEnterApp} marker="data-final-cta" />
          </div>
        </div>
      </Reveal>
    </section>
  );
}

function LandingFooter({ onEnterApp }: { onEnterApp?: () => void }) {
  return (
    <footer className="ua-footer" data-section="footer">
      <div className="ua-footer__inner" data-container="true">
        <div>
          <span className="ua-wordmark">{brand.wordmark}</span>
          <p>{brand.purpose}</p>
        </div>
        <button type="button" className="ua-text-action" onClick={onEnterApp}>
          {actionLabels.login}
        </button>
      </div>
    </footer>
  );
}

/* ------------------------------------------------------------------ */
/* Page shell                                                          */
/* ------------------------------------------------------------------ */

function LandingShell({ onEnterApp }: LandingPageProps) {
  const reduce = useLandingReducedMotion();

  return (
    <div className="uni-landing" data-reduced-motion={reduce ? "true" : "false"}>
      <a className="ua-skip-link" href="#main-content" data-focus-reveal="true">
        본문으로 바로가기
      </a>

      <LandingHeader onEnterApp={onEnterApp} />

      <main id="main-content" tabIndex={-1}>
        <HeroSectionBlock onEnterApp={onEnterApp} />
        <HighlightRail />
        <CloserLook />
        <StorySection />
        <BoundarySection />
        <FinalSection onEnterApp={onEnterApp} />
      </main>

      <LandingFooter onEnterApp={onEnterApp} />
    </div>
  );
}

export function LandingPage({ onEnterApp }: LandingPageProps) {
  return (
    <LandingMotionProvider>
      <LandingShell onEnterApp={onEnterApp} />
    </LandingMotionProvider>
  );
}

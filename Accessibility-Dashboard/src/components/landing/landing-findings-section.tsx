import { useEffect, useRef, useState, type CSSProperties } from "react";
import issueDetailImage from "@/assets/landing/issue-detail.webp";
import { LandingMessageSection } from "./landing-message-section";
import "@/styles/landing-findings.css";

const STEPS = [
  { title: "위치를 찾고", body: "마커가 가리키는 요소를 확인하세요. 가까이 모인 문제는 숫자로 표시되어 하나씩 살펴볼 수 있습니다.", caption: "문제가 있는 요소를 페이지 위에서 확인합니다." },
  { title: "이유를 이해하고", body: "문제가 된 내용과 접근성 항목을 함께 읽고, 어떤 기준으로 판단했는지 살펴보세요.", caption: "실제 분석 문장과 접근성 항목을 함께 살펴봅니다." },
  { title: "개선 방향을 정하세요", body: "개선 안내를 바탕으로 수정할 부분을 정하세요. 항목에 따라 문장 수정 예시와 색상 추천도 제공됩니다.", caption: "분석한 링크의 길이와 권장 기준을 비교한 개선 안내입니다." }
] as const;

export function LandingFindingsSection() {
  const trackRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const sourceWordRef = useRef<HTMLSpanElement>(null);
  const targetWordRef = useRef<HTMLSpanElement>(null);
  const movingWordRef = useRef<HTMLSpanElement>(null);
  const [scene, setScene] = useState("message");
  const [phase, setPhase] = useState(0);
  const activeStep = phase - 1;

  useEffect(() => {
    const track = trackRef.current;
    const body = bodyRef.current;
    const stage = stageRef.current;
    const source = sourceWordRef.current;
    const target = targetWordRef.current;
    const moving = movingWordRef.current;
    if (!track || !body || !stage || !source || !target || !moving) return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const compact = window.matchMedia("(max-width: 900px)");
    let frame = 0;
    const update = () => {
      frame = 0;
      const bounds = track.getBoundingClientRect();
      const top = parseFloat(getComputedStyle(stage).top) || 0;
      // Accordion height changes must not move the scroll thresholds.
      const distance = Math.max(1, bounds.height - window.innerHeight);
      const progress = Math.max(0, Math.min(1, (top - bounds.top) / distance));
      const handoff = Math.max(0, Math.min(1, (progress - 0.08) / 0.2));
      const animate = !reducedMotion.matches && !compact.matches;
      const travel = animate ? handoff * handoff * (3 - 2 * handoff) : Number(handoff >= 0.5);
      const nextScene = travel === 0 ? "message" : travel === 1 ? "findings" : "handoff";
      stage.dataset.scene = nextScene;
      setScene(current => current === nextScene ? current : nextScene);
      stage.style.setProperty("--message-opacity", String(Math.max(0, 1 - travel * 2)));
      stage.style.setProperty("--findings-opacity", String(Math.max(0, (travel - 0.3) / 0.7)));
      const origin = source.getBoundingClientRect();
      const destination = target.getBoundingClientRect();
      const stageBounds = stage.getBoundingClientRect();
      const sourceStyle = getComputedStyle(source);
      const targetStyle = getComputedStyle(target);
      const interpolate = (from: string, to: string) => `${parseFloat(from) + (parseFloat(to) - parseFloat(from)) * travel}px`;
      moving.style.fontSize = interpolate(sourceStyle.fontSize, targetStyle.fontSize);
      moving.style.lineHeight = interpolate(sourceStyle.lineHeight, targetStyle.lineHeight);
      moving.style.letterSpacing = interpolate(sourceStyle.letterSpacing, targetStyle.letterSpacing);
      moving.style.left = `${origin.left - stageBounds.left}px`;
      moving.style.top = `${origin.top - stageBounds.top}px`;
      moving.style.transform = `translate(${(destination.left - origin.left) * travel}px, ${(destination.top - origin.top) * travel}px)`;
      moving.style.color = `rgb(${Math.round(124 * (1 - travel))}, ${Math.round(135 + (113 - 135) * travel)}, ${Math.round(150 + (227 - 150) * travel)})`;
      const findingsProgress = Math.max(0, (progress - 0.28) / 0.72);
      const next = Math.min(STEPS.length, Math.floor(findingsProgress * (STEPS.length + 1)));
      setPhase(current => current === next ? current : next);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    observer?.observe(track);
    observer?.observe(body);
    observer?.observe(source);
    observer?.observe(target);
    reducedMotion.addEventListener("change", schedule);
    compact.addEventListener("change", schedule);
    let disposed = false;
    void document.fonts.ready.then(() => { if (!disposed) schedule(); });
    schedule();
    return () => {
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      observer?.disconnect();
      disposed = true;
      reducedMotion.removeEventListener("change", schedule);
      compact.removeEventListener("change", schedule);
      cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <section className="ua-findings is-visible" aria-labelledby={scene === "findings" ? "ua-findings-title" : "ua-message-title"}>
      <div className="ua-findings__inner">
        <div className="ua-findings__track" ref={trackRef}>
        {[0, 0.37, 0.55, 0.73, 0.91].map((progress, index) => (
          <span key={progress} className="ua-findings__snap-point" data-landing-snap={`findings-${index}`}
            aria-hidden="true" style={{ "--snap-progress": progress } as CSSProperties} />
        ))}
        <div className="ua-findings__stage" ref={stageRef} data-scene={scene}>
        <div className="ua-findings__message" aria-hidden={scene === "findings"}>
          <LandingMessageSection wordRef={sourceWordRef} />
        </div>
        <span ref={movingWordRef} className="ua-findings__moving-word" aria-hidden="true">문제</span>
        <div className="ua-findings__body" ref={bodyRef} aria-hidden={scene !== "findings"} data-phase={phase === 0 ? "intro" : "steps"}>
        <div className="ua-findings__copy">
          <header className="ua-findings__head" aria-hidden={phase !== 0}>
            <h2 id="ua-findings-title"><span ref={targetWordRef} className="ua-findings__target-word">문제</span>를 찾았다면,<br />바꿀 <span>이유</span>까지.</h2>
          </header>
          <ol className="ua-findings__steps" aria-hidden={phase === 0}>
            {STEPS.map((step, index) => (
              <li key={step.title} className={activeStep === index ? "is-active" : ""} aria-current={activeStep === index ? "step" : undefined}>
                <div className="ua-findings__step">
                <span className="ua-findings__number" aria-hidden="true">0{index + 1}</span>
                <span className="ua-findings__step-copy">
                  <span className="ua-findings__step-title">{step.title}</span>
                  <span className="ua-findings__description-reveal" aria-hidden={activeStep !== index}>
                    <span className="ua-findings__description-clip"><span className="ua-findings__step-description">{step.body}</span></span>
                  </span>
                </span>
                </div>
              </li>
            ))}
          </ol>
        </div>
        <figure className="ua-findings__figure" id="ua-findings-view" data-step={Math.max(0, activeStep)}>
          <div className="ua-findings__viewport">
          <img src={issueDetailImage} width="2560" height="1440" loading="lazy" decoding="async"
            alt="최신 라이브 리포트의 상단바 아래, 홍익대학교 페이지의 링크가 강조되고 문제 설명창에 분석 문장과 링크 길이 개선 기준이 표시된 화면" />
          </div>
          <figcaption className="ua-findings__caption">{phase === 0 ? "실제 페이지에서 확인한 접근성 분석 결과" : STEPS[activeStep].caption}</figcaption>
        </figure>
        </div>
        </div>
        </div>
      </div>
    </section>
  );
}

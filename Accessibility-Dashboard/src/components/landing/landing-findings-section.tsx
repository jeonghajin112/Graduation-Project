import { useEffect, useRef, useState } from "react";
import issueDetailImage from "@/assets/landing/issue-detail.webp";
import "@/styles/landing-findings.css";

const STEPS = [
  { title: "위치를 찾고", body: "마커가 가리키는 요소를 확인하세요. 문제를 페이지 안에서 바로 찾을 수 있습니다.", caption: "문제가 있는 요소를 페이지 위에서 확인합니다." },
  { title: "이유를 이해하고", body: "문제가 된 내용과 접근성 항목을 함께 읽고, 어떤 기준으로 판단했는지 살펴보세요.", caption: "실제 분석 문장과 접근성 항목을 함께 살펴봅니다." },
  { title: "개선 방향을 정하세요", body: "개선 안내를 바탕으로 수정할 부분을 정하세요. 항목에 따라 문장 수정 예시와 색상 추천도 제공됩니다.", caption: "링크 길이 52글자와 기준 30글자를 비교한 개선 안내입니다." }
] as const;

export function LandingFindingsSection() {
  const sectionRef = useRef<HTMLElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [phase, setPhase] = useState(0);
  const activeStep = phase - 1;

  useEffect(() => {
    const track = trackRef.current;
    const body = bodyRef.current;
    if (!track || !body) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const bounds = track.getBoundingClientRect();
      const top = parseFloat(getComputedStyle(body).top) || 0;
      // Accordion height changes must not move the scroll thresholds.
      const distance = Math.max(1, bounds.height - window.innerHeight);
      const progress = Math.max(0, Math.min(1, (top - bounds.top) / distance));
      const next = Math.min(STEPS.length, Math.floor(progress * (STEPS.length + 1)));
      setPhase(current => current === next ? current : next);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    observer?.observe(track);
    observer?.observe(body);
    schedule();
    return () => {
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      observer?.disconnect();
      cancelAnimationFrame(frame);
    };
  }, []);

  useEffect(() => {
    const section = sectionRef.current;
    if (!section || typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        setVisible(true);
        observer.disconnect();
      }
    }, { threshold: 0.12 });
    observer.observe(section);
    return () => observer.disconnect();
  }, []);

  return (
    <section ref={sectionRef} className={`ua-findings${visible ? " is-visible" : ""}`} aria-labelledby="ua-findings-title">
      <div className="ua-findings__inner">
        <div className="ua-findings__track" ref={trackRef}>
        <div className="ua-findings__body" ref={bodyRef} data-phase={phase === 0 ? "intro" : "steps"}>
        <div className="ua-findings__copy">
          <header className="ua-findings__head" aria-hidden={phase !== 0}>
            <h2 id="ua-findings-title"><span>문제</span>를 찾았다면,<br />바꿀 <span>이유</span>까지.</h2>
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
          <img src={issueDetailImage} width="2296" height="2050" loading="lazy" decoding="async"
            alt="실제 홍익대학교 페이지에서 조각전공 전시 링크가 심각도 색상의 테두리로 강조되고, 설명창에 링크 텍스트 52글자와 기준 30글자가 표시된 분석 결과" />
          </div>
          <figcaption className="ua-findings__caption">{phase === 0 ? "실제 페이지에서 확인한 접근성 분석 결과" : STEPS[activeStep].caption}</figcaption>
        </figure>
        </div>
        </div>
      </div>
    </section>
  );
}

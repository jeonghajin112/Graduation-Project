import { Check, ChevronLeft, ChevronRight, Loader2, Lock, Pause, X } from "lucide-react";
import type { ReactNode, Ref } from "react";

import "@/styles/quick-analysis-progress.css";

export type AnalysisPhase = "idle" | "requesting" | "queued" | "running" | "completed" | "paused" | "failed";

const steps = ["페이지 연결", "접근성 검사", "결과 준비"] as const;
const phaseLabels: Record<AnalysisPhase, string> = {
  idle: "분석 준비",
  requesting: "분석 요청 중",
  queued: "대기열에서 기다리는 중",
  running: "페이지 분석 중",
  completed: "결과 준비 완료",
  paused: "상태 확인 필요",
  failed: "분석 실패"
};

function hostnameOf(url: string) {
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
}

export function QuickAnalysisProgress({ phase, url, isBusy, children, headingRef, announceStatus = true }: {
  phase: AnalysisPhase;
  url: string;
  isBusy: boolean;
  children: ReactNode;
  /** Receives focus when the progress view replaces the control that started it. */
  headingRef?: Ref<HTMLHeadingElement>;
  /** Set false when the parent owns a live region that survives this view's unmount. */
  announceStatus?: boolean;
}) {
  const stepIndex = phase === "completed" ? 2 : phase === "requesting" || phase === "queued" ? 0 : 1;
  const title = phase === "failed" ? "분석을 완료하지 못했습니다"
    : phase === "paused" ? "분석 상태를 다시 확인해 주세요"
    : phase === "completed" ? "분석이 완료되었습니다"
    : phase === "queued" ? "분석 순서를 기다리고 있습니다"
    : "페이지를 분석하고 있습니다";

  return (
    <section className="quick-analysis-progress" aria-labelledby="quick-analysis-heading" data-phase={phase}>
      <div className="quick-analysis-copy">
        <p className="quick-analysis-eyebrow">접근성 분석</p>
        <h2 id="quick-analysis-heading" ref={headingRef} tabIndex={-1} className="focus:outline-none">{title}</h2>
        <p className="quick-analysis-url">{url}</p>
        {announceStatus ? (
          <p className="sr-only" role="status" aria-atomic="true">현재 상태: {phaseLabels[phase]}</p>
        ) : null}
      </div>

      <div className="quick-analysis-steps-group" role="group" aria-label="분석 진행 단계" aria-busy={isBusy}>
        <ol className="quick-analysis-steps" aria-label="URL 분석 과정">
          {steps.map((step, index) => {
            const completed = phase === "completed" || index < stepIndex;
            const current = !completed && index === stepIndex;
            const state = completed ? "completed" : !current ? "pending"
              : phase === "failed" ? "failed" : phase === "paused" ? "paused" : "active";
            return (
              <li key={step} className="quick-analysis-step" data-state={state} aria-current={current ? "step" : undefined}>
                <span className="quick-analysis-step-icon" aria-hidden="true">
                  {completed ? <Check size={18} strokeWidth={2.6} />
                    : state === "failed" ? <X size={18} strokeWidth={2.4} />
                    : state === "paused" ? <Pause size={16} />
                    : current ? <span className="quick-analysis-spinner" data-spinning={isBusy}><Loader2 size={18} strokeWidth={2.4} /></span>
                    : index + 1}
                </span>
                <span className="quick-analysis-step-title">{step}</span>
                <span className="quick-analysis-step-label">{completed ? "완료" : current ? phaseLabels[phase] : "대기"}</span>
              </li>
            );
          })}
        </ol>
      </div>

      <div className="quick-analysis-actions">{children}</div>

      <div className="quick-analysis-visual" aria-hidden="true" data-scanning={phase === "running" && isBusy}>
        <div className="quick-analysis-browser-bar">
          <span className="quick-analysis-browser-controls">
            <span className="quick-analysis-browser-dots"><i /><i /><i /></span>
            <span className="quick-analysis-browser-nav"><ChevronLeft size={16} /><ChevronRight size={16} /></span>
          </span>
          <span className="quick-analysis-browser-address"><Lock size={11} strokeWidth={2.4} />{hostnameOf(url)}</span>
        </div>
        <div className="quick-analysis-browser-page">
          <div className="quick-analysis-browser-hero">
            <span className="quick-analysis-placeholder quick-analysis-placeholder--image" data-mark="1" />
            <div className="quick-analysis-browser-copy">
              <span className="quick-analysis-placeholder quick-analysis-placeholder--heading" />
              <span className="quick-analysis-placeholder" />
              <span className="quick-analysis-placeholder" />
              <span className="quick-analysis-placeholder quick-analysis-placeholder--short" />
              <span className="quick-analysis-placeholder quick-analysis-placeholder--button" data-mark="2" />
            </div>
          </div>
          <div className="quick-analysis-browser-grid">
            {[0, 1, 2].map(index => (
              <div key={index} className="quick-analysis-browser-tile">
                <span className="quick-analysis-placeholder quick-analysis-placeholder--image" data-mark={index === 1 ? "3" : undefined} />
                <span className="quick-analysis-placeholder" />
                <span className="quick-analysis-placeholder quick-analysis-placeholder--short" />
              </div>
            ))}
          </div>
          <div className="quick-analysis-scan" />
        </div>
      </div>
    </section>
  );
}

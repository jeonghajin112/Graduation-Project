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

type StepState = "completed" | "pending" | "failed" | "paused" | "active";

function stepIndexOf(phase: AnalysisPhase) {
  if (phase === "completed") return 2;
  return phase === "requesting" || phase === "queued" ? 0 : 1;
}

function progressTitle(phase: AnalysisPhase) {
  switch (phase) {
    case "failed": return "분석을 완료하지 못했습니다";
    case "paused": return "분석 상태를 다시 확인해 주세요";
    case "completed": return "분석이 완료되었습니다";
    case "queued": return "분석 순서를 기다리고 있습니다";
    default: return "페이지를 분석하고 있습니다";
  }
}

function stepStateOf(phase: AnalysisPhase, index: number, stepIndex: number): StepState {
  if (phase === "completed" || index < stepIndex) return "completed";
  if (index !== stepIndex) return "pending";
  return phase === "failed" || phase === "paused" ? phase : "active";
}

function stepIcon(state: StepState, index: number, isBusy: boolean): ReactNode {
  switch (state) {
    case "completed": return <Check size={18} strokeWidth={2.6} />;
    case "failed": return <X size={18} strokeWidth={2.4} />;
    case "paused": return <Pause size={16} />;
    case "active": return <span className="quick-analysis-spinner" data-spinning={isBusy}><Loader2 size={18} strokeWidth={2.4} /></span>;
    default: return index + 1;
  }
}

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
  const stepIndex = stepIndexOf(phase);
  const title = progressTitle(phase);

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
            const state = stepStateOf(phase, index, stepIndex);
            const completed = state === "completed";
            const current = !completed && state !== "pending";
            return (
              <li key={step} className="quick-analysis-step" data-state={state} aria-current={current ? "step" : undefined}>
                <span className="quick-analysis-step-icon" aria-hidden="true">
                  {stepIcon(state, index, isBusy)}
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

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CircleAlert } from "lucide-react";

export function analysisFailureMessage(code?: string | null): string {
  switch (code) {
    case "TARGET_PAGE_UNAVAILABLE":
      return "대상 페이지 접근 실패";
    case "PROCESS_TIMEOUT":
      return "분석 제한시간 초과";
    case "INVALID_RESULT":
      return "유효한 분석 결과 없음";
    case "ANALYSIS_FAILED":
      return "분석 처리 중 오류";
    default:
      return "분석 실패 · 원인 기록 없음";
  }
}

export function AnalysisFailureIndicator({ pageName, requestId, code, className }: {
  pageName: string; requestId: number; code?: string | null; className: string;
}) {
  const tooltipId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const tooltip = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const pinned = useRef(false);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const cancelClose = () => clearTimeout(timer.current);
  const close = () => { cancelClose(); pinned.current = false; setPosition(null); };
  const show = () => {
    cancelClose();
    const rect = trigger.current?.getBoundingClientRect();
    if (rect) setPosition({
      left: Math.max(12, Math.min(rect.right + 8, window.innerWidth - 252)),
      top: Math.max(12, Math.min(rect.top, window.innerHeight - 60))
    });
  };
  const scheduleClose = () => {
    cancelClose();
    if (!pinned.current && document.activeElement !== trigger.current) {
      timer.current = setTimeout(close, 150);
    }
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (!position) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !trigger.current?.contains(event.target)
          && !tooltip.current?.contains(event.target)) close();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.stopPropagation(); close(); }
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", escape, true);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", escape, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [position]);

  return <>
    <button ref={trigger} type="button" aria-label={`${pageName} 분석 실패 이유 보기`}
      aria-describedby={position ? tooltipId : undefined}
      className={`${className} cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--dashboard-accent)]`}
      data-analysis-request-id={requestId} data-analysis-status="FAILED"
      onMouseEnter={show} onMouseLeave={scheduleClose} onFocus={show}
      onBlur={() => { pinned.current = false; scheduleClose(); }}
      onClick={event => {
        event.stopPropagation();
        if (pinned.current) close();
        else { pinned.current = true; show(); }
      }}>
      <CircleAlert size={14} aria-hidden="true" />
    </button>
    {position && createPortal(<div ref={tooltip} id={tooltipId} role="tooltip"
      onMouseEnter={cancelClose} onMouseLeave={scheduleClose}
      className="fixed z-[100] rounded-md border border-[var(--border)] bg-[var(--popover)] px-2.5 py-1.5 text-xs leading-normal text-[var(--popover-foreground)] shadow-sm"
      style={{ ...position, width: "max-content", maxWidth: "min(240px, calc(100vw - 24px))" }}>
      {analysisFailureMessage(code)}
    </div>, document.body)}
  </>;
}

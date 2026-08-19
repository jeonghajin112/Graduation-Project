import { motion } from "framer-motion";
import { useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { SeverityLevel } from "@/types/accessibility-domain";

import { chartTokens } from "../../shared/constants";

const SEVERITY_TOOLTIP_WIDTH = 154;
const SEVERITY_TOOLTIP_HEIGHT = 96;
const SEVERITY_TOOLTIP_MARGIN = 8;

function getFloatingSeverityTooltipPosition(pointerX: number, pointerY: number) {
  if (typeof window === "undefined") {
    return { x: pointerX, y: pointerY };
  }

  return {
    x: Math.min(
      Math.max(pointerX, SEVERITY_TOOLTIP_MARGIN),
      Math.max(SEVERITY_TOOLTIP_MARGIN, window.innerWidth - SEVERITY_TOOLTIP_WIDTH - SEVERITY_TOOLTIP_MARGIN)
    ),
    y: Math.min(
      Math.max(pointerY, SEVERITY_TOOLTIP_MARGIN),
      Math.max(SEVERITY_TOOLTIP_MARGIN, window.innerHeight - SEVERITY_TOOLTIP_HEIGHT - SEVERITY_TOOLTIP_MARGIN)
    )
  };
}

export type SeverityBarRow = {
  severity: SeverityLevel;
  label: string;
  count: number;
  roundedPercentage: number;
  color: string;
  heightPercentage: number;
};

export function CurrentOpenIssuesCard({
  issueCount,
  rows,
  labelColor,
  valueColor,
  unitColor
}: {
  issueCount: number;
  rows: SeverityBarRow[];
  labelColor: string;
  valueColor: string;
  unitColor: string;
}) {
  const severityBarRef = useRef<HTMLDivElement | null>(null);
  const [hoveredSeveritySegment, setHoveredSeveritySegment] = useState<{ severity: SeverityLevel; x: number; y: number } | null>(null);
  const activeSeveritySegment = hoveredSeveritySegment
    ? rows.find((segment) => segment.severity === hoveredSeveritySegment.severity) ?? null
    : null;

  return (
    <article
      className={`dashboard-card relative flex min-h-0 flex-col overflow-visible rounded-xl border border-slate-200 bg-white p-1 ${
        hoveredSeveritySegment ? "z-[140]" : "z-10"
      }`}
    >
      <div className="relative flex items-center gap-0.5 px-3 pt-3">
        <p className="text-sm font-semibold text-slate-900">현재 미해결 이슈</p>
      </div>

      <div className="relative mt-2 flex min-h-0 flex-1 flex-col overflow-visible rounded-[28px] bg-white pt-3">
        <div className="min-w-0 px-5">
          <p className="text-[11px] font-semibold tracking-[0.08em]" style={{ color: labelColor }}>
            심각도별 비율
          </p>
          <p
            className="-ml-1 mt-0.5 text-[2rem] font-bold leading-none tracking-[-0.05em]"
            style={{ color: valueColor }}
          >
            <span className="tracking-normal">{issueCount}</span>
            <span className="ml-1 text-xl font-semibold tracking-normal" style={{ color: unitColor }}>
              건
            </span>
          </p>
        </div>

        <div ref={severityBarRef} className="relative mt-auto flex min-h-[156px] flex-col justify-center gap-2 px-8 pb-3">
          <div
            role="img"
            aria-label={`현재 미해결 이슈 ${issueCount}건. ${rows
              .map((segment) => `${segment.label} ${segment.count}건`)
              .join(", ")}`}
            className="min-w-0"
          >
            {issueCount === 0 ? (
              <div className="flex h-16 w-full items-center justify-center rounded-2xl border border-slate-200/70 bg-slate-100/70 text-xs font-medium text-slate-500">
                미해결 이슈가 없습니다.
              </div>
            ) : (
              <div className="min-w-0">
                <div className="grid min-w-0 grid-cols-4 gap-4">
                  {rows.map((segment) => (
                    <div key={`${segment.severity}-bar`} className="flex min-w-0 flex-col items-center">
                      <div className="flex h-20 w-full items-end justify-center">
                        <motion.button
                          type="button"
                          aria-label={`${segment.label} ${segment.count}건, ${segment.roundedPercentage}%`}
                          className="flex w-[78%] cursor-pointer items-start justify-center rounded-xl border border-white/10 px-1 pt-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.12)] transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80"
                          style={{
                            backgroundColor: segment.color,
                            opacity:
                              hoveredSeveritySegment?.severity === segment.severity ? 0.98 : hoveredSeveritySegment ? 0.68 : 0.84
                          }}
                          initial={{ height: 0 }}
                          animate={{ height: `${segment.heightPercentage}%` }}
                          transition={{ duration: 0.65, ease: [0.22, 1, 0.36, 1] }}
                          onMouseMove={(event) => {
                            const tooltipPosition = getFloatingSeverityTooltipPosition(event.clientX + 12, event.clientY - 18);
                            setHoveredSeveritySegment({
                              severity: segment.severity,
                              x: tooltipPosition.x,
                              y: tooltipPosition.y
                            });
                          }}
                          onFocus={(event) => {
                            const segmentRect = event.currentTarget.getBoundingClientRect();
                            const tooltipPosition = getFloatingSeverityTooltipPosition(
                              segmentRect.left + segmentRect.width / 2,
                              segmentRect.top - 18
                            );
                            setHoveredSeveritySegment({
                              severity: segment.severity,
                              x: tooltipPosition.x,
                              y: tooltipPosition.y
                            });
                          }}
                          onMouseLeave={() => setHoveredSeveritySegment(null)}
                          onBlur={() => setHoveredSeveritySegment(null)}
                        />
                      </div>
                    </div>
                  ))}
                </div>
                <div className="mt-0 h-px w-full bg-slate-200/80" />
                <div className="mt-1 grid min-w-0 grid-cols-4 gap-4">
                  {rows.map((segment) => (
                    <div key={`${segment.severity}-label`} className="min-w-0 text-center">
                      <p className="text-xs font-bold text-slate-900">{segment.roundedPercentage}%</p>
                      <p className="mt-0.5 truncate text-[11px] font-semibold" style={{ color: "#64748b" }}>
                        {segment.label}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {activeSeveritySegment && hoveredSeveritySegment && typeof document !== "undefined" && createPortal(
            <div
              role="tooltip"
              className="pointer-events-none fixed z-[9999] min-w-32 rounded-lg px-3 py-2 text-left"
              style={{
                left: hoveredSeveritySegment.x,
                top: hoveredSeveritySegment.y,
                backgroundColor: "rgba(8, 8, 10, 0.96)",
                border: "1px solid rgba(255, 255, 255, 0.08)"
              }}
            >
              <p className="text-[11px] font-semibold" style={{ color: chartTokens.tooltipSubtle }}>
                현재 미해결 이슈
              </p>
              <p className="mt-1 text-sm font-bold" style={{ color: chartTokens.tooltipText }}>
                {activeSeveritySegment.label} {activeSeveritySegment.count}건
              </p>
              <p className="mt-1 text-[11px]" style={{ color: chartTokens.tooltipSubtle }}>
                전체 {issueCount}건 중 {activeSeveritySegment.roundedPercentage}%
              </p>
            </div>,
            document.body
          )}
        </div>
      </div>
    </article>
  );
}

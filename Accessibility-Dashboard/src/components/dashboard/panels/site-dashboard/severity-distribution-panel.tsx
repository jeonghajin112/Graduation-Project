import { useMemo, type CSSProperties } from "react";

import type { IssueResultModel } from "@/types/accessibility-domain";

import { severityChartItems } from "./constants";

type SeverityDistributionPanelProps = {
  issues: IssueResultModel[];
};

const MIN_VISIBLE_BAR_PERCENT = 5;

export function getSeverityBarHeightPercent(count: number, total: number): number {
  if (count <= 0 || total <= 0) {
    return 0;
  }

  return Math.max((count / total) * 100, MIN_VISIBLE_BAR_PERCENT);
}

/**
 * Severity mix for the latest completed analysis, drawn as one stacked bar
 * (proportions) with a colour legend underneath. Counts are derived from the
 * same issue list the replay overlay renders, so the rail can never disagree
 * with the markers drawn on the page. Per-severity counts stay out of the
 * resting view and surface in the segment tooltip on hover or focus.
 */
export function SeverityDistributionPanel({ issues }: SeverityDistributionPanelProps) {
  // 범례에는 비율만 보이고, 건수는 막대 조각의 툴팁에서만 보인다.
  const rows = useMemo(() => {
    const countByKey = new Map(severityChartItems.map((item) => [item.key, 0]));

    for (const issue of issues) {
      const current = countByKey.get(issue.severity);
      if (current !== undefined) {
        countByKey.set(issue.severity, current + 1);
      }
    }

    const total = issues.length;
    return severityChartItems.map((item) => {
      const count = countByKey.get(item.key) ?? 0;
      return {
        ...item,
        count,
        percent: total > 0 ? Math.round((count / total) * 100) : 0,
        // Rare non-zero severities keep a visible, hoverable sliver; the
        // tooltip still reports the exact count.
        widthPercent: getSeverityBarHeightPercent(count, total)
      };
    });
  }, [issues]);
  const total = issues.length;

  if (total === 0) {
    return null;
  }

  const segments = rows.filter((row) => row.count > 0);
  const summary = segments
    .map((row) => `${row.label} ${row.count.toLocaleString("ko-KR")}건`)
    .join(", ");

  return (
    <section className="site-rail-card site-rail-severity-card" aria-labelledby="site-rail-severity-heading">
      <div className="site-rail-card__heading site-rail-severity__heading">
        <h3 id="site-rail-severity-heading">심각도 분포</h3>
        <span className="site-rail-severity__total">
          {total.toLocaleString("ko-KR")}건
        </span>
      </div>

      <div className="site-rail-severity__track" role="group" aria-label={`심각도별 구성: ${summary}`}>
        {segments.map((row) => {
          const style = {
            "--site-severity-color": row.color,
            flexBasis: `${row.widthPercent}%`
          } as CSSProperties;

          return (
            <span
              key={row.key}
              className="site-rail-severity__row"
              tabIndex={0}
              aria-label={`${row.label} ${row.count.toLocaleString("ko-KR")}건`}
              style={style}
            >
              <span className="site-rail-severity__fill" aria-hidden="true" />
              <span className="site-rail-severity__tooltip" aria-hidden="true">
                {row.label} · {row.count.toLocaleString("ko-KR")}건
              </span>
            </span>
          );
        })}
      </div>

      <ul className="site-rail-severity__legend" aria-hidden="true">
        {rows.map((row) => (
          <li key={row.key} style={{ "--site-severity-color": row.color } as CSSProperties}>
            <span className="site-rail-severity__dot" />
            <span className="site-rail-severity__name">{row.label}</span>
            <span className="site-rail-severity__percent">{row.percent}%</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

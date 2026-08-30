import { useMemo } from "react";

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
 * Severity mix for the latest completed analysis. Counts are derived from the
 * same issue list the replay overlay renders, so the rail can never disagree
 * with the markers drawn on the page.
 */
export function SeverityDistributionPanel({ issues }: SeverityDistributionPanelProps) {
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
        // Preserve small non-zero categories as a visible, hoverable mark. The
        // tooltip still reports the exact count, so the minimum is only a
        // visual floor rather than a replacement for the underlying value.
        heightPercent: getSeverityBarHeightPercent(count, total)
      };
    });
  }, [issues]);
  const total = issues.length;

  if (total === 0) {
    return null;
  }

  return (
    <section className="site-rail-card" aria-labelledby="site-rail-severity-heading">
      <div className="site-rail-card__heading">
        <h3 id="site-rail-severity-heading">심각도 분포</h3>
        <p>발견된 문제를 심각도별로 보여줍니다.</p>
      </div>

      <ul className="site-rail-severity">
        {rows.map((row) => (
          <li
            key={row.key}
            className="site-rail-severity__row"
            tabIndex={0}
            aria-label={`${row.label} ${row.count.toLocaleString("ko-KR")}건`}
          >
            <span className="site-rail-severity__name" aria-hidden="true">
              {row.label}
            </span>
            <span className="site-rail-severity__track" aria-hidden="true">
              <span
                className="site-rail-severity__fill"
                style={{ height: `${row.heightPercent}%` }}
              >
                <span className="site-rail-severity__tooltip">
                  {row.label} · {row.count.toLocaleString("ko-KR")}건
                </span>
              </span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

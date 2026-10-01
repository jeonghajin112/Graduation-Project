import { CircleCheck, CircleSlash, TriangleAlert, UserRound } from "lucide-react";

import { formatIssueCodeLabel } from "./constants";
import type { CriteriaOverview, CriterionResult, CriterionStatus } from "./kwcag-criteria";

const statusLabels: Record<CriterionStatus, string> = {
  fail: "문제 있음",
  pass: "문제 없음",
  skipped: "검사 못 함",
  manual: "직접 확인"
};

const statusOrder: CriterionStatus[] = ["fail", "pass", "skipped", "manual"];

function StatusIcon({ status }: { status: CriterionStatus }) {
  const Icon = status === "fail" ? TriangleAlert : status === "pass" ? CircleCheck : status === "skipped" ? CircleSlash : UserRound;
  return <Icon size={14} aria-hidden="true" className="site-final-report__criterion-icon" />;
}

/**
 * All 33 KWCAG criteria by principle. Each state has its own icon and words,
 * so the grid reads without color. Criteria with issues jump to their group
 * in the issue list.
 */
export function ReportCriteriaOverview({ overview, onShowCriterion }: {
  overview: CriteriaOverview;
  onShowCriterion: (code: string) => void;
}) {
  return (
    <div className="site-final-report__criteria">
      <div className="site-final-report__criteria-head">
        <h4 id="site-final-report-criteria">KWCAG 33개 검사 항목</h4>
        <ul className="site-final-report__criteria-legend" aria-label="항목 상태별 개수">
          {statusOrder.map((status) => (
            <li key={status} data-status={status}>
              <StatusIcon status={status} />
              {statusLabels[status]} <strong>{overview.counts[status]}</strong>
            </li>
          ))}
        </ul>
      </div>
      <p className="site-final-report__lead">
        ‘문제 없음’은 자동 검사가 확인한 범위에서 문제가 없었다는 뜻이며 준수를 보장하지 않습니다.
        ‘직접 확인’ 항목은 자동 검사 대상이 아니므로 사람이 점검해야 합니다.
      </p>
      <div className="site-final-report__principles">
        {overview.principles.map((principle, index) => {
          const fails = principle.criteria.filter((criterion) => criterion.status === "fail").length;
          const headingId = `site-final-report-principle-${index}`;
          return (
            <section key={principle.name} className="site-final-report__principle" aria-labelledby={headingId}>
              <h5 id={headingId}>
                {principle.name}
                <span>{principle.criteria.length}개 중 문제 {fails}개</span>
              </h5>
              <ul>
                {principle.criteria.map((criterion) => (
                  <li key={criterion.code} data-status={criterion.status}>
                    {criterion.status === "fail" ? (
                      <button type="button" className="site-final-report__criterion" onClick={() => onShowCriterion(criterion.code)}>
                        <CriterionContent criterion={criterion} />
                      </button>
                    ) : (
                      <div className="site-final-report__criterion">
                        <CriterionContent criterion={criterion} />
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
      {overview.others.length > 0 && (
        <p className="site-final-report__criteria-others">
          <span>33개 항목 밖의 문제</span>
          {overview.others.map((other) => (
            <button key={other.code} type="button" className="site-final-report__button site-final-report__link"
              onClick={() => onShowCriterion(other.code)}>
              {formatIssueCodeLabel(other.code)} {other.count.toLocaleString("ko-KR")}건
            </button>
          ))}
        </p>
      )}
    </div>
  );
}

function CriterionContent({ criterion }: { criterion: CriterionResult }) {
  return (
    <>
      <span className="site-final-report__criterion-code">{criterion.code}</span>
      <span className="site-final-report__criterion-name">{criterion.name}</span>
      <span className="site-final-report__criterion-status">
        <StatusIcon status={criterion.status} />
        {criterion.status === "fail" ? `문제 ${criterion.count.toLocaleString("ko-KR")}건` : statusLabels[criterion.status]}
      </span>
    </>
  );
}

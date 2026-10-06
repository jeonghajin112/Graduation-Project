import { CircleCheck, CircleSlash, TriangleAlert, UserRound } from "lucide-react";

import { formatIssueCodeLabel } from "./constants";
import type { CriteriaOverview, CriterionResult, CriterionStatus } from "./kwcag-criteria";

const statusLabels: Record<CriterionStatus, string> = {
  fail: "문제 있음",
  pass: "문제 없음",
  skipped: "검사 못 함",
  manual: "직접 확인"
};

function StatusIcon({ status }: { status: CriterionStatus }) {
  const Icon = status === "fail" ? TriangleAlert : status === "pass" ? CircleCheck : status === "skipped" ? CircleSlash : UserRound;
  return <Icon size={14} aria-hidden="true" className="site-final-report__criterion-icon" />;
}

/**
 * All 33 KWCAG criteria by principle, one card per principle. Each state has
 * its own icon and words, so the grid reads without color. Criteria with
 * issues jump to their group in the issue list.
 */
export function ReportCriteriaOverview({ overview, onShowCriterion }: {
  overview: CriteriaOverview;
  onShowCriterion: (code: string) => void;
}) {
  return (
    <>
      <h3 id="site-final-report-criteria" className="site-final-report__title">
        KWCAG 33개 검사 항목
      </h3>
      <p className="site-final-report__lead">
        ‘문제 없음’은 자동 검사가 확인한 범위에서 문제가 없었다는 뜻이며 준수를 보장하지 않습니다.
        ‘직접 확인’ 항목은 자동 검사 대상이 아니므로 사람이 점검해야 합니다.
      </p>
      <div className={`site-final-report__principles${overview.others.length > 0 ? " site-final-report__principles--with-others" : ""}`}>
        {overview.principles.map((principle, index) => {
          const fails = principle.criteria.filter((criterion) => criterion.status === "fail").length;
          const headingId = `site-final-report-principle-${index}`;
          return (
            <section key={principle.name} className="site-final-report__principle" aria-labelledby={headingId}>
              <h4 id={headingId}>
                {principle.name}
                <span>{principle.criteria.length}개 중 문제 {fails}개</span>
              </h4>
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
        {/* Findings outside the 33 criteria get their own column in the same
            card style, named in Korean with the engine's code underneath. */}
        {overview.others.length > 0 && (
          <section className="site-final-report__principle site-final-report__principle--others"
            aria-labelledby="site-final-report-principle-others">
            <h4 id="site-final-report-principle-others">
              33개 항목 밖
              <span>문제 {overview.others.length}개</span>
            </h4>
            <ul>
              {overview.others.map((other) => (
                <li key={other.code} data-status="fail">
                  <button type="button" className="site-final-report__criterion site-final-report__criterion--other"
                    onClick={() => onShowCriterion(other.code)}>
                    <span className="site-final-report__criterion-name">
                      <span className="site-final-report__criterion-code">{formatIssueCodeLabel(other.code) || other.code}</span>
                      {other.name}
                    </span>
                    <span className="site-final-report__criterion-status">
                      <StatusIcon status="fail" />
                      문제 {other.count.toLocaleString("ko-KR")}건 ›
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </>
  );
}

function CriterionContent({ criterion }: { criterion: CriterionResult }) {
  return (
    <>
      <span className="site-final-report__criterion-name">
        <span className="site-final-report__criterion-code">{criterion.code}</span>
        {criterion.name}
      </span>
      <span className="site-final-report__criterion-status">
        <StatusIcon status={criterion.status} />
        {criterion.status === "fail" ? `문제 ${criterion.count.toLocaleString("ko-KR")}건 ›` : statusLabels[criterion.status]}
      </span>
    </>
  );
}

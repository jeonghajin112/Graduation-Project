import {
  ArrowUpRight, CalendarClock, CircleCheck, CircleSlash, ListTree, Printer, RefreshCw, TrendingUp, TriangleAlert, UserRound
} from "lucide-react";
import { KWCAG_LANDING_PRINCIPLES, type LandingCriterion } from "@/components/landing/landing-kwcag";
import { LandingReportTrend } from "@/components/landing/landing-trend";

/**
 * 최종 리포트 소개. 실제 최종 리포트 화면(final-report-panel.tsx, report-criteria-overview.tsx)과 같은 모양으로
 * 머리글 칩, 점수·문제·검사 범위 타일, KWCAG 33개 항목 카드를 그린다. 실제 화면을 바꾸면 이 그림도 함께 고칠 것.
 * 점수·문제 수·심각도·검사별 건수·항목별 건수·추이는 모두 2026-10-08 국세청 누리집 실제 분석 결과다 (아래 각주로 밝힌다).
 */

const SEVERITY = [
  { label: "심각", count: 0, tone: "critical" },
  { label: "높음", count: 12, tone: "high" },
  { label: "중간", count: 125, tone: "medium" },
  { label: "낮음", count: 24, tone: "low" }
] as const;

const ENGINES = [
  { label: "규칙", count: 7 },
  { label: "텍스트", count: 34 },
  { label: "시각", count: 120 }
] as const;

// 직전 분석(10월 1일 03:42)의 문제 수. 실제 리포트처럼 줄어든 건수를 보여 준다.
const PREVIOUS_TOTAL = 181;

// KWCAG 항목 밖에서 찾은 문제 (실제 리포트의 '33개 항목 밖' 카드).
const OTHERS = [{ code: "WCAG 3.1.5", name: "읽기 수준", count: 21 }] as const;

const STATUS_ICON = { size: 14, "aria-hidden": true, className: "ua-report__criterion-icon" } as const;

function CriterionStatus({ criterion }: { criterion: LandingCriterion }) {
  if (!criterion.automated) {
    return <span className="ua-report__criterion-status" data-status="manual"><UserRound {...STATUS_ICON} />직접 확인</span>;
  }
  if (criterion.sample === undefined) {
    return <span className="ua-report__criterion-status" data-status="skipped"><CircleSlash {...STATUS_ICON} />검사 못 함</span>;
  }
  if (criterion.sample > 0) {
    return <span className="ua-report__criterion-status" data-status="fail"><TriangleAlert {...STATUS_ICON} />문제 {criterion.sample}건 ›</span>;
  }
  return <span className="ua-report__criterion-status" data-status="pass"><CircleCheck {...STATUS_ICON} />문제 없음</span>;
}

export function LandingReportSection() {
  const total = SEVERITY.reduce((sum, item) => sum + item.count, 0);

  return (
    <section className="ua-report" id="report" aria-labelledby="ua-report-title">
      <div className="ua-shell">
        <p className="ua-eyebrow">최종 리포트</p>
        <h2 className="ua-heading" id="ua-report-title">33개 항목을 한 장에.<br /><span className="ua-heading__soft">인쇄해도 그대로.</span></h2>
        <p className="ua-lede">검사가 끝나면 KWCAG 2.2의 모든 기준을 한 장에 모아 보여 줘요. 기준마다 <b>문제가 몇 건인지</b> 바로 보여요.</p>

        <figure className="ua-report__paper">
          <div className="ua-report__header">
            <p className="ua-report__page-label">분석 페이지</p>
            <p className="ua-report__target">국세청</p>
            <div className="ua-report__meta-row">
              <span className="ua-report__chip">www.nts.go.kr/<ArrowUpRight size={14} aria-hidden="true" /></span>
              <span className="ua-report__chip">
                <CalendarClock size={14} aria-hidden="true" />2026-10-08 19:49
                <span className="ua-report__rescan" aria-hidden="true"><RefreshCw size={12} />재분석</span>
              </span>
              <span className="ua-report__print" aria-hidden="true"><Printer size={14} />인쇄 · PDF 저장</span>
            </div>
          </div>

          <div className="ua-report__tiles">
            <div className="ua-report__tile ua-report__tile--score">
              <div>
                <dl className="ua-report__figure">
                  <dt>접근성 점수</dt>
                  <dd>64.8<small>점</small><span className="ua-report__change">+0.6점</span></dd>
                </dl>
                <p className="ua-report__tile-note">최근 5번의 분석 기록입니다.</p>
              </div>
              <LandingReportTrend />
            </div>

            <div className="ua-report__tile">
              <dl className="ua-report__figure">
                <dt>발견된 문제</dt>
                <dd>{total}<small>건</small></dd>
              </dl>
              <p className="ua-report__delta is-better">지난 분석보다 {PREVIOUS_TOTAL - total}건 줄었습니다</p>
              <div className="ua-report__bar" aria-hidden="true">
                {SEVERITY.filter(item => item.count > 0).map(item => (
                  <i key={item.label} className={`is-${item.tone}`} style={{ flexGrow: item.count }} />
                ))}
              </div>
              <ul className="ua-report__rows" aria-label="심각도별 문제 수">
                {SEVERITY.map(item => (
                  <li key={item.label}><i className={`ua-report__dot is-${item.tone}`} aria-hidden="true" />{item.label}<b>{item.count}건</b></li>
                ))}
              </ul>
            </div>

            <div className="ua-report__tile">
              <dl className="ua-report__figure">
                <dt>검사 범위</dt>
                <dd>{ENGINES.length}<small>/{ENGINES.length} 완료</small></dd>
              </dl>
              <p className="ua-report__delta">모든 검사를 마쳤습니다</p>
              <ul className="ua-report__rows ua-report__rows--engines" aria-label="검사별 문제 수">
                {ENGINES.map(item => (
                  <li key={item.label}><CircleCheck size={16} aria-hidden="true" />{item.label} 검사<b>{item.count}건</b></li>
                ))}
              </ul>
            </div>
          </div>

          <h3 className="ua-report__title">KWCAG 33개 검사 항목</h3>
          <p className="ua-report__lead">
            ‘문제 없음’은 자동 검사가 확인한 범위에서 문제가 없었다는 뜻이며 준수를 보장하지 않습니다.
            ‘직접 확인’ 항목은 자동 검사 대상이 아니므로 사람이 점검해야 합니다.
          </p>
          <div className="ua-report__principles">
            {KWCAG_LANDING_PRINCIPLES.map(principle => {
              const problems = principle.criteria.filter(criterion => (criterion.sample ?? 0) > 0).length;
              // 운용의 용이성(15개)은 다른 원칙 두 개를 합친 만큼 길다.
              const tall = principle.criteria.length >= 12;
              return (
                <section className={`ua-report__column${tall ? " ua-report__column--tall" : ""}`} key={principle.name} aria-label={principle.name}>
                  <h4>{principle.name}<span>{principle.criteria.length}개 중 문제 {problems}개</span></h4>
                  <ul>
                    {principle.criteria.map(criterion => (
                      <li key={criterion.code}>
                        <span className="ua-report__criterion-name"><span className="ua-report__code">{criterion.code}</span>{criterion.name}</span>
                        <CriterionStatus criterion={criterion} />
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
            <section className="ua-report__others" aria-label="33개 항목 밖">
              <h4>33개 항목 밖<span>문제 {OTHERS.length}개</span></h4>
              <ul>
                {OTHERS.map(other => (
                  <li key={other.code}>
                    <span className="ua-report__criterion-name"><span className="ua-report__code">{other.code}</span>{other.name}</span>
                    <span className="ua-report__criterion-status" data-status="fail"><TriangleAlert {...STATUS_ICON} />문제 {other.count}건 ›</span>
                  </li>
                ))}
              </ul>
            </section>
          </div>
          <figcaption className="ua-report__note">2026년 10월 8일 국세청 누리집 분석 결과예요. 문제 161건 가운데 21건은 KWCAG 항목 밖의 읽기 수준(WCAG 3.1.5) 문제예요.</figcaption>
        </figure>

        <ul className="ua-report__features">
          <li><Printer size={26} strokeWidth={1.6} aria-hidden="true" /><b>필터와 관계없이 전체 인쇄</b><span>화면에서 거른 결과와 상관없이 모든 문제가 인쇄돼요.</span></li>
          <li><ListTree size={26} strokeWidth={1.6} aria-hidden="true" /><b>항목별로 묶은 상세 문제</b><span>같은 설명은 한 번만, 문제는 한 줄씩. 펼치면 HTML과 값까지 보여요.</span></li>
          <li><TrendingUp size={26} strokeWidth={1.6} aria-hidden="true" /><b>지난 분석과 비교</b><span>점수와 문제 수가 지난번보다 어떻게 바뀌었는지 보여요.</span></li>
        </ul>
      </div>
    </section>
  );
}

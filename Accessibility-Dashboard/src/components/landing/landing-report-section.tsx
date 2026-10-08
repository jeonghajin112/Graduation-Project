import { ListTree, Printer, TrendingUp } from "lucide-react";
import { KWCAG_LANDING_PRINCIPLES, type LandingCriterion } from "@/components/landing/landing-kwcag";
import { LandingTrend } from "@/components/landing/landing-trend";

/**
 * 최종 리포트 소개. 실제 리포트처럼 항상 흰 용지 위에 요약과 KWCAG 33개 항목 그리드를 그린다.
 * 점수·문제 수·심각도·항목별 건수·추이는 모두 2026-10-08 국세청 누리집 실제 분석 결과다 (아래 각주로 밝힌다).
 */

const SEVERITY = [
  { label: "심각", count: 0, tone: "critical" },
  { label: "높음", count: 12, tone: "high" },
  { label: "중간", count: 125, tone: "medium" },
  { label: "낮음", count: 24, tone: "low" }
] as const;

function CriterionStatus({ criterion }: { criterion: LandingCriterion }) {
  if (!criterion.automated) {
    return (
      <span className="ua-report__status">
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="4" r="2.2" fill="none" stroke="currentColor" strokeWidth="1.3" /><path d="M2 11c.6-2.2 2.2-3.2 4-3.2s3.4 1 4 3.2" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>
        직접 확인
      </span>
    );
  }
  if (criterion.sample === undefined) {
    return (
      <span className="ua-report__status">
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 6h7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
        검사 못 함
      </span>
    );
  }
  if (criterion.sample > 0) {
    return (
      <span className="ua-report__status is-problem">
        <svg width="8" height="8" aria-hidden="true"><circle cx="4" cy="4" r="3.5" fill="currentColor" /></svg>
        {criterion.sample}건
      </span>
    );
  }
  return (
    <span className="ua-report__status is-pass">
      <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="m2 6.5 2.6 2.5L10 3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
      문제 없음
    </span>
  );
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
          <div className="ua-report__head">
            <div className="ua-report__site">
              <strong>국세청</strong>
              <span>https://www.nts.go.kr/</span>
            </div>
            <dl className="ua-report__meta">
              <dt>진단 기준</dt><dd>KWCAG 2.2 · 33개 항목</dd>
              <dt>진단 일자</dt><dd>2026-10-08 19:49</dd>
              <dt>분석기</dt><dd>규칙 · 텍스트 · 시각</dd>
            </dl>
          </div>

          <div className="ua-report__summary">
            <div className="ua-report__tile">
              <span className="ua-report__label">접근성 점수 · 최근 5회</span>
              <div className="ua-report__score-row">
                <span className="ua-report__value">64.8<small>점</small><span className="ua-report__delta">+0.6</span></span>
                <LandingTrend className="ua-report__trend" width={300} height={70} />
              </div>
            </div>
            <div className="ua-report__tile">
              <span className="ua-report__label">발견한 문제</span>
              <span className="ua-report__value">{total}<small>건</small></span>
              <div className="ua-report__bar" aria-hidden="true">
                {SEVERITY.filter(item => item.count > 0).map(item => (
                  <i key={item.label} className={`is-${item.tone}`} style={{ flexGrow: item.count }} />
                ))}
              </div>
              <ul className="ua-report__legend">
                {SEVERITY.map(item => <li key={item.label} className={`is-${item.tone}`}>{item.label} <b>{item.count}</b></li>)}
              </ul>
            </div>
          </div>

          <div className="ua-report__grid-head">
            <h3>KWCAG 2.2 검사 항목</h3>
            <span>문제 · 문제 없음 · 직접 확인 · 검사 못 함</span>
          </div>
          <div className="ua-report__grid">
            {KWCAG_LANDING_PRINCIPLES.map(principle => {
              const problems = principle.criteria.filter(criterion => (criterion.sample ?? 0) > 0).length;
              return (
                <section className="ua-report__column" key={principle.name} aria-label={principle.name}>
                  <h4>{principle.name}<span>{problems ? `문제 ${problems}개 항목` : "문제 없음"}</span></h4>
                  <ul>
                    {principle.criteria.map(criterion => (
                      <li key={criterion.code}>
                        <span className="ua-report__code">{criterion.code}</span>
                        <span className="ua-report__name">{criterion.name}</span>
                        <CriterionStatus criterion={criterion} />
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
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

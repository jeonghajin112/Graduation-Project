import { useEffect, useRef, useState } from "react";
import { KWCAG_LANDING_PRINCIPLES } from "@/components/landing/landing-kwcag";

const criteria = KWCAG_LANDING_PRINCIPLES.flatMap(principle => principle.criteria);
const automated = criteria.filter(criterion => criterion.automated).length;
const COUNT_MS = 900;

type Stat = { label: string; value: string; count?: number; unit?: string; accent?: boolean; body: string };

const STATS: readonly Stat[] = [
  { label: "분석기", value: "3", count: 3, unit: "개", body: "규칙, 문장, 색을 세 가지 방법으로 검사해요." },
  { label: "KWCAG 2.2 기준", value: String(criteria.length), count: criteria.length, unit: "개", body: "국내 기준을 빠짐없이 한 장에 모아요." },
  { label: "자동 검사", value: String(automated), count: automated, unit: "개", accent: true, body: `나머지 ${criteria.length - automated}개는 사람이 직접 봐야 한다고 알려 줘요.` },
  { label: "점수 계산", value: "50·30·20", body: "세 결과를 이 비율로 더해요." }
];

/**
 * 검사 범위를 큰 숫자로. 항목 수는 landing-kwcag.ts 표에서 계산한다.
 * 숫자는 섹션이 처음 화면에 들어올 때 한 번만 0에서 빠르게 차오른다. 모션 축소 설정에서는 바로 최종 값을 보여 준다.
 * 보조 기술에는 차오르는 중간 값 대신 최종 값만 전달한다.
 */
export function LandingStatsSection() {
  const gridRef = useRef<HTMLDListElement>(null);
  const [progress, setProgress] = useState(1);

  useEffect(() => {
    const grid = gridRef.current;
    if (!grid || typeof IntersectionObserver === "undefined") return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let raf = 0;
    setProgress(0);
    const run = () => {
      cancelAnimationFrame(raf);
      const start = performance.now();
      const tick = (now: number) => {
        const t = Math.min(1, (now - start) / COUNT_MS);
        setProgress(1 - Math.pow(1 - t, 3));
        if (t < 1) raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    };
    // 처음 화면에 들어올 때 한 번만 차오르고, 그 뒤로는 최종 값 그대로 둔다
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return;
      observer.disconnect();
      run();
    }, { threshold: 0.4 });
    observer.observe(grid);
    return () => { observer.disconnect(); cancelAnimationFrame(raf); };
  }, []);

  return (
    <section className="ua-stats" aria-labelledby="ua-stats-title">
      <div className="ua-shell">
        <h2 className="ua-heading" id="ua-stats-title">숫자로 보는 검사 범위.</h2>
        <dl className="ua-stats__grid" ref={gridRef}>
          {STATS.map(stat => (
            <div className="ua-stats__item" key={stat.label}>
              <dt>{stat.label}</dt>
              <dd className={`ua-stats__value${stat.accent ? " is-accent" : ""}`} data-value={stat.value}>
                {stat.count === undefined ? stat.value : (
                  <>
                    <span className="ua-stats__count" aria-hidden="true" style={{ minWidth: `${stat.value.length}ch` }}>{Math.round(stat.count * progress)}</span>
                    <span className="sr-only">{stat.value}</span>
                  </>
                )}
                {stat.unit ? <small>{stat.unit}</small> : null}
              </dd>
              <dd className="ua-stats__body">{stat.body}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}

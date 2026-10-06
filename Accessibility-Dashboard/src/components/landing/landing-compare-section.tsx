import { KWCAG_LANDING_PRINCIPLES } from "@/components/landing/landing-kwcag";

/** 자동 분석으로 찾는 항목과 사람이 함께 확인할 항목. 항목 번호는 landing-kwcag.ts 표와 일치해야 한다. */
const criteria = KWCAG_LANDING_PRINCIPLES.flatMap(principle => principle.criteria);
const automated = criteria.filter(criterion => criterion.automated).length;

const AUTOMATIC = [
  { text: "대체 텍스트가 있는지", code: "5.1.1" },
  { text: "글자와 배경의 명도 대비", code: "5.4.3" },
  { text: "링크와 버튼의 이름", code: "6.4.3" },
  { text: "페이지와 영역의 제목", code: "6.4.2" },
  { text: "입력란의 레이블", code: "7.3.2" }
] as const;

const HUMAN = [
  { text: "키보드 초점이 순서대로 보이는지", code: "6.1.2" },
  { text: "읽는 순서가 자연스러운지", code: "5.3.2" },
  { text: "깜빡임과 번쩍임", code: "6.3.1" },
  { text: "보이는 레이블과 접근 가능한 이름", code: "6.5.3" },
  { text: "접근 가능한 인증", code: "7.3.3" }
] as const;

const check = <svg width="18" height="18" viewBox="0 0 12 12" aria-hidden="true"><path d="m2 6.5 2.6 2.5L10 3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>;
const person = <svg width="18" height="18" viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="4" r="2.2" fill="none" stroke="currentColor" strokeWidth="1.2" /><path d="M2 11c.6-2.2 2.2-3.2 4-3.2s3.4 1 4 3.2" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /></svg>;

export function LandingCompareSection() {
  return (
    <section className="ua-compare" aria-labelledby="ua-compare-title">
      <div className="ua-shell">
        <p className="ua-eyebrow">검사 범위</p>
        <h2 className="ua-heading" id="ua-compare-title">자동으로 찾는 것,<br /><span className="ua-heading__soft">함께 확인할 것.</span></h2>
        <div className="ua-compare__grid">
          <div className="ua-compare__column">
            <h3>uniaccess가 자동으로</h3>
            <p>{automated}개 항목을 분석기가 검사해요.</p>
            <ul>{AUTOMATIC.map(item => <li key={item.code}><span className="is-auto">{check}</span>{item.text}<code>{item.code}</code></li>)}</ul>
          </div>
          <div className="ua-compare__column is-human">
            <h3>사람이 함께</h3>
            <p>{criteria.length - automated}개 항목은 리포트에 ‘직접 확인’으로 안내해요.</p>
            <ul>{HUMAN.map(item => <li key={item.code}><span>{person}</span>{item.text}<code>{item.code}</code></li>)}</ul>
          </div>
        </div>
      </div>
    </section>
  );
}

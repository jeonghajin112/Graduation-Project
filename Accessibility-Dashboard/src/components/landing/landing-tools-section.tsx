import { LandingTrend } from "@/components/landing/landing-trend";

/** 개선 도구 타일. 문장·색상 예시는 화면에 '예시'로 밝힌다. 프로젝트 점수는 실제 프로젝트 화면의 값이다. */
const PROJECTS = [
  { name: "정부24", score: "96.9", color: "#c4314b" },
  { name: "홍익대", score: "84.8", color: "#1747c6" },
  { name: "토스", score: "83.1", color: "#3182f6" },
  { name: "서울대학교", score: "64.5", color: "#2b2f8f" }
] as const;

export function LandingToolsSection() {
  return (
    <section className="ua-tools" aria-labelledby="ua-tools-title">
      <div className="ua-shell">
        <p className="ua-eyebrow">개선 도구</p>
        <h2 className="ua-heading" id="ua-tools-title">찾는 데서 끝나지 않게.</h2>
        <div className="ua-tools__grid">
          <article className="ua-tile ua-tile--wide">
            <span className="ua-tile__kicker">텍스트 난이도</span>
            <h3>어려운 문장은 쉬운 표현으로.</h3>
            <p>문장 길이와 어려운 낱말을 살펴 읽기 부담스러운 문장을 찾고, 짧고 쉬운 표현을 제안해요.</p>
            <div className="ua-tools__rewrite">
              <div className="is-before"><small>분석한 문장</small>본 페이지는 이용자의 정보 접근성 향상을 도모하기 위하여 다양한 편의 기능을 제공하고 있습니다.</div>
              <div className="is-after"><small>쉬운 표현 제안</small>이 페이지는 누구나 정보를 쉽게 찾을 수 있도록 여러 편의 기능을 제공해요.</div>
            </div>
            <span className="ua-tile__note">예시 문장</span>
          </article>
          <article className="ua-tile ua-tile--wide">
            <span className="ua-tile__kicker">시각 명암비</span>
            <h3>기준에 맞는 색을 추천해요.</h3>
            <p>글자와 배경의 명도 대비를 재고, 이미지 속 글자도 읽어서 함께 검사해요.</p>
            <div className="ua-tools__swatches">
              <div><span className="ua-tools__chip" style={{ background: "#7cb7ff" }}>신청하기</span><span className="ua-tools__ratio">2.08:1<small className="is-problem">기준 미달</small></span><code>#FFFFFF / #7CB7FF</code></div>
              <div><span className="ua-tools__chip" style={{ background: "#0071e3" }}>신청하기</span><span className="ua-tools__ratio">4.70:1<small className="is-pass">추천 색</small></span><code>#FFFFFF / #0071E3</code></div>
            </div>
            <span className="ua-tile__note">예시 색상 · 기준 4.5:1</span>
          </article>
          <article className="ua-tile">
            <span className="ua-tile__kicker">재분석</span>
            <h3>고칠 때마다 추이가 쌓여요.</h3>
            <p>재분석하면 점수가 기록되고, 지난 분석보다 나아졌는지 바로 보여요.</p>
            <LandingTrend className="ua-tools__trend" width={260} height={110} labels />
          </article>
          <article className="ua-tile">
            <span className="ua-tile__kicker">프로젝트</span>
            <h3>여러 페이지를 한 번에.</h3>
            <ul className="ua-tools__projects">
              {PROJECTS.map(project => (
                <li key={project.name}><i style={{ background: project.color }} aria-hidden="true" />{project.name}<b>{project.score}점</b></li>
              ))}
            </ul>
          </article>
          <article className="ua-tile">
            <span className="ua-tile__kicker">사용 환경</span>
            <h3>라이트·다크, 키보드까지.</h3>
            <p>테마를 바꿔도 같은 정보를 보여 주고, 모든 조작은 키보드로도 할 수 있어요.</p>
            <div className="ua-tools__themes" aria-hidden="true">
              <div className="is-light"><i /><i /><i /></div>
              <div className="is-dark"><i /><i /><i /></div>
            </div>
            <ul className="ua-tools__keys" aria-label="지원하는 키">
              {["Tab", "←", "→", "Home", "End", "Shift+F10"].map(key => <li key={key}><kbd>{key}</kbd></li>)}
            </ul>
          </article>
        </div>
      </div>
    </section>
  );
}

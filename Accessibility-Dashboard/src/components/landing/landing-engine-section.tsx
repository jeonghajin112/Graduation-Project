/**
 * 분석 엔진 소개와 분석 과정.
 * 내용은 AI-module/README.md 와 run_all.py 의 실제 동작을 옮긴 것. 수치를 바꿀 때는 그 문서와 함께 바꿀 것.
 */
const icon = { width: 26, height: 26, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round", strokeLinejoin: "round" } as const;

const ENGINES = [
  {
    id: "rule",
    title: "규칙 기반 분석",
    body: "이미지 설명, 제목 구조, 버튼 이름처럼 페이지를 쓰는 데 필요한 요소를 검사하고 KWCAG 항목에 연결해요.",
    weight: 50,
    tool: "axe-core",
    icon: <svg {...icon} aria-hidden="true"><path d="M8 4 4 12l4 8" /><path d="m16 4 4 8-4 8" /><path d="m14 4-4 16" /></svg>
  },
  {
    id: "text",
    title: "텍스트 난이도 분석",
    body: "문장을 형태소로 나눠 길이와 어휘 난이도를 재고, 길고 복잡한 문장을 쉬운 표현으로 바꿔 제안해요.",
    weight: 30,
    tool: "MeCab",
    icon: <svg {...icon} aria-hidden="true"><path d="M4 6h16" /><path d="M4 12h10" /><path d="M4 18h13" /></svg>
  },
  {
    id: "contrast",
    title: "시각 명암비 분석",
    body: "화면의 글자를 읽어 배경과의 명도 대비를 판정하고, 기준에 맞는 색 조합을 추천해요.",
    weight: 20,
    tool: "OCR",
    icon: <svg {...icon} aria-hidden="true"><circle cx="12" cy="12" r="8.5" /><path d="M12 3.5a8.5 8.5 0 0 1 0 17Z" fill="currentColor" stroke="none" /></svg>
  }
] as const;

const STEPS = [
  { title: "페이지 열기", body: "실제 브라우저로 DOM과 화면 확보" },
  { title: "규칙 검사", body: "KWCAG 2.2 항목에 매핑" },
  { title: "텍스트 난이도", body: "길이와 어휘 난이도 측정" },
  { title: "시각 명암비", body: "글자와 배경 대비 판정" },
  { title: "총점과 등급", body: "50·30·20 비중으로 합산" },
  { title: "리포트", body: "페이지 위 마커와 최종 리포트" }
] as const;

export function LandingEngineSection() {
  return (
    <section className="ua-engine" id="engine" aria-labelledby="ua-engine-title">
      <div className="ua-shell">
        <p className="ua-eyebrow">분석 엔진</p>
        <h2 className="ua-heading" id="ua-engine-title">세 개의 분석기가<br />한 페이지를 세 번 읽어요.</h2>
        <div className="ua-engine__cards">
          {ENGINES.map(engine => (
            <article className="ua-engine__card" key={engine.id} aria-labelledby={`ua-engine-${engine.id}`}>
              <span className="ua-engine__icon">{engine.icon}</span>
              <h3 id={`ua-engine-${engine.id}`}>{engine.title}</h3>
              <p>{engine.body}</p>
              <div className="ua-engine__weight"><b>{engine.weight}%</b>점수 비중 · {engine.tool}</div>
            </article>
          ))}
        </div>
        <div className="ua-engine__bar" aria-hidden="true">{ENGINES.map(engine => <i key={engine.id} style={{ flexGrow: engine.weight }} />)}</div>
        <div className="ua-engine__bar-labels" aria-hidden="true">{ENGINES.map(engine => <span key={engine.id}>{engine.title.replace(" 분석", "").replace("규칙 기반", "규칙")} {engine.weight}</span>)}</div>

        <h3 className="ua-engine__process-title" id="process">분석 과정</h3>
        <ol className="ua-engine__steps" aria-labelledby="process">
          {STEPS.map(step => <li key={step.title}><b>{step.title}</b><span>{step.body}</span></li>)}
        </ol>
      </div>
    </section>
  );
}

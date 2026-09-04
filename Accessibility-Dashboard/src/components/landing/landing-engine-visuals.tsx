/**
 * 분석 엔진 모듈 시각화 — 이미지 없이 SVG + CSS 키프레임으로 그린 6초 루프.
 * 각 SVG는 viewBox 400×225(16:9). 애니메이션은 부모(.ua-engine)에 .is-live 가 붙었을 때만 재생되고,
 * prefers-reduced-motion 에서는 최종 상태로 정지한다 (landing-engine.css).
 */

const FONT = '"Pretendard Variable", Pretendard, "Noto Sans KR", system-ui, sans-serif';

/* 01 규칙 기반: 페이지 구조 트리가 위에서부터 켜지고, 깊은 노드 하나가 KWCAG 항목으로 표시된다 */
export function RuleVisual() {
  const nodes: [number, number, number][] = [
    [200, 28, 0], // x, y, order
    [110, 86, 1], [290, 86, 1],
    [60, 146, 2], [160, 146, 2], [240, 146, 2], [340, 146, 2],
  ];
  const edges: [number, number, number, number][] = [
    [200, 41, 110, 73], [200, 41, 290, 73],
    [110, 99, 60, 133], [110, 99, 160, 133], [290, 99, 240, 133], [290, 99, 340, 133],
  ];
  return (
    <svg className="ua-viz ua-viz--rule" viewBox="0 0 400 225" role="img" aria-label="페이지 구조를 읽어 문제가 있는 요소를 KWCAG 검사항목으로 표시하는 애니메이션">
      {edges.map(([x1, y1, x2, y2], i) => (
        <path key={i} className="ua-viz__edge" style={{ animationDelay: `${0.25 + Math.floor(i / 2) * 0.55}s` }}
          d={`M${x1} ${y1} V${(y1 + y2) / 2} H${x2} V${y2}`} />
      ))}
      {nodes.map(([x, y, order], i) => (
        <g key={i} className="ua-viz__node" style={{ animationDelay: `${0.1 + order * 0.6}s` }}>
          <rect x={x - 24} y={y - 13} width="48" height="26" rx="6" />
          <line x1={x - 15} y1={y - 4} x2={x + 9} y2={y - 4} />
          <line x1={x - 15} y1={y + 3} x2={x + 15} y2={y + 3} />
        </g>
      ))}
      <rect className="ua-viz__flag" x={240 - 30} y={146 - 19} width="60" height="38" rx="10" />
      <g className="ua-viz__chip" transform="translate(246 178)">
        <rect x="0" y="0" width="112" height="24" rx="12" />
        <text x="56" y="16" textAnchor="middle" fontFamily={FONT} fontSize="11" fontWeight="700">KWCAG 5.1.1</text>
      </g>
      <text className="ua-viz__caption" x="16" y="210" fontFamily={FONT} fontSize="11">
        <tspan className="ua-viz__caption-a">DOM 검사 중…</tspan>
        <tspan className="ua-viz__caption-b" x="16">대체 텍스트 누락 → 5.1.1 적절한 대체 텍스트 제공</tspan>
      </text>
    </svg>
  );
}

/* 02 텍스트 난이도: 한 줄로 긴 문장 블록이 두 줄로 나뉘고 어절 수가 줄어든다 */
export function TextVisual() {
  const words = [38, 26, 46, 20, 34, 28, 42, 24, 30];   // 어절 블록 너비 (합 288 + 간격 64 → x 24~376, 뷰박스 400 안)
  let x = 24;
  const blocks = words.map((w, i) => { const b = { x, w, i }; x += w + 8; return b; });
  const splitAt = 5;   // 이 인덱스부터 둘째 줄로 내려간다
  const secondStart = blocks[splitAt].x;
  return (
    <svg className="ua-viz ua-viz--text" viewBox="0 0 400 225" role="img" aria-label="긴 문장이 두 개의 짧은 문장으로 나뉘며 난이도가 낮아지는 애니메이션">
      <rect className="ua-viz__cursor" x={secondStart - 5} y="66" width="2" height="30" rx="1" />
      {blocks.map((b) => (
        <rect key={b.i} className={`ua-viz__word${b.i >= splitAt ? ' ua-viz__word--move' : ''}`} x={b.x} y="72" width={b.w} height="18" rx="5"
          style={b.i >= splitAt ? { ['--dx' as string]: `${24 - secondStart}px` } : undefined} />
      ))}
      <g className="ua-viz__meter" transform="translate(24 150)">
        <rect x="0" y="0" width="352" height="10" rx="5" className="ua-viz__meter-track" />
        <rect x="0" y="0" width="352" height="10" rx="5" className="ua-viz__meter-fill" />
      </g>
      <text x="24" y="186" fontFamily={FONT} fontSize="11" className="ua-viz__label">평균 문장 길이</text>
      <text x="376" y="186" fontFamily={FONT} fontSize="12" fontWeight="700" textAnchor="end" className="ua-viz__value">
        <tspan className="ua-viz__value-a">31어절</tspan>
        <tspan className="ua-viz__value-b" x="376">14어절</tspan>
      </text>
      <text className="ua-viz__caption" x="16" y="210" fontFamily={FONT} fontSize="11">
        <tspan className="ua-viz__caption-a">기준 25어절 초과 · 어려운 문장</tspan>
        <tspan className="ua-viz__caption-b" x="16">두 문장으로 나누어 제안</tspan>
      </text>
    </svg>
  );
}

/* 03 시각 명암비: 배경이 짙어지며 명도 대비가 올라가고 AA 기준을 넘긴다 */
export function ContrastVisual() {
  const r = 34, c = 2 * Math.PI * r;
  return (
    <svg className="ua-viz ua-viz--contrast" viewBox="0 0 400 225" role="img" aria-label="글자와 배경의 명도 대비가 올라가 AA 기준을 통과하는 애니메이션">
      <rect className="ua-viz__swatch" x="24" y="28" width="172" height="150" rx="14" />
      <text className="ua-viz__glyph" x="110" y="122" textAnchor="middle" fontFamily={FONT} fontSize="64" fontWeight="700">가</text>
      <g transform="translate(300 90)">
        <circle className="ua-viz__ring-track" r={r} />
        <circle className="ua-viz__ring" r={r} strokeDasharray={c} strokeDashoffset={c} transform="rotate(-90)" />
        <text className="ua-viz__ratio" y="6" textAnchor="middle" fontFamily={FONT} fontSize="18" fontWeight="800">
          <tspan className="ua-viz__ratio-a">2.1:1</tspan>
          <tspan className="ua-viz__ratio-b" x="0">4.7:1</tspan>
        </text>
      </g>
      <g className="ua-viz__badge" transform="translate(268 150)">
        <rect x="0" y="0" width="64" height="24" rx="12" />
        <text x="32" y="16" textAnchor="middle" fontFamily={FONT} fontSize="11" fontWeight="700">AA 통과</text>
      </g>
      <text className="ua-viz__caption" x="16" y="210" fontFamily={FONT} fontSize="11">
        <tspan className="ua-viz__caption-a">기준 4.5:1 미달 · 배경색 조정 제안</tspan>
        <tspan className="ua-viz__caption-b" x="16">KWCAG 5.4.3 텍스트 콘텐츠의 명도 대비 통과</tspan>
      </text>
    </svg>
  );
}

import { useEffect, useRef, useState } from "react";

// 문장마다 묶어 문장 사이에서만 줄이 바뀐다 ("무엇부터 / 고칠지"처럼 문장 중간에서 끊기지 않게).
const SENTENCES = [
  [{ text: "어디가 ", accent: false }, { text: "문제", accent: true }, { text: "인지.", accent: false }],
  [{ text: "왜 바꿔야 하는지.", accent: false }],
  [{ text: "무엇부터 고칠지.", accent: false }],
  [{ text: "이제, 이해하고 개선하세요.", accent: false }]
] as const;
const PHRASES = SENTENCES.flat();

/**
 * 필름 다음의 큰 문장. 스크롤에 맞춰 구절이 흐릿하고 투명한 상태에서 또렷하게 차례로 떠오른다.
 * 글자색은 처음부터 최종 색이라 어느 순간에도 명도 대비가 낮은 글자가 화면에 남지 않는다.
 * 모션 축소 설정에서는 처음부터 모두 보인다.
 */
export function LandingMessageSection() {
  const titleRef = useRef<HTMLHeadingElement>(null);
  const [lit, setLit] = useState(0);

  useEffect(() => {
    const title = titleRef.current;
    if (!title) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    let raf = 0;
    const update = () => {
      raf = 0;
      if (reduced.matches) { setLit(PHRASES.length); return; }
      const rect = title.getBoundingClientRect();
      const progress = Math.min(1, Math.max(0, (window.innerHeight * 0.85 - rect.top) / (window.innerHeight * 0.55)));
      setLit(Math.round(progress * PHRASES.length));
    };
    const schedule = () => { if (!raf) raf = requestAnimationFrame(update); };
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    reduced.addEventListener("change", schedule);
    update();
    return () => {
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      reduced.removeEventListener("change", schedule);
      cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <section className="ua-message" aria-labelledby="ua-message-title">
      <div className="ua-shell">
        <h2 className="ua-message__title" id="ua-message-title" ref={titleRef}>
          {SENTENCES.map((sentence, sentenceIndex) => {
            const start = SENTENCES.slice(0, sentenceIndex).reduce((count, previous) => count + previous.length, 0);
            return (
              <span key={sentenceIndex}>
                {sentenceIndex > 0 && " "}
                <span className="ua-message__sentence">
                  {sentence.map((phrase, offset) => (
                    <span key={phrase.text} className={`ua-message__phrase${phrase.accent ? " is-accent" : ""}${start + offset < lit ? " is-lit" : ""}`}>
                      {phrase.text}
                    </span>
                  ))}
                </span>
              </span>
            );
          })}
        </h2>
      </div>
    </section>
  );
}

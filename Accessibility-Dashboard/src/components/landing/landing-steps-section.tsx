export type LandingStep = {
  id: string;
  label: string;
  title: string;
  body?: string;
  tags?: readonly string[];
};

/**
 * 휴대폰에서 스크롤 필름 대신 보여 주는 단계 목록.
 * 세로 화면에서는 제품 화면 카드가 너무 작게 보이므로, 화면은 빼고 장면별 글만 카드에 담아 옆으로 넘긴다(.ua-gallery).
 * 목록이 가로 스크롤 영역이라 키보드로도 넘길 수 있게 초점을 받는다.
 */
export function LandingStepsSection({ steps }: { steps: readonly LandingStep[] }) {
  return (
    <section id="tour" className="ua-steps" aria-labelledby="ua-steps-title">
      <p className="ua-eyebrow">이용 과정</p>
      <h2 className="ua-heading" id="ua-steps-title">주소 하나로<br />네 단계면 끝나요.</h2>
      <ol className="ua-steps__list ua-gallery" aria-label="이용 과정" tabIndex={0}>
        {steps.map((step) => (
          <li key={step.id} className="ua-steps__item">
            <p className="ua-steps__label">{step.label}</p>
            <h3 className="ua-steps__title">{step.title}</h3>
            {step.body ? <p className="ua-steps__body">{step.body}</p> : null}
            {step.tags?.length ? (
              <ul className="ua-steps__tags">
                {step.tags.map((tag) => <li key={tag}>{tag}</li>)}
              </ul>
            ) : null}
          </li>
        ))}
      </ol>
    </section>
  );
}

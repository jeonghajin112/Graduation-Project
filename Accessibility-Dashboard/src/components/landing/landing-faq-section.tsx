import { Plus } from "lucide-react";

const QUESTIONS = [
  {
    question: "웹 접근성을 처음 접해도 사용할 수 있나요?",
    answer: "주소만 넣으면 검사가 시작돼요. 결과에서 문제 위치와 설명을 함께 보며, 무엇을 고칠지 알 수 있어요."
  },
  {
    question: "어떤 내용을 분석하나요?",
    answer: "코드, 문장, 글자 색을 검사해요. 규칙에 어긋난 곳, 읽기 어려운 문장, 잘 안 보이는 글자를 찾아 줘요."
  },
  {
    question: "검사하면 홈페이지가 저절로 바뀌나요?",
    answer: "홈페이지를 직접 바꾸지는 않아요. 문제 위치와 고치는 방법을 알려 주고, 문장이나 색은 예를 보여 줘요. 실제로 고치는 일은 홈페이지를 맡은 사람이 해요."
  },
  {
    question: "자동 분석만으로 접근성을 모두 확인할 수 있나요?",
    answer: "자동 검사로 모두 알 수는 없어요. 그림 설명이 알맞은지 같은 12개는 사람이 봐야 해요. 결과에도 ‘직접 확인’으로 따로 적혀 있어요."
  },
  {
    question: "화면에 보이지 않는 문제도 볼 수 있나요?",
    answer: "숨어 있거나 찾지 못한 문제도 결과의 문제 모음에 있어요. 누르면 그때 내용과 고칠 방법이 나와요."
  },
  {
    question: "이 화면은 실제 결과인가요?",
    answer: "영상과 그림은 국세청 홈페이지를 실제로 검사한 결과예요. 문장과 색은 예로 든 것이에요."
  }
] as const;

export function LandingFaqSection() {
  return (
    <section className="ua-faq" id="faq" aria-labelledby="ua-faq-title">
      <div className="ua-shell ua-faq__inner">
        <header className="ua-faq__head">
          <h2 className="ua-heading" id="ua-faq-title">궁금한 점이<br />있으신가요?</h2>
          <p className="ua-lede">시작하기 전에 확인해 보세요.</p>
        </header>
        <div className="ua-faq__questions">
          {QUESTIONS.map(({ question, answer }) => (
            <details className="ua-faq__item" key={question}>
              <summary><span>{question}</span><i aria-hidden="true"><Plus size={14} strokeWidth={1.8} /></i></summary>
              <p>{answer}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}

import { Plus } from "lucide-react";

const QUESTIONS = [
  {
    question: "웹 접근성을 처음 접해도 사용할 수 있나요?",
    answer: "분석할 페이지 주소를 입력하면 검사를 시작할 수 있어요. 결과 화면에서 문제 위치와 설명을 함께 확인하며, 어떤 부분을 살펴보고 개선해야 하는지 알아갈 수 있어요."
  },
  {
    question: "어떤 내용을 분석하나요?",
    answer: "페이지의 코드 구조, 문장의 읽기 난이도, 글자와 배경의 명암비를 분석해요. 접근성 규칙 위반과 읽기 어려운 문장, 구분하기 어려운 글자를 찾아 보여 줘요."
  },
  {
    question: "분석하면 웹사이트가 자동으로 수정되나요?",
    answer: "원본 웹사이트를 자동으로 수정하지는 않아요. 문제 위치와 개선 안내를 제공하고, 항목에 따라 문장 수정 예시나 색상 추천을 보여 줘요. 실제 수정은 사이트를 관리하는 사람이 적용해야 해요."
  },
  {
    question: "자동 분석만으로 접근성을 모두 확인할 수 있나요?",
    answer: "자동 분석에는 한계가 있어요. 대체 텍스트가 문맥에 맞는지, 키보드와 보조 기술로 자연스럽게 이용할 수 있는지는 사람이 함께 확인해야 해요. 최종 리포트는 이런 12개 항목을 ‘직접 확인’으로 따로 표시해요."
  },
  {
    question: "페이지 위에 표시되지 않은 문제도 확인할 수 있나요?",
    answer: "숨겨져 있거나 현재 페이지에서 찾을 수 없는 문제는 결과 화면 오른쪽 목록에 KWCAG 항목별로 모여 있어요. ‘상세’를 열면 분석 당시의 내용과 개선 안내를 볼 수 있어요."
  },
  {
    question: "이 페이지의 화면은 실제 분석 결과인가요?",
    answer: "스크롤 영상과 '자세히 보기' 화면, 최종 리포트 그림은 국세청 누리집을 실제로 분석한 결과를 서비스에서 직접 담은 것이에요. 문장·색상 추천처럼 예시인 부분은 화면에 따로 밝혀 두었어요. 내 사이트를 확인하려면 ‘새 페이지 분석’에서 주소를 입력해 주세요."
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

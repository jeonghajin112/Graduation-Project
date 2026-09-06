import { Plus } from "lucide-react";
import "@/styles/landing-faq.css";

const QUESTIONS = [
  {
    question: "웹 접근성을 처음 접해도 사용할 수 있나요?",
    answer: "분석할 페이지 주소를 입력하면 검사를 시작할 수 있습니다. 결과 화면에서 문제 위치와 설명을 함께 확인하며, 어떤 부분을 살펴보고 개선해야 하는지 알아갈 수 있습니다."
  },
  {
    question: "어떤 내용을 분석하나요?",
    answer: "페이지의 코드 구조, 문장의 읽기 난이도, 글자와 배경의 명암비를 분석합니다. 접근성 규칙 위반과 읽기 어려운 문장, 시각적으로 구분하기 어려운 글자 등을 찾아 결과로 보여줍니다."
  },
  {
    question: "분석하면 웹사이트가 자동으로 수정되나요?",
    answer: "원본 웹사이트를 자동으로 수정하지는 않습니다. 문제 위치와 개선 안내를 제공하며, 항목에 따라 문장 수정 예시나 색상 추천을 확인할 수 있습니다. 실제 수정은 사이트를 관리하는 사람이 적용해야 합니다."
  },
  {
    question: "자동 분석만으로 접근성을 모두 확인할 수 있나요?",
    answer: "자동 분석으로 확인할 수 있는 범위에는 한계가 있습니다. 문맥에 맞는 대체 텍스트인지, 키보드와 보조 기술로 자연스럽게 이용할 수 있는지 등은 사람이 함께 확인해야 합니다. 분석 결과를 개선의 출발점으로 활용해 주세요."
  },
  {
    question: "이 페이지의 화면은 실제 분석 결과인가요?",
    answer: "랜딩페이지의 서비스 화면은 실제 사이트를 분석한 결과를 서비스에서 직접 촬영한 이미지와 영상입니다. 스크롤에 따라 화면을 소개하며, 새로운 분석을 실행하는 것은 아닙니다. 내 사이트를 확인하려면 상단의 ‘새 페이지 분석’에서 주소를 입력해 주세요."
  }
] as const;

export function LandingFaqSection() {
  return (
    <section className="ua-faq" id="faq" aria-labelledby="ua-faq-title">
      <div className="ua-faq__inner">
        <header className="ua-faq__head">
          <h2 id="ua-faq-title">궁금한 점이<br />있으신가요?</h2>
          <p>시작하기 전에 확인해 보세요.</p>
        </header>
        <div className="ua-faq__questions">
          {QUESTIONS.map(({ question, answer }) => (
            <details className="ua-faq__item" key={question}>
              <summary><span>{question}</span><Plus size={18} strokeWidth={1.5} aria-hidden="true" /></summary>
              <p>{answer}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}

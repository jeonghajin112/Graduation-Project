type RuleGuide = { help: string; explanation: string; guidance: string };

// Rule IDs are engine identifiers, not KWCAG criteria (several rules share one
// criterion). Legacy records are recognized only by an exact first-line help.
const guides: Record<string, RuleGuide> = {
  "link-name": {
    help: "Links must have discernible text",
    explanation: "링크에 화면 읽기 프로그램이 인식할 수 있는 이름이 없습니다.",
    guidance: "링크의 목적을 알 수 있는 텍스트를 제공하세요. 이미지 링크라면 적절한 대체 텍스트를 지정하고, aria-label이나 aria-labelledby를 사용했다면 이름이 비어 있거나 참조 대상이 없는지 확인하세요."
  },
  "image-alt": {
    help: "Images must have alternative text",
    explanation: "이미지의 의미를 전달할 대체 텍스트를 확인해야 합니다.",
    guidance: "정보를 전달하는 이미지에는 의미에 맞는 alt를 제공하세요. 장식용 이미지라면 빈 alt를 지정해 화면 읽기 프로그램이 건너뛸 수 있게 하세요."
  },
  "list": {
    help: "<ul> and <ol> must only directly contain <li>, <script> or <template> elements",
    explanation: "목록 바로 아래에 허용되지 않는 요소 또는 텍스트가 있습니다.",
    guidance: "ul·ol의 목록 항목을 li로 감싸세요. 목록 바로 아래에는 li, script, template 요소만 배치할 수 있습니다."
  },
  "listitem": {
    help: "<li> elements must be contained in a <ul> or <ol>",
    explanation: "목록 항목인 li가 올바른 목록 안에 포함되어 있지 않습니다.",
    guidance: "li 항목을 ul 또는 ol 안에 배치해 목록의 구조를 전달하세요."
  },
  "button-name": {
    help: "Buttons must have discernible text",
    explanation: "버튼에 화면 읽기 프로그램이 인식할 수 있는 이름이 없습니다.",
    guidance: "버튼의 동작을 설명하는 텍스트나 접근성 이름을 제공하세요. 아이콘만 있는 버튼도 이름이 필요합니다."
  },
  "label": {
    help: "Form elements must have labels",
    explanation: "입력 요소에 연결된 레이블이 없거나 인식되지 않습니다.",
    guidance: "입력 목적을 설명하는 label을 제공하고 for와 입력 요소의 id를 연결하세요. 필요한 경우 aria-label이나 aria-labelledby로 접근성 이름을 제공할 수 있습니다."
  },
  "color-contrast": {
    help: "Elements must meet minimum color contrast ratio thresholds",
    explanation: "텍스트와 배경 사이의 명도 대비가 검사 기준에 미달합니다.",
    guidance: "글자색이나 배경색을 조정하세요. 일반 텍스트는 4.5:1, 큰 텍스트는 3:1 이상의 대비가 필요합니다. 실제 측정값과 대상은 검사 원문에서 확인하세요."
  },
  "document-title": {
    help: "Documents must have <title> element to aid in navigation",
    explanation: "페이지를 구분할 수 있는 문서 제목이 없습니다.",
    guidance: "head 안에 페이지의 목적을 설명하는 비어 있지 않은 title을 제공하세요."
  },
  "html-has-lang": {
    help: "<html> element must have a lang attribute",
    explanation: "문서의 기본 언어가 지정되어 있지 않습니다.",
    guidance: "html의 lang에 문서의 주 언어를 지정하세요. 한국어 문서는 ko를 사용할 수 있습니다."
  },
  "html-lang-valid": {
    help: "<html> element must have a valid value for the lang attribute",
    explanation: "문서에 지정된 언어 코드가 유효하지 않습니다.",
    guidance: "html의 lang에 ko, en처럼 유효한 언어 코드를 지정하세요."
  }
};

export function localizeRuleDescription(message: string, ruleId?: string | null): string | null {
  const firstLine = message.trim().split(/\r?\n/, 1)[0];
  const guide = ruleId
    ? (Object.prototype.hasOwnProperty.call(guides, ruleId) ? guides[ruleId] : undefined)
    : Object.values(guides).find(candidate => candidate.help === firstLine);
  if (!guide) return null;
  return `${guide.explanation}\n\n개선 안내\n${guide.guidance}`;
}

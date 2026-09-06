export type ScrollWorldAction = {
  label: string;
  href: string;
  action?: "enter-app";
  section?: string;
};

export type ScrollWorldSection = {
  id: string;
  label: string;
  still: string;
  stillMobile?: string;
  clip?: string;
  clipMobile?: string;
  layout?: "full" | "card";
  accent?: string;
  scroll?: number;
  linger?: number;
  eyebrow?: string;
  title: string;
  body?: string;
  tags?: string[];
  cta?: {
    primary?: ScrollWorldAction;
    secondary?: ScrollWorldAction;
  };
};

export type ScrollWorldConfig = {
  brand?: { name: string; href: string; wordmark?: { strong: string; light: string } };
  cta?: ScrollWorldAction;
  skipLabel?: string;
  mainId?: string;
  hint?: string;
  nav?: boolean;
  /** false 면 오른쪽 세로 진행 레일(장면 점)을 숨긴다 */
  route?: boolean;
  /** 필름 아래 일반 섹션으로 가는 추가 내비 링크 */
  navLinks?: { label: string; href: string }[];
  showSectionNumbers?: boolean;
  mobileVideo?: boolean;
  /** 해상도 등급: 뷰포트 디바이스 픽셀 폭이 maxDevicePx 이하이면 클립 파일명에 suffix 를 붙여 로드 */
  clipVariants?: { maxDevicePx: number; suffix: string }[];
  diveScroll?: number;
  connScroll?: number;
  crossfade?: number;
  atmosphere?: boolean;
  card?: {
    width?: number;
    right?: number;
    radius?: number;
    in?: number;
    maxH?: number;
  };
  sections: ScrollWorldSection[];
  connectors?: Array<string | null>;
  connectorsMobile?: Array<string | null>;
};

export type ScrollWorldOptions = {
  onEnterApp?: () => void;
  subscribeScroll?: (listener: () => void) => (() => void) | void;
};

export function mountScrollWorld(
  container: HTMLElement,
  config: ScrollWorldConfig,
  options?: ScrollWorldOptions
): () => void;

import { LandingPage } from "@/components/landing/landing-page";

interface HeroSectionProps {
  /** Enters the analysis app. The route wires this to `/analyze`. */
  onLoginClick?: () => void;
}

/**
 * Route-level entry point for `/`.
 *
 * The landing surface itself lives in `src/components/landing/`; this file stays
 * as the stable import boundary used by `hero-demo.tsx`.
 */
export function HeroSection({ onLoginClick }: HeroSectionProps) {
  return <LandingPage onEnterApp={onLoginClick} />;
}

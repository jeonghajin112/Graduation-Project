import { useNavigate } from "react-router-dom";
import { HeroSection } from '@/components/ui/hero-section-1';

export function HeroDemo() {
  const navigate = useNavigate();
  return <HeroSection onLoginClick={() => navigate('/analyze', { replace: true })} />;
}

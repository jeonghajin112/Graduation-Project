import { useNavigate } from "react-router-dom";
import { LandingPage } from "@/components/landing/landing-page";

export function HeroDemo() {
  const navigate = useNavigate();
  return <LandingPage onEnterApp={() => navigate("/analyze", { replace: true })} />;
}

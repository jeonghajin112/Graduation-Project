import StepCard from "@/components/ui/step-card";

interface DemoOneProps {
  onComplete?: (data: { email: string }) => void | Promise<void>;
  isSubmitting?: boolean;
}

export default function DemoOne({ onComplete, isSubmitting = false }: DemoOneProps) {
  return <StepCard onComplete={onComplete} isSubmitting={isSubmitting} />;
}

import { Check, CircleAlert, Clock3, Loader2 } from "lucide-react";
import type { EvaluationRequestModel } from "@/types/accessibility-domain";

export function PageAnalysisStatus({ request, pageName, acknowledged }: {
  request: EvaluationRequestModel | undefined;
  pageName: string;
  acknowledged: boolean;
}) {
  if (!request || (request.status === "COMPLETED" && acknowledged)) return null;
  const completed = request.status === "COMPLETED";
  const failed = request.status === "FAILED";
  const pending = request.status === "PENDING";
  const label = completed ? "분석 완료" : failed ? "분석 오류" : pending ? "분석 대기 중" : "분석 진행 중";
  const Icon = completed ? Check : failed ? CircleAlert : pending ? Clock3 : Loader2;
  const className = `absolute right-1 top-1/2 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md ${failed ? "text-[var(--destructive)]" : "text-[var(--dashboard-accent)]"}`;
  const icon = <Icon size={14} aria-hidden="true" className={!completed && !failed && !pending ? "motion-safe:animate-spin" : undefined} />;
  return (
    <span role="img" aria-label={`${pageName} ${label}`} title={label} className={`${className} pointer-events-none`}
      data-analysis-request-id={request.id} data-analysis-status={request.status}>{icon}</span>
  );
}

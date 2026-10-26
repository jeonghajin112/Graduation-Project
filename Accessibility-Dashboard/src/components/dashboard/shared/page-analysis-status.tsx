import { Check, CircleAlert, Clock3, Loader2 } from "lucide-react";
import type { EvaluationRequestModel, RequestStatus } from "@/types/accessibility-domain";
import { AnalysisFailureIndicator } from "./analysis-failure-indicator";

const STATUS_DISPLAY: Record<RequestStatus, { label: string; Icon: typeof Check }> = {
  COMPLETED: { label: "분석 완료", Icon: Check },
  FAILED: { label: "분석 오류", Icon: CircleAlert },
  PENDING: { label: "분석 대기 중", Icon: Clock3 },
  IN_PROGRESS: { label: "분석 진행 중", Icon: Loader2 }
};

export function PageAnalysisStatus({ request, pageName, acknowledged }: {
  request: EvaluationRequestModel | undefined;
  pageName: string;
  acknowledged: boolean;
}) {
  if (!request || (request.status === "COMPLETED" && acknowledged)) return null;
  const failed = request.status === "FAILED";
  const { label, Icon } = STATUS_DISPLAY[request.status];
  const className = `absolute right-1 top-1/2 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md ${failed ? "text-[var(--destructive)]" : "text-[var(--dashboard-accent)]"}`;
  const icon = <Icon size={14} aria-hidden="true" className={request.status === "IN_PROGRESS" ? "motion-safe:animate-spin" : undefined} />;
  if (failed) return <AnalysisFailureIndicator key={`${request.id}:${request.failureCode ?? ""}`}
    requestId={request.id} pageName={pageName} code={request.failureCode} className={className} />;
  return (
    <span role="img" aria-label={`${pageName} ${label}`} title={label} className={`${className} pointer-events-none`}
      data-analysis-request-id={request.id} data-analysis-status={request.status}>{icon}</span>
  );
}

import { RefreshCw } from "lucide-react";
import { formatDateTime } from "@/components/dashboard/shared/utils";

export function PageAnalysisActions({ analyzedAt, isRequestingAnalysis, onRequestAnalysis, analysisRequestError }: {
  analyzedAt: string | null;
  isRequestingAnalysis: boolean;
  onRequestAnalysis?: () => void;
  analysisRequestError: string | null;
}) {
  return (
    <div className="site-page-analysis-actions">
      <dl className="site-page-analysis-actions__metadata">
        <div>
          <dt className="sr-only">최근 분석</dt>
          <dd>{formatDateTime(analyzedAt)}</dd>
        </div>
      </dl>
      {onRequestAnalysis && (
        <button type="button" className="site-page-analysis-actions__rescan"
          onClick={onRequestAnalysis} disabled={isRequestingAnalysis} aria-busy={isRequestingAnalysis}
          aria-describedby={analysisRequestError ? "site-analysis-request-error" : undefined}>
          <RefreshCw size={12} aria-hidden="true" />
          {isRequestingAnalysis ? "요청 중…" : "재분석"}
        </button>
      )}
    </div>
  );
}

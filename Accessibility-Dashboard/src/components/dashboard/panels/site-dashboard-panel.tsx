import { useEffect, useMemo, useState } from "react";

import type {
  AnalysisResult,
  AnalyzerType,
  EvaluationResultSummary,
  EvaluationRequestModel,
  EvaluationTargetModel,
  ImprovementGuide,
  IssueResultModel,
  ScoreResult
} from "@/types/accessibility-domain";

import { selectLatestEvaluationRequest } from "../shared/evaluation-request-selection";
import { AnalysisTrendPanel } from "./site-dashboard/analysis-trend-panel";
import { fallbackWcagCriterion, severityChartItems, wcagCriterionByIssueCode } from "./site-dashboard/constants";
import { hasUsableIssueLocator } from "./site-dashboard/issue-locator";
import { RenderedPageEvidenceCard } from "./site-dashboard/rendered-page-evidence-card";
import type { RecentIssueRow } from "./site-dashboard/types";
import { useEvaluationArtifact } from "./site-dashboard/use-evaluation-artifact";
import { getAnalyzerTypeLabel } from "./site-dashboard/utils";

type SiteDashboardPanelProps = {
  evaluationTarget: EvaluationTargetModel;
  evaluationRequests: EvaluationRequestModel[];
  resultSummaries: EvaluationResultSummary[];
  analysisResults: AnalysisResult[];
  scoreResults: ScoreResult[];
  issueResults: IssueResultModel[];
  improvementGuides: ImprovementGuide[];
};

export function SiteDashboardPanel(props: SiteDashboardPanelProps) {
  const {
    evaluationTarget,
    evaluationRequests,
    resultSummaries,
    analysisResults,
    improvementGuides,
    issueResults,
    scoreResults
  } = props;
  const targetEvaluationRequests = evaluationRequests.filter(
    (request) => request.evaluationTargetId === evaluationTarget.id
  );
  const requestIdByAnalysisResultId = useMemo(
    () => new Map(
      analysisResults.map((analysisResult) => [analysisResult.id, analysisResult.evaluationRequestId])
    ),
    [analysisResults]
  );
  const analysisResultById = useMemo(
    () => new Map(analysisResults.map((analysisResult) => [analysisResult.id, analysisResult])),
    [analysisResults]
  );
  const guidesByIssueId = useMemo(
    () => buildGuidesByIssueId(improvementGuides),
    [improvementGuides]
  );
  const materializedRequestIds = new Set([
    ...resultSummaries.map((summary) => summary.requestId),
    ...scoreResults.map((scoreResult) => scoreResult.evaluationRequestId),
    ...analysisResults.map((analysisResult) => analysisResult.evaluationRequestId)
  ]);
  const latestMaterializedResultRequest = selectLatestEvaluationRequest(
    targetEvaluationRequests,
    materializedRequestIds
  );
  const latestResultRequestId = latestMaterializedResultRequest?.id ?? null;
  const latestIssues = useMemo(
    () =>
      latestResultRequestId === null
        ? []
        : issueResults.filter(
            (issue) => requestIdByAnalysisResultId.get(issue.analysisResultId) === latestResultRequestId
          ),
    [issueResults, latestResultRequestId, requestIdByAnalysisResultId]
  );
  const {
    artifact,
    errorMessage: artifactErrorMessage,
    loadState: artifactLoadState,
    retry: retryArtifact
  } = useEvaluationArtifact(latestResultRequestId);
  const [selectedIssueId, setSelectedIssueId] = useState<number | null>(null);
  const latestIssueSignature = latestIssues.map((issue) => issue.id).join(",");

  useEffect(() => {
    setSelectedIssueId((current) => {
      if (current !== null && latestIssues.some((issue) => issue.id === current)) {
        return current;
      }

      return latestIssues.find(hasUsableIssueLocator)?.id ?? latestIssues[0]?.id ?? null;
    });
  }, [latestIssueSignature, latestResultRequestId]);

  const replayIssueRows = useMemo<RecentIssueRow[]>(
    () =>
      latestIssues.map((issue) => {
        const severity = severityChartItems.find((item) => item.key === issue.severity) ?? severityChartItems[0]!;
        const analyzerType = analysisResultById.get(issue.analysisResultId)?.analyzerType;
        return {
          issue,
          severity,
          wcagCriterion: wcagCriterionByIssueCode[issue.issueCode] ?? fallbackWcagCriterion,
          issueGuides: guidesByIssueId.get(issue.id) ?? [],
          analyzerLabel: getAnalyzerTypeLabel(analyzerType),
          analyzerType,
          showsAiGuide: isTextAccessibilityIssue(issue, analyzerType)
        };
      }),
    [analysisResultById, guidesByIssueId, latestIssues]
  );

  return (
    <div className="site-dashboard-layout grid min-h-[31rem] grid-cols-1 items-stretch">
      <div className="site-page-evidence-grid-item">
        <RenderedPageEvidenceCard
          artifact={artifact}
          errorMessage={artifactErrorMessage}
          loadState={artifactLoadState}
          rows={replayIssueRows}
          selectedIssueId={selectedIssueId}
          targetName={evaluationTarget.name}
          onRetry={retryArtifact}
          onSelectIssue={setSelectedIssueId}
        />
      </div>
      <AnalysisTrendPanel requestId={latestResultRequestId} />
    </div>
  );
}

function buildGuidesByIssueId(improvementGuides: ImprovementGuide[]): Map<number, ImprovementGuide[]> {
  const guidesByIssueId = new Map<number, ImprovementGuide[]>();

  for (const guide of improvementGuides) {
    const currentGuides = guidesByIssueId.get(guide.issueResultId) ?? [];
    currentGuides.push(guide);
    guidesByIssueId.set(guide.issueResultId, currentGuides);
  }

  return guidesByIssueId;
}

function isTextAccessibilityIssue(issue: IssueResultModel, analyzerType?: AnalyzerType): boolean {
  if (analyzerType !== "AI_TEXT") {
    return false;
  }

  const searchableText = [issue.issueCode, issue.issueTitle, issue.message].join(" ").toLowerCase();
  return (
    searchableText.includes("text") ||
    searchableText.includes("difficulty") ||
    searchableText.includes("텍스트") ||
    searchableText.includes("난이도")
  );
}

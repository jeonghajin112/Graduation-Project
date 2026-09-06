import type { DashboardViewModel } from "@/types/accessibility-domain";

import type { DirectoryRecoveryToken, LoadDashboard } from "./use-dashboard-data";
import { useEvaluationTargetAnalysisRequest } from "./use-evaluation-target-analysis-request";
import { useEvaluationTargetCreation } from "./use-evaluation-target-creation";

type UseSiteCreateWorkflowOptions = {
  beginDirectoryRecovery: () => DirectoryRecoveryToken;
  dashboardData: DashboardViewModel | null;
  endDirectoryRecovery: (token: DirectoryRecoveryToken) => void;
  loadDashboard: LoadDashboard;
};

export function useSiteCreateWorkflow(options: UseSiteCreateWorkflowOptions) {
  // Both steps advance one durable recovery record from target creation to polling.
  const handleCreateEvaluationTargetModel = useEvaluationTargetCreation(options);
  const handleRequestEvaluationTargetAnalysis =
    useEvaluationTargetAnalysisRequest(options);

  return {
    handleCreateEvaluationTargetModel,
    handleRequestEvaluationTargetAnalysis
  };
}

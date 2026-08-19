import type {
  DashboardApiResponse,
  DashboardViewModel,
  EvaluationRequestModel,
  EvaluationTargetModel,
  IssueResultModel,
  Organization,
  OrganizationModel
} from "@/types/accessibility-domain";

export function mapDashboardResponseToViewModel(response: DashboardApiResponse): DashboardViewModel {
  const targetsByOrganizationId = new Map<number, EvaluationTargetModel[]>();

  for (const evaluationTarget of response.evaluationTargets) {
    const currentTargets = targetsByOrganizationId.get(evaluationTarget.organizationId) ?? [];
    currentTargets.push({
      id: evaluationTarget.id,
      name: evaluationTarget.name,
      targetType: evaluationTarget.targetType,
      accessUrl: evaluationTarget.accessUrl,
      status: evaluationTarget.status,
      createdAt: evaluationTarget.createdAt
    });
    targetsByOrganizationId.set(evaluationTarget.organizationId, currentTargets);
  }

  const organizations: OrganizationModel[] = response.organizations.map((organization: Organization) => {
    const evaluationTargets = targetsByOrganizationId.get(organization.id) ?? [];

    return {
      id: organization.id,
      name: organization.name,
      type: organization.type,
      homepageUrl: organization.homepageUrl,
      description: organization.description,
      status: organization.status,
      createdAt: organization.createdAt,
      updatedAt: organization.updatedAt,
      evaluationTargets: evaluationTargets
    };
  });

  const evaluationRequests: EvaluationRequestModel[] = response.evaluationRequests.map((evaluationRequest) => ({
    id: evaluationRequest.id,
    evaluationTargetId: evaluationRequest.evaluationTargetId,
    status: evaluationRequest.status,
    requestNote: evaluationRequest.requestNote,
    requestedAt: evaluationRequest.requestedAt,
    createdAt: evaluationRequest.createdAt,
    updatedAt: evaluationRequest.updatedAt
  }));

  const issueResults: IssueResultModel[] = response.issueResults.map((issueResult) => ({
    id: issueResult.id,
    analysisResultId: issueResult.analysisResultId,
    issueCode: issueResult.issueCode,
    issueTitle: issueResult.issueTitle,
    severity: issueResult.severity,
    locationPath: issueResult.locationPath,
    message: issueResult.message,
    resolved: issueResult.resolved,
    createdAt: issueResult.createdAt,
    updatedAt: issueResult.updatedAt
  }));

  return {
    organizations,
    evaluationRequests: evaluationRequests,
    resultSummaries: [],
    evaluationIssues: [],
    analysisResults: response.analysisResults,
    scoreResults: response.scoreResults,
    scoreDetails: response.scoreDetails ?? [],
    issueResults: issueResults,
    improvementGuides: response.improvementGuides ?? []
  };
}

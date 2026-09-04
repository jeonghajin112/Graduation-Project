import type {
  IssueLocatorCarouselContext,
  IssueLocatorContext,
  IssueLocatorPathStep,
  IssueResultModel
} from "@/types/accessibility-domain";

const supportedContexts = new Set<IssueLocatorContext>(["DOCUMENT", "FRAME", "SHADOW_ROOT"]);

function isUsablePathStep(step: unknown): step is IssueLocatorPathStep {
  if (step === null || typeof step !== "object") {
    return false;
  }

  const candidate = step as Partial<IssueLocatorPathStep>;
  return (
    typeof candidate.context === "string" &&
    supportedContexts.has(candidate.context as IssueLocatorContext) &&
    typeof candidate.selector === "string" &&
    candidate.selector.trim().length > 0 &&
    (candidate.frameUrl === undefined || candidate.frameUrl === null || typeof candidate.frameUrl === "string")
  );
}

export function getReplayIssuePathSteps(issue: IssueResultModel): IssueLocatorPathStep[] {
  const rawPathSteps = issue.locator?.pathSteps;
  const storedPathSteps = (Array.isArray(rawPathSteps) ? rawPathSteps : [])
    .filter(isUsablePathStep)
    .map((step) => ({
      context: step.context,
      selector: step.selector.trim(),
      ...(step.frameUrl ? { frameUrl: step.frameUrl } : {})
    }));

  if (storedPathSteps && storedPathSteps.length > 0) {
    return storedPathSteps;
  }

  const fallbackSelector = typeof issue.locationPath === "string" ? issue.locationPath.trim() : "";
  return fallbackSelector.length > 0
    ? [{ context: "DOCUMENT", selector: fallbackSelector }]
    : [];
}

export function getReplayIssueCarouselContext(
  issue: IssueResultModel
): IssueLocatorCarouselContext | null {
  const context = issue.locator?.carouselContext;
  if (
    context === null ||
    context === undefined ||
    !Number.isSafeInteger(context.carouselId) ||
    context.carouselId <= 0 ||
    !Number.isSafeInteger(context.slideIndex) ||
    context.slideIndex < 0 ||
    !Number.isSafeInteger(context.slideCount) ||
    context.slideCount < 2 ||
    context.slideCount > 10_000 ||
    context.slideIndex >= context.slideCount
  ) {
    return null;
  }

  return {
    carouselId: context.carouselId,
    slideIndex: context.slideIndex,
    slideCount: context.slideCount
  };
}

export function hasUsableIssueLocator(issue: IssueResultModel): boolean {
  return getReplayIssuePathSteps(issue).length > 0;
}

import type {
  IssueLocatorCarouselContext,
  IssueLocatorContent,
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

function getStoredPathSteps(issue: IssueResultModel): IssueLocatorPathStep[] {
  const rawPathSteps = issue.locator?.pathSteps;
  return (Array.isArray(rawPathSteps) ? rawPathSteps : [])
    .filter(isUsablePathStep)
    .map((step) => ({
      context: step.context,
      selector: step.selector.trim(),
      ...(step.frameUrl ? { frameUrl: step.frameUrl } : {})
    }));
}

export type IssueCoordinateBox = { x: number; y: number; width: number; height: number };

const COORDINATE_LIMIT = 1_000_000;

function isCoordinate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= COORDINATE_LIMIT;
}

// Findings from the visual engine have no DOM path, only the box measured on
// the analysis screenshot. Their `locationPath` is a coordinate label, not a
// selector. Screenshot pixels become document CSS pixels by the capture scale.
export function getIssueCoordinateBox(
  issue: IssueResultModel,
  deviceScaleFactor: number | null | undefined = 1
): IssueCoordinateBox | null {
  const locator = issue.locator;
  if (!locator || getStoredPathSteps(issue).length > 0) return null;
  const { x, y, width, height, coordinateSpace } = locator;
  if (coordinateSpace !== "SCREENSHOT_PX" && coordinateSpace !== "DOCUMENT_CSS_PX") return null;
  if (!isCoordinate(x) || !isCoordinate(y) || !isCoordinate(width) || !isCoordinate(height) || width <= 0 || height <= 0) {
    return null;
  }
  const scale = coordinateSpace === "SCREENSHOT_PX" &&
    typeof deviceScaleFactor === "number" && Number.isFinite(deviceScaleFactor) && deviceScaleFactor > 0
    ? deviceScaleFactor
    : 1;
  const box = { x: x / scale, y: y / scale, width: width / scale, height: height / scale };
  // A capture scale below 1 enlarges the box; the viewer rejects the whole
  // issue list when any coordinate exceeds its bound.
  return [box.x, box.y, box.width, box.height].every(isCoordinate) ? box : null;
}

export function getReplayIssuePathSteps(issue: IssueResultModel): IssueLocatorPathStep[] {
  const storedPathSteps = getStoredPathSteps(issue);
  if (storedPathSteps.length > 0) {
    return storedPathSteps;
  }
  if (getIssueCoordinateBox(issue) !== null) {
    return [];
  }

  const fallbackSelector = typeof issue.locationPath === "string" ? issue.locationPath.trim() : "";
  return fallbackSelector.length > 0
    ? [{ context: "DOCUMENT", selector: fallbackSelector }]
    : [];
}

const CONTENT_TEXT_LIMIT = 200;
const CONTENT_IMAGE_LIMIT = 2_048;

// Visual-engine findings follow the element found under their box. The viewer
// compares this analysed content with the live element and hides the marker
// once the element shows something else. Without an element path there is
// nothing to compare.
export function getReplayIssueContent(issue: IssueResultModel): IssueLocatorContent | null {
  const content = issue.locator?.content;
  if (!content || getStoredPathSteps(issue).length === 0) return null;
  const text = typeof content.text === "string" ? content.text : "";
  const image = typeof content.image === "string" && content.image.length > 0 ? content.image : null;
  if (text.length > CONTENT_TEXT_LIMIT || (image !== null && image.length > CONTENT_IMAGE_LIMIT)) return null;
  return { text, image };
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

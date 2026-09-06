import type { OrganizationModel, EvaluationRequestModel } from "@/types/accessibility-domain";

export const QUICK_ANALYSIS_REGISTRY_KEY = "uni-access.quick-analysis-results.v2";
export const QUICK_ANALYSIS_REGISTRY_VERSION = 2;
const MAX_STORED_QUICK_ANALYSIS_RESULTS = 50;
const MAX_RECENT_ANALYZED_PAGES = 5;

export type QuickAnalysisResultRecord = {
  projectId: number;
  pageId: number;
  timestamp: number;
};

export type RecentAnalyzedPage = {
  pageId: number;
  pageName: string;
  projectId: number;
  projectName: string;
  systemManaged?: boolean;
  sortTimestamp: number;
};

const EMPTY_REGISTRY: readonly QuickAnalysisResultRecord[] = Object.freeze([]);
const registryListeners = new Set<() => void>();

let registrySnapshot: readonly QuickAnalysisResultRecord[] = EMPTY_REGISTRY;
let isRegistryHydrated = false;
let isStorageListenerAttached = false;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function normalizeRegistryRecord(value: unknown): QuickAnalysisResultRecord | null {
  if (
    !isRecord(value) ||
    !isPositiveInteger(value.projectId) ||
    !isPositiveInteger(value.pageId) ||
    typeof value.timestamp !== "number" ||
    !Number.isFinite(value.timestamp) ||
    value.timestamp <= 0
  ) {
    return null;
  }

  return {
    projectId: value.projectId,
    pageId: value.pageId,
    timestamp: value.timestamp
  };
}

function normalizeRegistryPayload(value: unknown): readonly QuickAnalysisResultRecord[] {
  if (
    !isRecord(value) ||
    value.version !== QUICK_ANALYSIS_REGISTRY_VERSION ||
    !Array.isArray(value.records)
  ) {
    return EMPTY_REGISTRY;
  }

  const rawRecords = value.records;
  const normalizedRecords = rawRecords
    .map(normalizeRegistryRecord)
    .filter((record): record is QuickAnalysisResultRecord => record !== null)
    .sort((left, right) => right.timestamp - left.timestamp);
  const seenTargets = new Set<string>();
  const deduplicatedRecords: QuickAnalysisResultRecord[] = [];

  for (const record of normalizedRecords) {
    const targetKey = `${record.projectId}:${record.pageId}`;
    if (seenTargets.has(targetKey)) {
      continue;
    }

    seenTargets.add(targetKey);
    deduplicatedRecords.push(record);
    if (deduplicatedRecords.length >= MAX_STORED_QUICK_ANALYSIS_RESULTS) {
      break;
    }
  }

  return Object.freeze(deduplicatedRecords);
}

export function parseQuickAnalysisRegistry(
  serializedRegistry: string | null
): readonly QuickAnalysisResultRecord[] {
  if (!serializedRegistry) {
    return EMPTY_REGISTRY;
  }

  try {
    return normalizeRegistryPayload(JSON.parse(serializedRegistry));
  } catch {
    return EMPTY_REGISTRY;
  }
}

function readRegistryFromStorage(): readonly QuickAnalysisResultRecord[] {
  if (typeof window === "undefined") {
    return EMPTY_REGISTRY;
  }

  try {
    return parseQuickAnalysisRegistry(
      window.localStorage.getItem(QUICK_ANALYSIS_REGISTRY_KEY)
    );
  } catch {
    return EMPTY_REGISTRY;
  }
}

function hydrateRegistry(): void {
  if (isRegistryHydrated) {
    return;
  }

  registrySnapshot = readRegistryFromStorage();
  isRegistryHydrated = true;
}

function notifyRegistryListeners(): void {
  registryListeners.forEach((listener) => listener());
}

function ensureStorageListener(): void {
  if (isStorageListenerAttached || typeof window === "undefined") {
    return;
  }

  window.addEventListener("storage", (event) => {
    if (event.key !== QUICK_ANALYSIS_REGISTRY_KEY && event.key !== null) {
      return;
    }

    registrySnapshot =
      event.key === null ? EMPTY_REGISTRY : parseQuickAnalysisRegistry(event.newValue);
    isRegistryHydrated = true;
    notifyRegistryListeners();
  });
  isStorageListenerAttached = true;
}

export function getQuickAnalysisRegistrySnapshot(): readonly QuickAnalysisResultRecord[] {
  hydrateRegistry();
  return registrySnapshot;
}

export function getQuickAnalysisRegistryServerSnapshot(): readonly QuickAnalysisResultRecord[] {
  return EMPTY_REGISTRY;
}

export function subscribeQuickAnalysisRegistry(listener: () => void): () => void {
  hydrateRegistry();
  ensureStorageListener();
  registryListeners.add(listener);

  return () => {
    registryListeners.delete(listener);
  };
}

export function buildRecentAnalyzedPages({
  organizations,
  quickAnalysisResults,
  evaluationRequests = [],
  limit = MAX_RECENT_ANALYZED_PAGES
}: {
  organizations: readonly OrganizationModel[];
  quickAnalysisResults: readonly QuickAnalysisResultRecord[];
  evaluationRequests?: readonly EvaluationRequestModel[];
  limit?: number;
}): RecentAnalyzedPage[] {
  const safeLimit = Number.isInteger(limit) && limit > 0 ? limit : MAX_RECENT_ANALYZED_PAGES;

  // Server receipts survive reloads while jobs are pending. Keep old local
  // records as a compatibility source, but never infer quick analyses from all
  // project requests or completion status alone.
  const records = [...quickAnalysisResults];
  for (const request of evaluationRequests) {
    if (!request.quickAnalysis) continue;
    const project = organizations.find((organization) =>
      organization.evaluationTargets.some((target) => target.id === request.evaluationTargetId));
    const timestamp = Date.parse(request.requestedAt);
    if (project && Number.isFinite(timestamp)) {
      records.push({ projectId: project.id, pageId: request.evaluationTargetId, timestamp });
    }
  }
  const seenPages = new Set<number>();
  return records
    .map((result): RecentAnalyzedPage | null => {
      const project = organizations.find((candidate) => candidate.id === result.projectId);
      const page = project?.evaluationTargets.find((candidate) => candidate.id === result.pageId);
      if (!project || !page) {
        return null;
      }

      return {
        pageId: page.id,
        pageName: page.name,
        projectId: project.id,
        projectName: project.name,
        systemManaged: project.systemManaged,
        sortTimestamp: result.timestamp
      };
    })
    .filter((page): page is RecentAnalyzedPage => page !== null)
    .sort(
      (left, right) =>
        right.sortTimestamp - left.sortTimestamp ||
        left.pageId - right.pageId ||
        left.projectId - right.projectId
    )
    .filter((page) => {
      if (seenPages.has(page.pageId)) return false;
      seenPages.add(page.pageId);
      return true;
    })
    .slice(0, safeLimit);
}

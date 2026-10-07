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

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function normalizeRegistryRecord(value: unknown): QuickAnalysisResultRecord | null {
  if (
    !isObjectRecord(value) ||
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
    !isObjectRecord(value) ||
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

// Kept local: scripts/verify-sidebar-selection.mjs loads this module directly
// in Node, which does not resolve the "@/" alias.
function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
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

  // Look projects up once instead of scanning every project per record.
  const projectById = new Map<number, OrganizationModel>();
  const projectByPageId = new Map<number, OrganizationModel>();
  for (const organization of organizations) {
    if (!projectById.has(organization.id)) projectById.set(organization.id, organization);
    for (const target of organization.evaluationTargets) {
      if (!projectByPageId.has(target.id)) projectByPageId.set(target.id, organization);
    }
  }

  // Each page keeps only its latest record (ties: the lower project id), so
  // the sort below covers at most one entry per page.
  const latestByPage = new Map<number, RecentAnalyzedPage>();
  const consider = (projectId: number, pageId: number, timestamp: number) => {
    const project = projectById.get(projectId);
    const page = project?.evaluationTargets.find((candidate) => candidate.id === pageId);
    if (!project || !page) return;
    const current = latestByPage.get(page.id);
    if (current && (current.sortTimestamp > timestamp ||
      (current.sortTimestamp === timestamp && current.projectId <= project.id))) return;
    latestByPage.set(page.id, {
      pageId: page.id,
      pageName: page.name,
      projectId: project.id,
      projectName: project.name,
      systemManaged: project.systemManaged,
      sortTimestamp: timestamp
    });
  };

  // Server receipts survive reloads while jobs are pending. Keep old local
  // records as a compatibility source, but never infer quick analyses from all
  // project requests or completion status alone.
  for (const result of quickAnalysisResults) consider(result.projectId, result.pageId, result.timestamp);
  for (const request of evaluationRequests) {
    if (!request.quickAnalysis) continue;
    const project = projectByPageId.get(request.evaluationTargetId);
    const timestamp = Date.parse(request.requestedAt);
    if (project && Number.isFinite(timestamp)) consider(project.id, request.evaluationTargetId, timestamp);
  }

  return [...latestByPage.values()]
    .sort((left, right) => right.sortTimestamp - left.sortTimestamp || left.pageId - right.pageId)
    .slice(0, safeLimit);
}

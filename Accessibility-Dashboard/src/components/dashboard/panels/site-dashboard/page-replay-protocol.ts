import type { IssueLocatorPathStep } from "@/types/accessibility-domain";

import { getReplayIssuePathSteps } from "./issue-locator";
import type { RecentIssueRow } from "./types";

export const DASHBOARD_REPLAY_SOURCE = "accessibility-dashboard" as const;
export const PAGE_REPLAY_SOURCE = "accessibility-page-replay" as const;

const DOCUMENT_TOKEN_MAX_LENGTH = 128;

const REPLAY_TEXT_LIMITS = {
  severityLabel: 32,
  code: 128,
  title: 300,
  message: 1_600,
  path: 2_048
} as const;

export type PageReplayIssue = {
  id: number;
  severity: RecentIssueRow["severity"]["key"];
  severityLabel: string;
  code: string;
  title: string;
  message: string;
  path: string | null;
  pathSteps: IssueLocatorPathStep[];
};

export type DashboardToPageReplayMessage =
  | {
      source: typeof DASHBOARD_REPLAY_SOURCE;
      type: "REQUEST_DOCUMENT_STATE";
    }
  | {
      source: typeof DASHBOARD_REPLAY_SOURCE;
      type: "INIT_ISSUES";
      issues: PageReplayIssue[];
      selectedIssueId: number | null;
      markersVisible: boolean;
    }
  | {
      source: typeof DASHBOARD_REPLAY_SOURCE;
      type: "FOCUS_ISSUE";
      issueId: number | null;
    }
  | {
      source: typeof DASHBOARD_REPLAY_SOURCE;
      type: "SET_MARKERS_VISIBLE";
      markersVisible: boolean;
    };

export type LocatorConnectionStatus = "CONNECTED" | "UNAVAILABLE";

export type PageReplayToDashboardMessage =
  | {
      source: typeof PAGE_REPLAY_SOURCE;
      type: "DOCUMENT_LOADING" | "DOCUMENT_UNLOADING" | "READY";
      documentToken: string;
    }
  | {
      source: typeof PAGE_REPLAY_SOURCE;
      type: "ISSUE_SELECTED";
      documentToken: string;
      issueId: number | null;
    }
  | {
      source: typeof PAGE_REPLAY_SOURCE;
      type: "ISSUE_DETAIL_FALLBACK";
      documentToken: string;
      issueId: number | null;
    }
  | {
      source: typeof PAGE_REPLAY_SOURCE;
      type: "LOCATOR_STATUS";
      documentToken: string;
      issueId: number;
      status: LocatorConnectionStatus;
      reason?: string;
    }
  | {
      source: typeof PAGE_REPLAY_SOURCE;
      type: "LINK_BLOCKED";
      documentToken: string;
      href?: string;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function isIssueId(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function hasExactOwnKeys(value: Record<string, unknown>, expectedKeys: readonly string[]): boolean {
  const ownKeys = Reflect.ownKeys(value);
  return (
    ownKeys.length === expectedKeys.length &&
    expectedKeys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function hasOwnKey(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isDocumentToken(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= DOCUMENT_TOKEN_MAX_LENGTH &&
    /^[A-Za-z0-9_-]+$/.test(value)
  );
}

export function toPageReplayIssue(row: RecentIssueRow): PageReplayIssue {
  return {
    id: row.issue.id,
    severity: row.severity.key,
    severityLabel: toBoundedReplayText(
      row.severity.label,
      REPLAY_TEXT_LIMITS.severityLabel,
      row.severity.key
    ),
    code: toBoundedReplayText(row.issue.issueCode, REPLAY_TEXT_LIMITS.code, "UNKNOWN"),
    title: toBoundedReplayText(
      row.issue.issueTitle,
      REPLAY_TEXT_LIMITS.title,
      "접근성 문제"
    ),
    message: toBoundedReplayText(
      row.issue.message,
      REPLAY_TEXT_LIMITS.message,
      "상세 설명이 없습니다."
    ),
    path: toOptionalBoundedReplayText(row.issue.locationPath, REPLAY_TEXT_LIMITS.path),
    pathSteps: getReplayIssuePathSteps(row.issue)
  };
}

function toBoundedReplayText(
  value: string | null | undefined,
  maxLength: number,
  fallback: string
): string {
  const normalized = typeof value === "string" ? value.replace(/\0/g, "").trim() : "";
  return (normalized || fallback).slice(0, maxLength);
}

function toOptionalBoundedReplayText(
  value: string | null | undefined,
  maxLength: number
): string | null {
  const normalized = typeof value === "string" ? value.replace(/\0/g, "").trim() : "";
  return normalized ? normalized.slice(0, maxLength) : null;
}

export function parsePageReplayMessage(value: unknown): PageReplayToDashboardMessage | null {
  if (!isRecord(value) || value.source !== PAGE_REPLAY_SOURCE || typeof value.type !== "string") {
    return null;
  }

  if (
    (value.type === "DOCUMENT_LOADING" ||
      value.type === "DOCUMENT_UNLOADING" ||
      value.type === "READY") &&
    hasExactOwnKeys(value, ["source", "type", "documentToken"]) &&
    isDocumentToken(value.documentToken)
  ) {
    return {
      source: PAGE_REPLAY_SOURCE,
      type: value.type,
      documentToken: value.documentToken
    };
  }

  if (
    value.type === "ISSUE_SELECTED" &&
    hasExactOwnKeys(value, ["source", "type", "documentToken", "issueId"]) &&
    isDocumentToken(value.documentToken) &&
    (value.issueId === null || isIssueId(value.issueId))
  ) {
    return {
      source: PAGE_REPLAY_SOURCE,
      type: "ISSUE_SELECTED",
      documentToken: value.documentToken,
      issueId: value.issueId
    };
  }

  if (
    value.type === "ISSUE_DETAIL_FALLBACK" &&
    hasExactOwnKeys(value, ["source", "type", "documentToken", "issueId"]) &&
    isDocumentToken(value.documentToken) &&
    (value.issueId === null || isIssueId(value.issueId))
  ) {
    return {
      source: PAGE_REPLAY_SOURCE,
      type: "ISSUE_DETAIL_FALLBACK",
      documentToken: value.documentToken,
      issueId: value.issueId
    };
  }

  if (
    value.type === "LOCATOR_STATUS" &&
    hasExactOwnKeys(
      value,
      hasOwnKey(value, "reason")
        ? ["source", "type", "documentToken", "issueId", "status", "reason"]
        : ["source", "type", "documentToken", "issueId", "status"]
    ) &&
    isDocumentToken(value.documentToken) &&
    isIssueId(value.issueId) &&
    (value.status === "CONNECTED" || value.status === "UNAVAILABLE") &&
    (value.reason === undefined || typeof value.reason === "string")
  ) {
    return {
      source: PAGE_REPLAY_SOURCE,
      type: "LOCATOR_STATUS",
      documentToken: value.documentToken,
      issueId: value.issueId,
      status: value.status,
      ...(typeof value.reason === "string" ? { reason: value.reason } : {})
    };
  }

  if (
    value.type === "LINK_BLOCKED" &&
    hasExactOwnKeys(
      value,
      hasOwnKey(value, "href")
        ? ["source", "type", "documentToken", "href"]
        : ["source", "type", "documentToken"]
    ) &&
    isDocumentToken(value.documentToken) &&
    (value.href === undefined || typeof value.href === "string")
  ) {
    return {
      source: PAGE_REPLAY_SOURCE,
      type: "LINK_BLOCKED",
      documentToken: value.documentToken,
      ...(typeof value.href === "string" ? { href: value.href } : {})
    };
  }

  return null;
}

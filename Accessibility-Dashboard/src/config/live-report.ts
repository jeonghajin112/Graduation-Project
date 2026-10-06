const DEFAULT_LIVE_REPORT_VIEWER_BASE_URL = "http://localhost:9090";

export function resolveLiveReportViewerBaseUrl(value: string | undefined): string {
  const configuredValue = value?.trim() ?? "";
  return configuredValue.length > 0
    ? configuredValue
    : DEFAULT_LIVE_REPORT_VIEWER_BASE_URL;
}

export const LIVE_REPORT_VIEWER_BASE_URL = resolveLiveReportViewerBaseUrl(
  import.meta.env.VITE_LIVE_REPORT_VIEWER_BASE_URL
);

export type LiveReportViewerBase = Readonly<{
  hostname: string;
  port: string;
  protocol: "http:" | "https:";
}>;

export function parseLiveReportViewerBase(
  value = LIVE_REPORT_VIEWER_BASE_URL
): LiveReportViewerBase | null {
  try {
    const url = new URL(value);
    const isLocalDevelopmentOrigin = url.hostname === "localhost";
    if (
      (url.protocol !== "https:" && !(isLocalDevelopmentOrigin && url.protocol === "http:")) ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.pathname !== "/" ||
      url.search.length > 0 ||
      url.hash.length > 0 ||
      url.hostname.endsWith(".")
    ) {
      return null;
    }

    return {
      hostname: url.hostname,
      port: url.port,
      protocol: url.protocol
    };
  } catch {
    return null;
  }
}

export function isLiveReportViewerOriginAllowed(
  viewerOrigin: string,
  viewerBaseUrl = LIVE_REPORT_VIEWER_BASE_URL
): boolean {
  const viewerBase = parseLiveReportViewerBase(viewerBaseUrl);
  if (viewerBase === null) {
    return false;
  }

  try {
    const viewerUrl = new URL(viewerOrigin);
    const hostnameSuffix = `.${viewerBase.hostname}`;
    if (!viewerUrl.hostname.endsWith(hostnameSuffix)) {
      return false;
    }
    const routeLabel = viewerUrl.hostname.slice(0, -hostnameSuffix.length);

    return (
      /^[0-9a-f]{40}$/.test(routeLabel) &&
      viewerUrl.protocol === viewerBase.protocol &&
      viewerUrl.port === viewerBase.port &&
      viewerUrl.username.length === 0 &&
      viewerUrl.password.length === 0 &&
      viewerUrl.pathname === "/" &&
      viewerUrl.search.length === 0 &&
      viewerUrl.hash.length === 0 &&
      viewerUrl.origin === viewerOrigin
    );
  } catch {
    return false;
  }
}

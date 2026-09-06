import { Globe2, RefreshCw } from "lucide-react";
import { useState } from "react";

import { formatDateTime } from "@/components/dashboard/shared/utils";
import type { EvaluationCaptureMetadataLoadState } from "./use-evaluation-capture-metadata";

type PageInformationPanelProps = {
  accessUrl: string;
  analyzedAt: string | null;
  captureMetadataErrorMessage: string | null;
  captureMetadataLoadState: EvaluationCaptureMetadataLoadState;
  onRetryCaptureMetadata: () => void;
  faviconUrl?: string | null;
  name: string;
  isRequestingAnalysis: boolean;
  analysisRequestError: string | null;
  onRequestAnalysis?: () => void;
};

function PageFavicon({ faviconUrl }: { faviconUrl?: string | null }) {
  const [loadedFaviconUrl, setLoadedFaviconUrl] = useState<string | null>(null);
  const [failedFaviconUrl, setFailedFaviconUrl] = useState<string | null>(null);
  const hasLoadedFavicon = Boolean(faviconUrl && loadedFaviconUrl === faviconUrl);

  return (
    <span
      className="site-page-information__icon"
      data-favicon-loaded={hasLoadedFavicon ? "true" : "false"}
      aria-hidden="true"
    >
      {!hasLoadedFavicon ? <Globe2 size={17} strokeWidth={1.8} /> : null}
      {faviconUrl && failedFaviconUrl !== faviconUrl ? (
        <img
          src={faviconUrl}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onLoad={() => {
            setLoadedFaviconUrl(faviconUrl);
            setFailedFaviconUrl(null);
          }}
          onError={() => {
            setLoadedFaviconUrl(null);
            setFailedFaviconUrl(faviconUrl);
          }}
        />
      ) : null}
    </span>
  );
}

export function PageInformationPanel({
  accessUrl,
  analyzedAt,
  captureMetadataErrorMessage,
  captureMetadataLoadState,
  onRetryCaptureMetadata,
  faviconUrl,
  name,
  isRequestingAnalysis,
  analysisRequestError,
  onRequestAnalysis
}: PageInformationPanelProps) {
  return (
    <section className="site-rail-card site-page-information" aria-labelledby="site-page-information-heading">
      <div className="site-rail-card__heading site-page-information__heading">
        <h3 id="site-page-information-heading">페이지 정보</h3>
        <div className="site-page-information__analysis-actions">
          <dl className="site-page-information__metadata">
            <div>
              <dt className="sr-only">최근 분석</dt>
              <dd>{formatDateTime(analyzedAt)}</dd>
            </div>
          </dl>
          {onRequestAnalysis && (
            <button
              type="button"
              className="site-page-information__rescan"
              onClick={onRequestAnalysis}
              disabled={isRequestingAnalysis}
              aria-busy={isRequestingAnalysis}
            >
              <RefreshCw size={12} aria-hidden="true" />
              {isRequestingAnalysis ? "요청 중…" : "재분석"}
            </button>
          )}
        </div>
      </div>

      {analysisRequestError && (
        <p className="site-page-information__capture-status" role="alert">
          {analysisRequestError}
        </p>
      )}

      <div className="site-page-information__identity">
        <PageFavicon key={`${accessUrl}:${faviconUrl ?? "fallback"}`} faviconUrl={faviconUrl} />
        <div className="site-page-information__title">
          <strong title={name}>{name}</strong>
          <a href={accessUrl} target="_blank" rel="noreferrer" title={accessUrl}>
            {accessUrl}
          </a>
        </div>
      </div>

      {captureMetadataLoadState === "loading" && (
        <p className="site-page-information__capture-status" role="status">
          분석 당시 화면 정보를 불러오는 중입니다.
        </p>
      )}
      {captureMetadataLoadState === "error" && (
        <div className="site-page-information__capture-status" role="alert">
          <p>분석 당시 화면 정보를 불러오지 못했습니다.</p>
          {captureMetadataErrorMessage && <p>{captureMetadataErrorMessage}</p>}
          <button type="button" onClick={onRetryCaptureMetadata}>
            화면 정보 다시 불러오기
          </button>
        </div>
      )}
    </section>
  );
}

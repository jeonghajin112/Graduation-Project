import { Globe2 } from "lucide-react";

import { formatDateTime } from "@/components/dashboard/shared/utils";

type PageInformationPanelProps = {
  accessUrl: string;
  analyzedAt: string | null;
  faviconUrl?: string | null;
  name: string;
  targetType: string;
  viewportHeight: number | null;
  viewportWidth: number | null;
};

function formatTargetType(targetType: string): string {
  const normalized = targetType.trim().toUpperCase();
  if (normalized.includes("MOBILE") || targetType.includes("모바일")) {
    return "모바일 웹";
  }
  if (normalized.includes("DOCUMENT") || targetType.includes("문서")) {
    return "문서";
  }
  return "PC 웹";
}

function formatViewport(width: number | null, height: number | null): string {
  if (!width || !height) {
    return "-";
  }

  return `${width.toLocaleString("ko-KR")} × ${height.toLocaleString("ko-KR")} px`;
}

export function PageInformationPanel({
  accessUrl,
  analyzedAt,
  faviconUrl,
  name,
  targetType,
  viewportHeight,
  viewportWidth
}: PageInformationPanelProps) {
  return (
    <section className="site-rail-card site-page-information" aria-labelledby="site-page-information-heading">
      <div className="site-rail-card__heading">
        <h3 id="site-page-information-heading">페이지 정보</h3>
      </div>

      <div className="site-page-information__identity">
        <span className="site-page-information__icon" aria-hidden="true">
          <Globe2 size={17} strokeWidth={1.8} />
          {faviconUrl ? (
            <img
              src={faviconUrl}
              alt=""
              loading="lazy"
              referrerPolicy="no-referrer"
              onError={(event) => {
                event.currentTarget.hidden = true;
              }}
            />
          ) : null}
        </span>
        <div className="site-page-information__title">
          <strong title={name}>{name}</strong>
          <a href={accessUrl} target="_blank" rel="noreferrer" title={accessUrl}>
            {accessUrl}
          </a>
        </div>
      </div>

      <dl className="site-page-information__metadata">
        <div>
          <dt>대상</dt>
          <dd>{formatTargetType(targetType)}</dd>
        </div>
        <div>
          <dt>최근 분석</dt>
          <dd>{formatDateTime(analyzedAt)}</dd>
        </div>
        <div>
          <dt>재현 화면</dt>
          <dd>{formatViewport(viewportWidth, viewportHeight)}</dd>
        </div>
      </dl>
    </section>
  );
}

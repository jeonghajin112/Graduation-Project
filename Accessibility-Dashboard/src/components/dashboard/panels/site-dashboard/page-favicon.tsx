import { Globe2 } from "lucide-react";
import { useState } from "react";

export function PageFavicon({ faviconUrl, className = "site-page-information__icon" }: { faviconUrl?: string | null; className?: string }) {
  const [loadedFaviconUrl, setLoadedFaviconUrl] = useState<string | null>(null);
  const [failedFaviconUrl, setFailedFaviconUrl] = useState<string | null>(null);
  const hasLoadedFavicon = Boolean(faviconUrl && loadedFaviconUrl === faviconUrl);

  return (
    <span
      className={className}
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

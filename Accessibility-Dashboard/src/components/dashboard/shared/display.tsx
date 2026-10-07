import { FileText, Globe, Smartphone } from "lucide-react";

export function renderTargetTypeIcon(type: string) {
  if (type === "문서") {
    return <FileText size={15} aria-label="문서" />;
  }
  if (type === "모바일 웹") {
    return <Smartphone size={15} aria-label="모바일 웹" />;
  }
  return <Globe size={15} strokeWidth={1.8} aria-label="인터넷" />;
}


export function PanelMessage({ label, isError = false, className = "" }: { label: string; isError?: boolean; className?: string }) {
  return (
    <article
      role={isError ? "alert" : "status"}
      className={className || "dashboard-status-card"}
    >
      {label}
    </article>
  );
}

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
      className={`rounded-[28px] border p-5 text-sm ${
        isError ? "border-rose-200 bg-rose-50 text-rose-700" : "border-slate-200 bg-white text-slate-600"
      } ${className}`}
    >
      {label}
    </article>
  );
}

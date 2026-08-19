import { motion } from "framer-motion";
import { ArrowDownRight, ArrowUpRight, FileText, Globe, Smartphone } from "lucide-react";

import { useSidebar } from "@/components/ui/sidebar";

import { metricSparklineColors } from "./constants";
import { buildMetricSparklinePoints } from "./utils";

export function renderTargetTypeIcon(type: string) {
  if (type === "문서") {
    return <FileText size={15} aria-label="문서" />;
  }
  if (type === "모바일 웹") {
    return <Smartphone size={15} aria-label="모바일 웹" />;
  }
  return <Globe size={15} strokeWidth={1.8} aria-label="인터넷" />;
}


export function BridgeLogo() {
  const { open, animate } = useSidebar();

  return (
    <div className="flex min-h-[42px] items-center overflow-hidden rounded-full p-2">
      <motion.svg
        animate={{
          opacity: animate ? (open ? 1 : 0) : 1,
          x: animate ? (open ? 0 : -8) : 0,
          maxWidth: animate ? (open ? 180 : 0) : 180
        }}
        transition={{ duration: 0.15, ease: "easeOut" }}
        className="dashboard-sidebar-wordmark overflow-hidden text-slate-900"
        viewBox="-8 -4 178 38"
        role="img"
        aria-label="UNIACCESS"
      >
        <text
          x="2"
          y="25"
          fill="currentColor"
          fontFamily="'Pretendard Variable', Pretendard, 'Noto Sans KR', sans-serif"
          fontSize="25"
          fontWeight="900"
          letterSpacing="-0.8"
          transform="skewX(-7)"
        >
          UNIACCESS
        </text>
      </motion.svg>
    </div>
  );
}


export function MetricCard({
  title,
  value,
  note,
  trend,
  trendUp,
  color,
  sparklineSeries
}: {
  title: string;
  value: string;
  note: string;
  trend: string;
  trendUp: boolean;
  color: "orange" | "emerald" | "indigo" | "rose";
  sparklineSeries?: number[];
}) {
  const sparklinePoints = buildMetricSparklinePoints(sparklineSeries ?? [10, 30, 20, 45, 28, 38, 35]);
  const sparklineColor = metricSparklineColors[color];

  return (
    <article className="rounded-[24px] border border-slate-200 bg-white p-4">
      <div className="flex items-start justify-between gap-2">
        <p className="text-[11px] font-semibold text-slate-500">{title}</p>
        <svg viewBox="0 0 64 28" className="h-6 w-14">
          <polyline fill="none" stroke={sparklineColor} strokeOpacity="0.82" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" points={sparklinePoints} />
        </svg>
      </div>
      <p className="mt-1 text-3xl font-bold tracking-tight text-slate-900">{value}</p>
      <div className="mt-1 flex items-center justify-between">
        <p className="text-xs text-slate-500">{note}</p>
        <span className={`inline-flex items-center gap-0.5 text-xs font-semibold ${trendUp ? "text-emerald-600" : "text-rose-500"}`}>
          {trend}
          {trendUp ? <ArrowUpRight size={12} /> : <ArrowDownRight size={12} />}
        </span>
      </div>
    </article>
  );
}


export function InfoField({ label, value, breakAll = false }: { label: string; value: string; breakAll?: boolean }) {
  return (
    <div className="rounded-2xl border border-slate-200 px-3 py-2">
      <p className="text-[11px] text-slate-500">{label}</p>
      <p className={`mt-1 text-sm text-slate-700 ${breakAll ? "break-all" : ""}`}>{value}</p>
    </div>
  );
}


export function PanelMessage({ label, isError = false }: { label: string; isError?: boolean }) {
  return (
    <article
      role={isError ? "alert" : "status"}
      className={`rounded-[28px] border p-5 text-sm ${
        isError ? "border-rose-200 bg-rose-50 text-rose-700" : "border-slate-200 bg-white text-slate-600"
      }`}
    >
      {label}
    </article>
  );
}

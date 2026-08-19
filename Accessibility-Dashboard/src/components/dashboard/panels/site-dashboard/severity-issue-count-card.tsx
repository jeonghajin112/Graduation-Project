import type { IssueSeverityRow } from "./types";

type SeverityIssueCountCardProps = {
  rows: IssueSeverityRow[];
  totalCount: number;
  maxCount: number;
};

export function SeverityIssueCountCard({ rows, totalCount, maxCount }: SeverityIssueCountCardProps) {
  return (
    <article className="dashboard-card rounded-[28px] border border-slate-200 bg-slate-100 p-4">
      <div className="flex items-start justify-between gap-3">
        <h2 className="text-sm font-semibold text-slate-900">위험도별 문제 수</h2>
        <p className="inline-flex items-center gap-1.5 rounded-full bg-white px-3 py-1.5 text-xs font-semibold text-[#8a94a6]">
          전체 문제 수
          <span className="text-sm font-bold text-slate-950">{totalCount}건</span>
        </p>
      </div>
      <div className="mt-4 space-y-3">
        {rows.map((row) => (
          <div key={row.key}>
            <div className="mb-1 flex items-center justify-between text-xs">
              <span className="font-semibold text-slate-700">{row.label}</span>
              <span className="font-bold text-slate-950">{row.count}건</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-white">
              <div
                className="h-full rounded-full"
                style={{
                  width: `${Math.max((row.count / maxCount) * 100, row.count > 0 ? 12 : 0)}%`,
                  backgroundColor: row.color
                }}
                aria-hidden="true"
              />
            </div>
          </div>
        ))}
      </div>
    </article>
  );
}

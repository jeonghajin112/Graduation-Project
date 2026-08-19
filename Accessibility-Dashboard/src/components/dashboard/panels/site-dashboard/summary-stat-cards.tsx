import type { SiteSummaryItem } from "./types";

type SummaryStatCardsProps = {
  items: SiteSummaryItem[];
};

export function SummaryStatCards({ items }: SummaryStatCardsProps) {
  return (
    <dl className="site-summary-stat-grid grid min-h-0 grid-cols-3">
      {items.map((item) => (
        <div
          key={item.label}
          className="site-summary-stat-item flex min-h-[96px] flex-col justify-between px-4 py-3"
        >
          <dt className="site-summary-stat-label text-xs font-semibold text-[var(--dashboard-text-muted)]">
            {item.label}
          </dt>
          <dd className="site-summary-stat-value flex items-end gap-1">
            <span className="text-3xl font-bold leading-none text-[var(--dashboard-text-strong)]">{item.value}</span>
            {item.unit.length > 0 && (
              <span className="pb-px text-sm font-semibold text-[var(--dashboard-text-muted)]">{item.unit}</span>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

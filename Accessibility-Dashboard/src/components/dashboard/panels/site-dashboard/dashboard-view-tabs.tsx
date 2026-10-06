import { useRef, type KeyboardEvent } from "react";

// Kept apart from the lazily loaded report so the page detail route does not
// pull report aggregation code into its initial bundle.
export type DashboardView = "results" | "report";

export function parseDashboardView(value: string | null): DashboardView {
  return value === "report" ? "report" : "results";
}

const views: Array<{ value: DashboardView; label: string }> = [
  { value: "results", label: "분석 결과" },
  { value: "report", label: "최종 리포트" }
];

// Tab and panel ids: site-dashboard-tab-<view> and site-dashboard-panel-<view>.
// WAI-ARIA tabs with automatic activation: arrow keys, Home and End move the
// selection, and only the selected tab stays in the page Tab order.
export function DashboardViewTabs({ value, onChange }: {
  value: DashboardView;
  onChange: (view: DashboardView) => void;
}) {
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const count = views.length;
    const target = { ArrowRight: index + 1, ArrowLeft: index - 1 + count, Home: 0, End: count - 1 }[event.key];
    if (target === undefined) return;
    event.preventDefault();
    tabRefs.current[target % count]?.focus();
    onChange(views[target % count]!.value);
  }

  return (
    <div className="site-dashboard-tabs" role="tablist" aria-label="페이지 분석 보기">
      {views.map((view, index) => {
        const selected = view.value === value;
        return (
          <button
            key={view.value}
            ref={(element) => { tabRefs.current[index] = element; }}
            type="button"
            role="tab"
            id={`site-dashboard-tab-${view.value}`}
            className="site-dashboard-tabs__tab"
            aria-selected={selected}
            aria-controls={`site-dashboard-panel-${view.value}`}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(view.value)}
            onKeyDown={(event) => handleKeyDown(event, index)}
          >
            {view.label}
          </button>
        );
      })}
    </div>
  );
}

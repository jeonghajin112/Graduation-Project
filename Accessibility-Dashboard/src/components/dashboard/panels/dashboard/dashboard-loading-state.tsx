import { LoaderCircle } from "lucide-react";

export function DashboardLoadingState() {
  const skeletonLine = "animate-pulse rounded-full bg-slate-200/80";

  return (
    <div className="space-y-3" role="status" aria-live="polite">
      <div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-700">
        <LoaderCircle className="h-4 w-4 animate-spin text-[#ef6a50]" strokeWidth={2} />
        대시보드 데이터를 불러오는 중...
      </div>

      <div className="grid overflow-visible gap-3 xl:grid-cols-[minmax(0,1fr)_420px] 2xl:grid-cols-[minmax(0,1fr)_460px]">
        <div className="grid min-w-0 overflow-visible gap-3 xl:grid-cols-[minmax(220px,0.8fr)_minmax(220px,0.8fr)_minmax(280px,1.4fr)] xl:grid-rows-[280px_348px] 2xl:grid-cols-[minmax(240px,0.78fr)_minmax(240px,0.78fr)_minmax(320px,1.44fr)]">
          <article className="dashboard-card order-1 flex h-[280px] min-h-0 flex-col rounded-xl border border-slate-200 bg-white p-4">
            <div className={`${skeletonLine} h-4 w-36`} />
            <div className="mt-8 space-y-2">
              <div className={`${skeletonLine} h-8 w-20`} />
              <div className={`${skeletonLine} h-3 w-28`} />
            </div>
            <div className="mt-auto h-[132px] overflow-hidden rounded-b-[24px] bg-slate-100/80 p-4">
              <div className="mt-16 h-16 rounded-[50%] border-t-4 border-[#ef6a50]/40" />
            </div>
          </article>

          <div className="order-2 grid h-[280px] min-h-0 gap-3 lg:grid-cols-2 xl:col-span-2 xl:col-start-2 xl:row-start-1">
            {Array.from({ length: 2 }).map((_, index) => (
              <article key={index} className="dashboard-card flex min-h-0 flex-col rounded-xl border border-slate-200 bg-white p-4">
                <div className={`${skeletonLine} h-4 w-32`} />
                <div className={`${skeletonLine} mt-3 h-8 w-24`} />
                <div className="mt-auto grid grid-cols-4 items-end gap-3">
                  {[44, 74, 52, 64].map((height, barIndex) => (
                    <div key={barIndex} className="flex h-28 items-end">
                      <div
                        className="w-full animate-pulse rounded-xl bg-slate-200/80"
                        style={{ height: `${height}%` }}
                      />
                    </div>
                  ))}
                </div>
              </article>
            ))}
          </div>

          {Array.from({ length: 3 }).map((_, index) => (
            <article
              key={index}
              className="dashboard-card flex h-[348px] min-h-0 flex-col rounded-xl border border-slate-200 bg-white p-4"
            >
              <div className={`${skeletonLine} h-4 w-40`} />
              <div className="mt-6 grid flex-1 place-items-center">
                <div className="h-36 w-36 animate-pulse rounded-full border-[18px] border-slate-200/80" />
              </div>
              <div className="grid grid-cols-3 gap-2">
                <div className={`${skeletonLine} h-3`} />
                <div className={`${skeletonLine} h-3`} />
                <div className={`${skeletonLine} h-3`} />
              </div>
            </article>
          ))}
        </div>

        <article className="dashboard-card flex min-h-[628px] flex-col rounded-xl border border-slate-200 bg-white p-4">
          <div className={`${skeletonLine} h-4 w-40`} />
          <div className="mt-6 space-y-3">
            {Array.from({ length: 8 }).map((_, index) => (
              <div key={index} className="flex items-center gap-3">
                <div className="h-9 w-9 animate-pulse rounded-full bg-slate-200/80" />
                <div className="min-w-0 flex-1 space-y-2">
                  <div className={`${skeletonLine} h-3 w-2/3`} />
                  <div className={`${skeletonLine} h-2 w-1/2`} />
                </div>
              </div>
            ))}
          </div>
        </article>
      </div>
    </div>
  );
}

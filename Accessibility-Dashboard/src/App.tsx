import { Suspense, lazy, useCallback, useState } from "react";
import { Navigate, Route, Routes, useNavigate } from "react-router-dom";

import { clearAnalysisRecoveryStorage } from "@/services/analysis-recovery-storage";
import { clearOrganizationCreateRecoveryStorage } from "@/services/organization-create-recovery-storage";
import { clearSiteCreateRecoveryStorage } from "@/services/site-create-recovery-storage";

const DashboardShell = lazy(() => import("@/components/ui/sidebar-demo").then((module) => ({ default: module.SidebarDemo })));
const DEFAULT_USER_NAME = "ADMIN";

function AppRouteFallback() {
  return (
    <section className="fixed inset-0 z-[999] flex items-center justify-center bg-white">
      <div className="rounded-xl border border-slate-200 bg-white px-5 py-4 shadow-lg">
        <p className="text-sm font-medium text-slate-700">분석 화면을 불러오는 중...</p>
      </div>
    </section>
  );
}

function AppRoute() {
  const navigate = useNavigate();
  const [isAppBooting, setIsAppBooting] = useState(true);
  const handleBootstrapComplete = useCallback(() => {
    setIsAppBooting(false);
  }, []);
  const handleLogout = useCallback(() => {
    clearAnalysisRecoveryStorage();
    clearOrganizationCreateRecoveryStorage();
    clearSiteCreateRecoveryStorage();
    navigate("/");
  }, [navigate]);

  return (
    <>
      <Suspense fallback={<AppRouteFallback />}>
        <DashboardShell
          userName={DEFAULT_USER_NAME}
          onLogout={handleLogout}
          onBootstrapComplete={handleBootstrapComplete}
        />
      </Suspense>

      {isAppBooting && (
        <section className="fixed inset-0 z-[999] flex items-center justify-center bg-black/35 backdrop-blur-[2px]">
          <div className="rounded-xl border border-slate-200 bg-white px-5 py-4 shadow-lg">
            <p className="text-sm font-medium text-slate-700">분석 화면을 불러오는 중...</p>
          </div>
        </section>
      )}
    </>
  );
}

import { HeroDemo } from "@/components/ui/hero-demo";

function App() {
  return (
    <Routes>
      <Route path="/" element={<HeroDemo />} />
      <Route path="/analyze" element={<AppRoute />} />
      <Route path="/projects/:projectId" element={<AppRoute />} />
      <Route path="/projects/:projectId/pages/:pageId" element={<AppRoute />} />
      <Route path="/recent-pages/:pageId" element={<AppRoute />} />
      <Route path="/dashboard" element={<AppRoute />} />
      <Route path="*" element={<Navigate to="/analyze" replace />} />
    </Routes>
  );
}

export default App;

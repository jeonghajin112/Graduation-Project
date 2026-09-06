import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import { clearAnalysisRecoveryStorage } from "@/services/analysis-recovery-storage";
import { clearDashboardSessionCaches } from "@/services/dashboard-session-cache";
import { clearOrganizationCreateRecoveryStorage } from "@/services/organization-create-recovery-storage";
import { clearSiteCreateRecoveryStorage } from "@/services/site-create-recovery-storage";

import { SidebarDemo } from "./sidebar-demo";

const DEFAULT_USER_NAME = "ADMIN";

export function DashboardAppRoute() {
  const navigate = useNavigate();
  const appShellRef = useRef<HTMLDivElement>(null);
  const [isAppBooting, setIsAppBooting] = useState(true);
  const handleBootstrapComplete = useCallback(() => {
    setIsAppBooting(false);
  }, []);
  const handleLogout = useCallback(() => {
    clearDashboardSessionCaches();
    clearAnalysisRecoveryStorage();
    clearOrganizationCreateRecoveryStorage();
    clearSiteCreateRecoveryStorage();
    navigate("/");
  }, [navigate]);

  useLayoutEffect(() => {
    const appShell = appShellRef.current;
    if (!appShell) {
      return;
    }

    appShell.inert = isAppBooting;

    return () => {
      appShell.inert = false;
    };
  }, [isAppBooting]);

  return (
    <>
      <div ref={appShellRef} data-dashboard-app-shell aria-busy={isAppBooting}>
        <SidebarDemo
          userName={DEFAULT_USER_NAME}
          onLogout={handleLogout}
          onBootstrapComplete={handleBootstrapComplete}
        />
      </div>

      {isAppBooting && (
        <section
          className="fixed inset-0 z-[999] flex items-center justify-center bg-black/35 backdrop-blur-[2px]"
          data-dashboard-boot-overlay
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          <div className="rounded-xl border border-slate-200 bg-white px-5 py-4 shadow-lg">
            <p className="text-sm font-medium text-slate-700">분석 화면을 불러오는 중...</p>
          </div>
        </section>
      )}
    </>
  );
}

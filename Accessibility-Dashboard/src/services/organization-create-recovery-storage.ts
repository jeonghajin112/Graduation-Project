export const ORGANIZATION_CREATE_STORAGE_KEY =
  "accessibility-dashboard.organization-create-attempt.v1";

export function clearOrganizationCreateRecoveryStorage(): void {
  try {
    window.sessionStorage.removeItem(ORGANIZATION_CREATE_STORAGE_KEY);
  } catch {
    // Logout must remain available when storage is blocked by the browser.
  }
}

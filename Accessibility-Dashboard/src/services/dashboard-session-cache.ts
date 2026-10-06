type DashboardSessionCacheCleaner = () => void;

const sessionCacheCleaners = new Map<string, DashboardSessionCacheCleaner>();

export function registerDashboardSessionCache(
  cacheKey: string,
  cleaner: DashboardSessionCacheCleaner
): void {
  sessionCacheCleaners.set(cacheKey, cleaner);
}

export function clearDashboardSessionCaches(): void {
  for (const cleaner of sessionCacheCleaners.values()) {
    cleaner();
  }
}

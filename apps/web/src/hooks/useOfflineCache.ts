import { useEffect, useState, useCallback } from 'react';
import {
  createCacheMetadata,
  validateCacheScope,
  getCacheAge,
  isCacheStale,
  type OfflineCacheMetadata,
} from '@/lib/offlineSafety';

interface CacheEntry<T> {
  data: T;
  metadata: OfflineCacheMetadata;
}

interface UseOfflineCacheOptions {
  ttl?: number;
  scope?: 'public' | 'user' | 'session';
  maxRetries?: number;
  userId?: string;
}

interface UseOfflineCacheResult<T> {
  data: T | null;
  isStale: boolean;
  isOnline: boolean;
  cacheAge: number | null;
  error: Error | null;
  isRetrying: boolean;
  retry: () => Promise<void>;
  refetch: () => Promise<void>;
  clearCache: () => void;
}

export function useOfflineCache<T>(
  key: string,
  fetcher: () => Promise<T>,
  options?: UseOfflineCacheOptions
): UseOfflineCacheResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [metadata, setMetadata] = useState<OfflineCacheMetadata | null>(null);
  const [isStale, setIsStale] = useState(false);
  const [isOnline, setIsOnline] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [isRetrying, setIsRetrying] = useState(false);

  const ttl = options?.ttl ?? 5 * 60 * 1000; // Default 5 minutes
  const scope = options?.scope ?? 'session';
  const maxRetries = options?.maxRetries ?? 3;
  const userId = options?.userId;

  const cacheKey = `cache:${key}`;

  // Clear cache helper
  const clearCache = useCallback(() => {
    try {
      localStorage.removeItem(cacheKey);
      setData(null);
      setMetadata(null);
      setIsStale(false);
    } catch (err) {
      console.warn('Failed to clear cache', err);
    }
  }, [cacheKey]);

  // Initialize from cache on mount
  useEffect(() => {
    try {
      const cached = localStorage.getItem(cacheKey);
      if (cached) {
        const entry: CacheEntry<T> = JSON.parse(cached);
        
        // Validate cache scope matches current user
        if (!validateCacheScope(entry.metadata, userId)) {
          clearCache();
          return;
        }

        const age = getCacheAge(entry.metadata);
        const stale = isCacheStale(entry.metadata, ttl);

        setData(entry.data);
        setMetadata(entry.metadata);
        setIsStale(stale);
      }
    } catch (err) {
      console.warn('Failed to read cache', err);
      clearCache();
    }
  }, [cacheKey, ttl, userId, clearCache]);

  // Monitor online/offline and clear cache on user change
  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    setIsOnline(navigator.onLine);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  // Clear cache when user changes
  useEffect(() => {
    if (metadata && !validateCacheScope(metadata, userId)) {
      clearCache();
    }
  }, [metadata, userId, clearCache]);

  const fetchData = useCallback(
    async (retryCount = 0): Promise<void> => {
      if (!isOnline && data) return;

      try {
        setError(null);
        const result = await fetcher();

        const newMetadata = createCacheMetadata(scope, userId);
        const entry: CacheEntry<T> = {
          data: result,
          metadata: newMetadata,
        };

        localStorage.setItem(cacheKey, JSON.stringify(entry));
        setData(result);
        setMetadata(newMetadata);
        setIsStale(false);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));

        if (retryCount < maxRetries && !isOnline) {
          const backoff = Math.pow(2, retryCount) * 1000;
          await new Promise(resolve => setTimeout(resolve, backoff));
          return fetchData(retryCount + 1);
        }

        setError(error);
      }
    },
    [isOnline, data, fetcher, scope, userId, cacheKey, maxRetries]
  );

  const retry = useCallback(async () => {
    setIsRetrying(true);
    try {
      await fetchData(0);
    } finally {
      setIsRetrying(false);
    }
  }, [fetchData]);

  const refetch = useCallback(() => fetchData(0), [fetchData]);

  const cacheAge = metadata ? getCacheAge(metadata) : null;

  return {
    data,
    isStale,
    isOnline,
    cacheAge,
    error,
    isRetrying,
    retry,
    refetch,
    clearCache,
  };
}

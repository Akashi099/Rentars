/**
 * Offline safety utilities - prevent unsafe mutations when offline.
 * Only safe read operations (search, view, filter) are allowed offline.
 * 
 * CACHEABLE DATA:
 * - Property search results (public, 5min TTL)
 * - Property details (public, 5min TTL)
 * - User preferences (user-scoped, session TTL)
 * 
 * NEVER CACHED (require online):
 * - Bookings, payments, refunds, wallet transactions
 * - Financial information and pricing
 * - Real-time availability
 */

const SAFE_OFFLINE_ACTIONS = ['search', 'view', 'read', 'filter', 'list', 'detail'];
const UNSAFE_OFFLINE_ACTIONS = ['book', 'pay', 'message', 'update', 'delete', 'create', 'refund', 'wallet', 'transaction'];

export interface OfflineCacheMetadata {
  scope: 'public' | 'user' | 'session';
  version: number;
  userId?: string;
  timestamp: number;
}

export function canPerformOfflineAction(
  action: string,
  isOnline: boolean
): boolean {
  if (isOnline) {
    return true;
  }

  const normalizedAction = action.toLowerCase();
  
  // Block all unsafe actions
  if (UNSAFE_OFFLINE_ACTIONS.some(unsafe => normalizedAction.includes(unsafe))) {
    return false;
  }
  
  // Allow only safe read operations
  return SAFE_OFFLINE_ACTIONS.some(safe => normalizedAction.includes(safe));
}

export function validateOnlineAction(
  action: string,
  isOnline: boolean,
  onError?: (message: string) => void
): boolean {
  if (!canPerformOfflineAction(action, isOnline)) {
    const message = `You cannot ${action} while offline. Please connect to the internet and try again.`;
    onError?.(message);
    return false;
  }

  return true;
}

export function getOfflineActionReason(action: string): string | null {
  if (UNSAFE_OFFLINE_ACTIONS.some(unsafe => action.includes(unsafe))) {
    return 'This action requires an internet connection for your security.';
  }

  return null;
}

export const OfflineActionMessages = {
  book: 'Booking requires an active internet connection.',
  pay: 'Payment transactions cannot be completed while offline.',
  refund: 'Refunds require an active internet connection.',
  wallet: 'Wallet transactions require an active internet connection.',
  transaction: 'Financial transactions cannot be completed while offline.',
  message: 'Messages cannot be sent offline.',
  update: 'Updates require an internet connection.',
  delete: 'Deletions require an internet connection.',
  create: 'This cannot be created offline.',
} as const;

/**
 * Validates if data is safe to cache based on type
 */
export function isCacheableData(dataType: string): boolean {
  const cacheableTypes = ['property-search', 'property-detail', 'user-preferences'];
  return cacheableTypes.includes(dataType);
}

/**
 * Creates cache metadata for offline storage
 */
export function createCacheMetadata(
  scope: 'public' | 'user' | 'session',
  userId?: string
): OfflineCacheMetadata {
  return {
    scope,
    version: 1,
    userId,
    timestamp: Date.now(),
  };
}

/**
 * Validates cache metadata for user scope
 */
export function validateCacheScope(
  metadata: OfflineCacheMetadata,
  currentUserId?: string
): boolean {
  // Public cache is always valid
  if (metadata.scope === 'public') {
    return true;
  }
  
  // User and session scope require matching user ID
  if (metadata.scope === 'user' || metadata.scope === 'session') {
    return metadata.userId === currentUserId;
  }
  
  return false;
}

/**
 * Calculates cache age in milliseconds
 */
export function getCacheAge(metadata: OfflineCacheMetadata): number {
  return Date.now() - metadata.timestamp;
}

/**
 * Determines if cache is stale based on TTL
 */
export function isCacheStale(metadata: OfflineCacheMetadata, ttlMs: number): boolean {
  return getCacheAge(metadata) > ttlMs;
}

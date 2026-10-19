import {
  canPerformOfflineAction,
  validateOnlineAction,
  getOfflineActionReason,
} from '@/lib/offlineSafety';

describe('Offline Safety', () => {
  describe('canPerformOfflineAction', () => {
    it('allows safe read operations offline', () => {
      expect(canPerformOfflineAction('search', false)).toBe(true);
      expect(canPerformOfflineAction('view', false)).toBe(true);
      expect(canPerformOfflineAction('read', false)).toBe(true);
      expect(canPerformOfflineAction('filter', false)).toBe(true);
      expect(canPerformOfflineAction('list', false)).toBe(true);
      expect(canPerformOfflineAction('detail', false)).toBe(true);
    });

    it('prevents unsafe mutations offline', () => {
      expect(canPerformOfflineAction('book', false)).toBe(false);
      expect(canPerformOfflineAction('pay', false)).toBe(false);
      expect(canPerformOfflineAction('message', false)).toBe(false);
      expect(canPerformOfflineAction('update', false)).toBe(false);
      expect(canPerformOfflineAction('delete', false)).toBe(false);
      expect(canPerformOfflineAction('create', false)).toBe(false);
    });

    it('allows all actions when online', () => {
      expect(canPerformOfflineAction('book', true)).toBe(true);
      expect(canPerformOfflineAction('pay', true)).toBe(true);
      expect(canPerformOfflineAction('search', true)).toBe(true);
    });

    it('handles case-insensitive action names', () => {
      expect(canPerformOfflineAction('SEARCH', false)).toBe(true);
      expect(canPerformOfflineAction('BOOK', false)).toBe(false);
      expect(canPerformOfflineAction('Search', false)).toBe(true);
    });
  });

  describe('validateOnlineAction', () => {
    it('returns true for safe offline actions', () => {
      expect(validateOnlineAction('search', false)).toBe(true);
      expect(validateOnlineAction('view', false)).toBe(true);
    });

    it('returns false for unsafe offline actions', () => {
      expect(validateOnlineAction('book', false)).toBe(false);
      expect(validateOnlineAction('pay', false)).toBe(false);
    });

    it('calls error callback when action not allowed', () => {
      const mockError = jest.fn();

      validateOnlineAction('book', false, mockError);

      expect(mockError).toHaveBeenCalledWith(
        expect.stringContaining('book')
      );
      expect(mockError).toHaveBeenCalledWith(
        expect.stringContaining('offline')
      );
    });

    it('does not call error callback for valid actions', () => {
      const mockError = jest.fn();

      validateOnlineAction('search', false, mockError);

      expect(mockError).not.toHaveBeenCalled();
    });

    it('does not call error callback when online', () => {
      const mockError = jest.fn();

      validateOnlineAction('book', true, mockError);

      expect(mockError).not.toHaveBeenCalled();
    });
  });

  describe('getOfflineActionReason', () => {
    it('returns reason for unsafe actions', () => {
      const reason = getOfflineActionReason('book');
      expect(reason).toBeTruthy();
      expect(reason).toContain('internet connection');
    });

    it('returns null for safe actions', () => {
      expect(getOfflineActionReason('search')).toBeNull();
      expect(getOfflineActionReason('view')).toBeNull();
    });
  });

  describe('Offline flow protection', () => {
    it('prevents booking completion while offline', () => {
      expect(canPerformOfflineAction('book', false)).toBe(false);
    });

    it('prevents payment processing while offline', () => {
      expect(canPerformOfflineAction('pay', false)).toBe(false);
    });

    it('prevents messaging while offline', () => {
      expect(canPerformOfflineAction('message', false)).toBe(false);
    });

    it('allows viewing cached search results while offline', () => {
      expect(canPerformOfflineAction('search', false)).toBe(true);
    });

    it('allows viewing cached property details while offline', () => {
      expect(canPerformOfflineAction('detail', false)).toBe(true);
    });

    it('allows viewing cached listings while offline', () => {
      expect(canPerformOfflineAction('list', false)).toBe(true);
    });
  });
});

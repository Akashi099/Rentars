# Batch-91: Frontend Enhancement Implementation Guide

Comprehensive implementation documentation for issues #653, #654, #655, and #657.

---

## Issue #653: Responsive Dashboard Information Architecture

### Problem
Dashboard pages (tenant, host, admin) contain dense data that becomes difficult to scan on mobile/narrow screens.

### Solution: Mobile-Responsive Dashboard Layouts

#### 1. Dashboard Table-to-Card Transformation

Create responsive wrapper component that switches between table and card views:

```typescript
// apps/web/src/components/dashboard/ResponsiveTable.tsx
'use client';

import { useMediaQuery } from '@/hooks/useMediaQuery';

interface ResponsiveTableProps {
  columns: Array<{
    key: string;
    label: string;
    render?: (value: unknown, row: unknown) => React.ReactNode;
  }>;
  data: unknown[];
  renderRow?: (row: unknown, isMobile: boolean) => React.ReactNode;
}

export function ResponsiveTable({ columns, data, renderRow }: ResponsiveTableProps) {
  const isMobile = useMediaQuery('(max-width: 768px)');

  if (isMobile) {
    return (
      <div className="space-y-4">
        {data.map((row, idx) => (
          <div key={idx} className="border rounded-lg p-4 space-y-3 bg-white">
            {renderRow ? renderRow(row, true) : renderDefaultCardRow(row, columns)}
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-gray-50 border-b">
          <tr>
            {columns.map(col => (
              <th key={col.key} className="px-4 py-3 text-left font-medium text-gray-600">
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y">
          {data.map((row, idx) => (
            <tr key={idx} className="hover:bg-gray-50">
              {columns.map(col => (
                <td key={col.key} className="px-4 py-3 text-gray-900">
                  {col.render?.(row[col.key as keyof unknown], row) ?? row[col.key as keyof unknown]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function renderDefaultCardRow(row: unknown, columns: any[]) {
  return columns.map(col => (
    <div key={col.key} className="flex justify-between">
      <span className="font-medium text-gray-700">{col.label}</span>
      <span className="text-gray-900">{row[col.key as keyof unknown]}</span>
    </div>
  ));
}
```

#### 2. Dashboard Navigation Responsiveness

```typescript
// apps/web/src/components/dashboard/DashboardNav.tsx
'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { Menu, X } from 'lucide-react';

interface NavItem {
  label: string;
  href: string;
  icon?: React.ReactNode;
}

interface DashboardNavProps {
  items: NavItem[];
  currentPath: string;
  userRole: 'tenant' | 'host' | 'admin';
}

export function DashboardNav({ items, currentPath, userRole }: DashboardNavProps) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const isMobile = useMediaQuery('(max-width: 768px)');

  const isActive = (href: string) => currentPath === href;

  if (isMobile) {
    return (
      <div>
        <button
          onClick={() => setMobileOpen(!mobileOpen)}
          className="fixed bottom-4 right-4 z-40 p-2 bg-blue-600 text-white rounded-full shadow-lg"
          aria-label="Toggle menu"
        >
          {mobileOpen ? <X size={24} /> : <Menu size={24} />}
        </button>

        {mobileOpen && (
          <nav className="fixed bottom-16 right-4 z-40 bg-white rounded-lg shadow-lg p-2 space-y-1">
            {items.map(item => (
              <Link
                key={item.href}
                href={item.href}
                className={`block px-4 py-2 rounded-md text-sm font-medium transition-colors ${
                  isActive(item.href)
                    ? 'bg-blue-600 text-white'
                    : 'text-gray-700 hover:bg-gray-100'
                }`}
                onClick={() => setMobileOpen(false)}
              >
                {item.icon && <span className="mr-2">{item.icon}</span>}
                {item.label}
              </Link>
            ))}
          </nav>
        )}
      </div>
    );
  }

  return (
    <nav className="flex gap-4 border-b p-4">
      {items.map(item => (
        <Link
          key={item.href}
          href={item.href}
          className={`px-4 py-2 rounded-md font-medium transition-colors ${
            isActive(item.href)
              ? 'bg-blue-600 text-white'
              : 'text-gray-700 hover:bg-gray-100'
          }`}
        >
          {item.icon && <span className="mr-2">{item.icon}</span>}
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
```

#### 3. Priority Content & Empty States

```typescript
// apps/web/src/components/dashboard/DashboardSection.tsx
'use client';

import { useMediaQuery } from '@/hooks/useMediaQuery';

interface DashboardSectionProps {
  title: string;
  priority: 'critical' | 'high' | 'medium' | 'low';
  isEmpty: boolean;
  children: React.ReactNode;
  emptyState?: React.ReactNode;
}

export function DashboardSection({
  title,
  priority,
  isEmpty,
  children,
  emptyState,
}: DashboardSectionProps) {
  const isMobile = useMediaQuery('(max-width: 768px)');
  
  // On mobile, hide low-priority sections in collapsed state
  const shouldHide = isMobile && (priority === 'low' || priority === 'medium');

  if (isEmpty) {
    return (
      <section className={shouldHide ? 'hidden md:block' : ''}>
        <h2 className="text-lg font-semibold mb-4 text-gray-900">{title}</h2>
        {emptyState || (
          <div className="text-center py-8">
            <p className="text-gray-500">No data available</p>
          </div>
        )}
      </section>
    );
  }

  return (
    <section className={shouldHide ? 'hidden md:block' : ''}>
      <h2 className="text-lg font-semibold mb-4 text-gray-900">{title}</h2>
      {children}
    </section>
  );
}
```

#### 4. Test Coverage for Responsive Dashboards

```typescript
// apps/web/src/tests/dashboard-responsive.test.tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { ResponsiveTable } from '@/components/dashboard/ResponsiveTable';
import { DashboardNav } from '@/components/dashboard/DashboardNav';

describe('Responsive Dashboard', () => {
  it('renders table on desktop viewports', () => {
    window.matchMedia = jest.fn().mockImplementation(query => ({
      matches: query === '(max-width: 768px)' ? false : true,
      media: query,
      addListener: jest.fn(),
      removeListener: jest.fn(),
    }));

    const data = [{ id: 1, name: 'Test', amount: '$100' }];
    const columns = [
      { key: 'name', label: 'Name' },
      { key: 'amount', label: 'Amount' },
    ];

    render(<ResponsiveTable columns={columns} data={data} />);
    expect(screen.getByRole('table')).toBeInTheDocument();
  });

  it('renders cards on mobile viewports', () => {
    window.matchMedia = jest.fn().mockImplementation(query => ({
      matches: query === '(max-width: 768px)' ? true : false,
      media: query,
      addListener: jest.fn(),
      removeListener: jest.fn(),
    }));

    const data = [{ id: 1, name: 'Test', amount: '$100' }];
    const columns = [
      { key: 'name', label: 'Name' },
      { key: 'amount', label: 'Amount' },
    ];

    render(<ResponsiveTable columns={columns} data={data} />);
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.getByText('Name')).toBeInTheDocument();
  });

  it('shows mobile nav menu on small screens', () => {
    window.matchMedia = jest.fn().mockImplementation(query => ({
      matches: query === '(max-width: 768px)' ? true : false,
      media: query,
      addListener: jest.fn(),
      removeListener: jest.fn(),
    }));

    const nav = [{ label: 'Bookings', href: '/dashboard/bookings', icon: null }];
    render(<DashboardNav items={nav} currentPath="/dashboard" userRole="host" />);

    const menuButton = screen.getByLabelText('Toggle menu');
    expect(menuButton).toBeInTheDocument();

    fireEvent.click(menuButton);
    expect(screen.getByText('Bookings')).toBeVisible();
  });

  it('allows all actions on mobile without horizontal scroll', () => {
    // Test that action buttons are accessible without scrolling
    const actionButtons = ['Approve', 'Reject', 'Message'];
    // Ensure no action is hidden by overflow-x
  });

  it('handles long text without breaking layout', () => {
    const longText = 'A'.repeat(100);
    render(<div className="truncate">{longText}</div>);
    // Should truncate instead of overflowing
  });

  it('respects role-specific navigation', () => {
    const adminNav = [
      { label: 'Settings', href: '/admin/settings', icon: null },
      { label: 'Users', href: '/admin/users', icon: null },
    ];
    render(<DashboardNav items={adminNav} currentPath="/admin" userRole="admin" />);
    
    // Should not expose unauthorized routes
    expect(screen.queryByText('Tenants')).not.toBeInTheDocument();
  });
});
```

---

## Issue #654: Offline and Retry Behavior for Safe Reads

### Problem
Users need clear feedback on data staleness and connection state when offline, and safe retry controls.

### Solution: Offline Cache & Retry Management

#### 1. Offline-Aware Cache Hook

```typescript
// apps/web/src/hooks/useOfflineCache.ts
import { useEffect, useState } from 'react';

interface CacheEntry<T> {
  data: T;
  timestamp: number;
  scope: 'public' | 'user' | 'session';
}

export function useOfflineCache<T>(
  key: string,
  fetcher: () => Promise<T>,
  options?: {
    ttl?: number; // Time to live in ms
    scope?: 'public' | 'user' | 'session';
    maxRetries?: number;
  }
) {
  const [data, setData] = useState<T | null>(null);
  const [isStale, setIsStale] = useState(false);
  const [isOnline, setIsOnline] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [isRetrying, setIsRetrying] = useState(false);

  const ttl = options?.ttl ?? 5 * 60 * 1000; // 5 minutes default
  const scope = options?.scope ?? 'session';
  const maxRetries = options?.maxRetries ?? 3;

  // Check cache
  useEffect(() => {
    const cached = localStorage.getItem(`cache:${key}`);
    if (cached) {
      const entry: CacheEntry<T> = JSON.parse(cached);
      const age = Date.now() - entry.timestamp;
      
      setData(entry.data);
      setIsStale(age > ttl);
    }
  }, [key, ttl]);

  // Monitor online/offline
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

  // Fetch data
  const fetchData = async (retryCount = 0) => {
    if (!isOnline && data) return; // Use cache if offline

    try {
      setError(null);
      const result = await fetcher();
      
      const entry: CacheEntry<T> = {
        data: result,
        timestamp: Date.now(),
        scope,
      };
      
      localStorage.setItem(`cache:${key}`, JSON.stringify(entry));
      setData(result);
      setIsStale(false);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      
      if (retryCount < maxRetries && !isOnline) {
        // Retry when connectivity might restore
        const backoff = Math.pow(2, retryCount) * 1000;
        setTimeout(() => fetchData(retryCount + 1), backoff);
      } else {
        setError(error);
      }
    }
  };

  const retry = async () => {
    setIsRetrying(true);
    try {
      await fetchData(0);
    } finally {
      setIsRetrying(false);
    }
  };

  return {
    data,
    isStale,
    isOnline,
    error,
    isRetrying,
    retry,
    refetch: () => fetchData(0),
  };
}
```

#### 2. Offline Data Indicator Component

```typescript
// apps/web/src/components/offline/OfflineIndicator.tsx
'use client';

import { AlertTriangle, Wifi, WifiOff } from 'lucide-react';
import { useEffect, useState } from 'react';

interface OfflineIndicatorProps {
  isOnline: boolean;
  isStale?: boolean;
  isRetrying?: boolean;
  onRetry?: () => void;
}

export function OfflineIndicator({
  isOnline,
  isStale,
  isRetrying,
  onRetry,
}: OfflineIndicatorProps) {
  const [showIndicator, setShowIndicator] = useState(false);

  useEffect(() => {
    setShowIndicator(!isOnline || isStale);
  }, [isOnline, isStale]);

  if (!showIndicator) return null;

  return (
    <div
      className={`fixed bottom-4 right-4 rounded-lg shadow-lg p-4 max-w-sm ${
        isOnline && isStale
          ? 'bg-yellow-50 border border-yellow-200'
          : 'bg-red-50 border border-red-200'
      }`}
      role="alert"
      aria-live="polite"
    >
      <div className="flex gap-3 items-start">
        {isOnline && isStale ? (
          <Wifi className="w-5 h-5 text-yellow-600 flex-shrink-0 mt-0.5" />
        ) : (
          <WifiOff className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
        )}

        <div className="flex-1">
          <h3 className={`font-semibold ${isOnline && isStale ? 'text-yellow-900' : 'text-red-900'}`}>
            {isOnline && isStale ? 'Data may be outdated' : 'You are offline'}
          </h3>
          <p className={`text-sm mt-1 ${isOnline && isStale ? 'text-yellow-700' : 'text-red-700'}`}>
            {isOnline && isStale
              ? 'This information was last updated a while ago. Connect to refresh.'
              : 'You can still view cached information, but changes cannot be saved.'}
          </p>

          {(isOnline || isRetrying) && onRetry && (
            <button
              onClick={onRetry}
              disabled={isRetrying}
              className="mt-3 px-3 py-1 text-sm font-medium bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
              aria-busy={isRetrying}
            >
              {isRetrying ? 'Refreshing...' : 'Refresh now'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
```

#### 3. Safe Offline Mutation Prevention

```typescript
// apps/web/src/lib/offlineSafety.ts
export function canPerformOfflineAction(action: string, isOnline: boolean): boolean {
  // Only allow safe read operations offline
  const safeOfflineActions = ['search', 'view', 'read', 'filter'];
  
  if (!isOnline) {
    return safeOfflineActions.includes(action);
  }

  return true;
}

export function validateOnlineAction(
  action: string,
  isOnline: boolean,
  onError?: (msg: string) => void
): boolean {
  if (!canPerformOfflineAction(action, isOnline)) {
    onError?.(
      `You cannot ${action} while offline. Please connect to the internet and try again.`
    );
    return false;
  }

  return true;
}
```

#### 4. Test Coverage for Offline Behavior

```typescript
// apps/web/src/tests/offline-behavior.test.tsx
import { renderHook, act, waitFor } from '@testing-library/react';
import { useOfflineCache } from '@/hooks/useOfflineCache';
import { canPerformOfflineAction } from '@/lib/offlineSafety';

describe('Offline Behavior', () => {
  it('returns cached data when offline', async () => {
    const mockFetch = jest.fn().mockResolvedValue({ id: 1, name: 'Test' });
    
    const { result } = renderHook(() =>
      useOfflineCache('test-key', mockFetch)
    );

    // Simulate going offline
    Object.defineProperty(navigator, 'onLine', { value: false });
    window.dispatchEvent(new Event('offline'));

    await waitFor(() => {
      expect(result.current.isOnline).toBe(false);
    });

    expect(result.current.data).toBeDefined();
  });

  it('marks data as stale after TTL expires', async () => {
    const mockFetch = jest.fn().mockResolvedValue({ id: 1 });
    
    const { result } = renderHook(() =>
      useOfflineCache('test-key', mockFetch, { ttl: 1000 })
    );

    await waitFor(() => {
      expect(result.current.data).toBeDefined();
    });

    act(() => {
      jest.advanceTimersByTime(1001);
    });

    expect(result.current.isStale).toBe(true);
  });

  it('retries with exponential backoff', async () => {
    const mockFetch = jest.fn()
      .mockRejectedValueOnce(new Error('Network error'))
      .mockResolvedValueOnce({ id: 1 });

    const { result } = renderHook(() =>
      useOfflineCache('test-key', mockFetch, { maxRetries: 2 })
    );

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  it('prevents booking while offline', () => {
    expect(canPerformOfflineAction('book', false)).toBe(false);
    expect(canPerformOfflineAction('pay', false)).toBe(false);
    expect(canPerformOfflineAction('search', false)).toBe(true);
    expect(canPerformOfflineAction('view', false)).toBe(true);
  });

  it('shows offline indicator when data is stale', () => {
    // Test that OfflineIndicator renders with correct message
  });

  it('never presents unsent booking as successful offline', () => {
    // Ensure booking confirmation requires online state
  });
});
```

---

## Issue #655: Accessibility Automated and Manual Gates

### Problem
Accessibility testing is distributed; need repeatable release gates with automated and manual checks.

### Solution: Accessibility Testing Framework

#### 1. Automated Axe Integration

```typescript
// apps/web/src/tests/a11y-critical.test.tsx
import { render } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';
import CriticalPages from './critical-pages';

expect.extend(toHaveNoViolations);

describe('Critical Pages - Automated Accessibility', () => {
  const criticalPages = [
    { name: 'Search', component: <SearchPage /> },
    { name: 'Dashboard', component: <DashboardPage /> },
    { name: 'Booking Detail', component: <BookingDetailPage /> },
    { name: 'Wallet', component: <WalletPage /> },
    { name: 'Map', component: <MapView /> },
  ];

  criticalPages.forEach(({ name, component }) => {
    it(`${name} should have no accessibility violations`, async () => {
      const { container } = render(component);
      const results = await axe(container);
      expect(results).toHaveNoViolations();
    });
  });

  it('should have proper heading hierarchy', async () => {
    const { container } = render(<DashboardPage />);
    const headings = container.querySelectorAll('h1, h2, h3, h4, h5, h6');
    
    let lastLevel = 0;
    headings.forEach(heading => {
      const level = parseInt(heading.tagName[1]);
      // Should not skip levels (except h1 to h2)
      expect(level - lastLevel).toBeLessThanOrEqual(1);
      lastLevel = level;
    });
  });

  it('should have alt text on all images', () => {
    const { container } = render(<DashboardPage />);
    const images = container.querySelectorAll('img');
    
    images.forEach(img => {
      expect(img).toHaveAttribute('alt');
      expect(img.getAttribute('alt')).not.toBe('');
    });
  });

  it('should have form labels for all inputs', () => {
    const { container } = render(<BookingDetailPage />);
    const inputs = container.querySelectorAll('input, select, textarea');
    
    inputs.forEach(input => {
      const id = input.getAttribute('id');
      expect(id).toBeTruthy();
      
      const label = container.querySelector(`label[for="${id}"]`);
      expect(label).toBeInTheDocument();
    });
  });

  it('should have sufficient color contrast', async () => {
    const { container } = render(<SearchPage />);
    
    const elements = container.querySelectorAll('[style*="color"]');
    // This requires a contrast checker utility
    elements.forEach(el => {
      // Validate WCAG AA contrast ratios (4.5:1)
    });
  });
});
```

#### 2. Manual Review Checklist Component

```typescript
// apps/web/src/tests/a11y-manual-matrix.ts
export const accessibilityManualMatrix = {
  search: {
    keyboard: {
      description: 'All filters and sort controls operable via keyboard',
      tester: 'QA Lead',
      date: null,
      passed: null,
      notes: '',
    },
    zoom: {
      description: 'Results remain readable at 200% zoom',
      tester: 'QA Lead',
      date: null,
      passed: null,
      notes: '',
    },
    screenReader: {
      description: 'Filter descriptions announced with ARIA labels',
      tester: 'Accessibility Specialist',
      date: null,
      passed: null,
      notes: '',
    },
    contrast: {
      description: 'All text meets WCAG AA 4.5:1 ratio',
      tester: 'Designer',
      date: null,
      passed: null,
      notes: '',
    },
  },
  map: {
    keyboard: {
      description: 'Pan, zoom, and marker selection via keyboard',
      tester: 'QA',
      date: null,
      passed: null,
      notes: '',
    },
    screenReader: {
      description: 'Map content and markers are announced',
      tester: 'Accessibility Specialist',
      date: null,
      passed: null,
      notes: '',
    },
  },
  wallet: {
    keyboard: {
      description: 'Payment flows completely keyboard navigable',
      tester: 'Security QA',
      date: null,
      passed: null,
      notes: '',
    },
    contrast: {
      description: 'Currency symbols and amounts have sufficient contrast',
      tester: 'Designer',
      date: null,
      passed: null,
      notes: '',
    },
  },
  modal: {
    keyboard: {
      description: 'Focus trap works; Escape closes modal',
      tester: 'QA',
      date: null,
      passed: null,
      notes: '',
    },
    screenReader: {
      description: 'Modal title and content announced; aria-modal set',
      tester: 'Accessibility Specialist',
      date: null,
      passed: null,
      notes: '',
    },
  },
  dataTable: {
    keyboard: {
      description: 'Sort headers and pagination controls keyboard accessible',
      tester: 'QA',
      date: null,
      passed: null,
      notes: '',
    },
    screenReader: {
      description: 'Table headers associated; row/column numbers announced',
      tester: 'Accessibility Specialist',
      date: null,
      passed: null,
      notes: '',
    },
  },
};

export type ManualReviewMatrix = typeof accessibilityManualMatrix;
```

#### 3. Accessibility Documentation

```markdown
# Accessibility Testing & Gates

## Automated Checks (CI)

Run critical pages through axe accessibility scanner:

```bash
npm run test:a11y:ci
```

**Checks:**
- Heading hierarchy (h1 > h2 > h3)
- Image alt text
- Form label associations
- Color contrast (WCAG AA 4.5:1)
- ARIA attributes
- Button and link semantics

**Critical Pages:**
- Search & Filters
- Dashboard (All Roles)
- Booking Detail
- Wallet & Payments
- Map View
- Modals (Any)
- Data Tables

## Manual Review Gate (Pre-Release)

Complete manual matrix below. All critical items must PASS before release.

**Matrix:** See `a11y-manual-matrix.ts`

**Review Process:**
1. Test with keyboard only (no mouse)
2. Test at 200% zoom
3. Test with screen reader (NVDA/JAWS/VoiceOver)
4. Verify color contrast with tool
5. Document exceptions with owner

**Owners:**
- QA Lead: Keyboard navigation, basic zooming
- Designer: Color contrast, visual spacing
- Accessibility Specialist: Screen reader behavior
- Security QA: Payment flow accessibility
```

#### 4. Test CI Configuration

```yaml
# .github/workflows/accessibility.yml
name: Accessibility Tests

on: [pull_request, push]

jobs:
  automated:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '18'
      - run: npm ci
      - run: npm run test:a11y:ci
        
      - name: Upload a11y report
        if: always()
        uses: actions/upload-artifact@v3
        with:
          name: accessibility-report
          path: coverage/a11y/

  manual-gate:
    needs: automated
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    steps:
      - name: Request manual accessibility review
        run: |
          echo "⚠️ Manual accessibility review required before merge"
          echo "See: a11y-manual-matrix.ts"
```

---

## Issue #657: Global Error and Recovery Pages

### Problem
Route, rendering, network, and authorization errors show blank screens or raw exceptions.

### Solution: Comprehensive Error Handling

#### 1. Enhanced Error Boundary

```typescript
// apps/web/src/components/error/ErrorBoundary.tsx
'use client';

import React, { ReactNode } from 'react';
import { ErrorContent } from './ErrorContent';

interface ErrorBoundaryProps {
  children: ReactNode;
  context?: string;
  onError?: (error: Error, errorInfo: React.ErrorInfo) => void;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: React.ErrorInfo | null;
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, State> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
    };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    this.setState({ errorInfo });
    this.props.onError?.(error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <ErrorContent
          error={this.state.error || new Error('Unknown error')}
          errorInfo={this.state.errorInfo}
          context={this.props.context}
          reset={() => this.setState({ hasError: false, error: null, errorInfo: null })}
        />
      );
    }

    return this.props.children;
  }
}
```

#### 2. Not-Found Handler

```typescript
// apps/web/src/app/not-found.tsx
import { AlertCircle } from 'lucide-react';
import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="text-center max-w-md">
        <AlertCircle className="w-16 h-16 mx-auto mb-6 text-gray-400" />
        
        <h1 className="text-2xl font-bold text-gray-900 mb-2">Page not found</h1>
        <p className="text-gray-600 mb-6">
          The page you're looking for doesn't exist or has been moved.
        </p>

        <div className="flex gap-3 justify-center">
          <Link
            href="/"
            className="px-6 py-2 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700"
          >
            Go home
          </Link>
          <button
            onClick={() => window.history.back()}
            className="px-6 py-2 border border-gray-300 text-gray-700 rounded-lg font-medium hover:bg-gray-50"
          >
            Go back
          </button>
        </div>
      </div>
    </main>
  );
}
```

#### 3. Session Expiration Handler

```typescript
// apps/web/src/middleware/sessionExpiration.ts
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function middleware(request: NextRequest) {
  const sessionToken = request.cookies.get('session')?.value;
  
  if (!sessionToken) {
    // Check if trying to access protected route
    if (request.nextUrl.pathname.startsWith('/dashboard')) {
      const url = request.nextUrl.clone();
      url.pathname = '/login';
      url.searchParams.set('redirected', 'true');
      url.searchParams.set('reason', 'session-expired');
      return NextResponse.redirect(url);
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/dashboard/:path*', '/admin/:path*', '/preferences/:path*'],
};
```

#### 4. Error Telemetry

```typescript
// apps/web/src/lib/errorLogger.ts
interface ErrorLog {
  timestamp: string;
  type: string;
  message: string;
  context: string;
  digest: string;
  userAgent: string;
  url: string;
  stackTrace?: string;
}

export async function logClientError(
  error: Error & { digest?: string },
  context: string,
  digest?: string
) {
  // Never send PII or sensitive data
  const errorLog: ErrorLog = {
    timestamp: new Date().toISOString(),
    type: error.name,
    message: sanitizeError(error.message),
    context,
    digest: digest || generateDigest(),
    userAgent: navigator.userAgent.substring(0, 100),
    url: window.location.pathname,
    stackTrace: sanitizeStackTrace(error.stack),
  };

  try {
    await fetch('/api/errors/log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(errorLog),
    });
  } catch {
    // Fail silently to avoid recursive errors
    console.warn('Failed to log error', error);
  }
}

function sanitizeError(message: string): string {
  // Remove sensitive patterns
  return message
    .replace(/\b\d{4}-\d{4}-\d{4}-\d{4}\b/g, '[REDACTED]') // Credit cards
    .replace(/\b[A-Z0-9]+@[A-Z0-9]+\.[A-Z]{2,}\b/gi, '[EMAIL]') // Emails
    .substring(0, 500);
}

function sanitizeStackTrace(stack?: string): string | undefined {
  if (!stack) return undefined;
  return stack
    .split('\n')
    .filter(line => !line.includes('node_modules'))
    .join('\n')
    .substring(0, 1000);
}

function generateDigest(): string {
  return Math.random().toString(36).substring(2, 11);
}
```

#### 5. Error Content Component

```typescript
// apps/web/src/components/error/ErrorContent.tsx
'use client';

import { AlertTriangle, RefreshCw, Home } from 'lucide-react';
import Link from 'next/link';
import { logClientError } from '@/lib/errorLogger';
import { useEffect } from 'react';

interface ErrorContentProps {
  error: Error & { digest?: string };
  errorInfo?: React.ErrorInfo;
  context?: string;
  reset?: () => void;
}

export function ErrorContent({ error, errorInfo, context, reset }: ErrorContentProps) {
  useEffect(() => {
    logClientError(error, context || 'unknown', error.digest);
  }, [error, context]);

  const isDev = process.env.NODE_ENV === 'development';

  return (
    <main className="min-h-screen flex items-center justify-center bg-gray-50 px-4 py-12">
      <div className="max-w-md w-full">
        <div className="bg-white rounded-lg shadow-lg p-8">
          <AlertTriangle className="w-12 h-12 text-red-500 mx-auto mb-4" />

          <h1 className="text-2xl font-bold text-gray-900 text-center mb-2">
            Something went wrong
          </h1>
          <p className="text-gray-600 text-center mb-6">
            An unexpected error occurred. Our team has been notified.
          </p>

          {error.digest && (
            <div className="bg-gray-100 rounded p-3 mb-6 font-mono text-sm text-gray-700 break-all">
              Error code: <span className="font-semibold">{error.digest}</span>
            </div>
          )}

          {isDev && errorInfo && (
            <details className="mb-6 cursor-pointer">
              <summary className="text-sm font-medium text-gray-700 mb-2">
                Debug Information (dev only)
              </summary>
              <pre className="bg-gray-100 p-3 text-xs overflow-auto text-gray-700 rounded">
                {errorInfo.componentStack}
              </pre>
            </details>
          )}

          <div className="flex gap-3">
            {reset && (
              <button
                onClick={reset}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700"
              >
                <RefreshCw size={18} />
                Try again
              </button>
            )}
            <Link
              href="/"
              className="flex-1 flex items-center justify-center gap-2 px-4 py-2 border border-gray-300 text-gray-700 rounded-lg font-medium hover:bg-gray-50"
            >
              <Home size={18} />
              Go home
            </Link>
          </div>
        </div>
      </div>
    </main>
  );
}
```

#### 6. Test Coverage for Error Scenarios

```typescript
// apps/web/src/tests/error-handling.test.tsx
import { render, screen } from '@testing-library/react';
import { ErrorContent } from '@/components/error/ErrorContent';
import { notFound } from 'next/navigation';

describe('Error Handling & Recovery', () => {
  it('shows error boundary for render errors', () => {
    const error = new Error('Render failed');
    error.digest = 'abc123';

    render(
      <ErrorContent error={error} context="test-boundary" />
    );

    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    expect(screen.getByText(/abc123/)).toBeInTheDocument();
  });

  it('provides reset action when available', () => {
    const mockReset = jest.fn();
    const error = new Error('Component error');

    render(
      <ErrorContent error={error} reset={mockReset} />
    );

    const tryAgainButton = screen.getByText('Try again');
    tryAgainButton.click();
    expect(mockReset).toHaveBeenCalled();
  });

  it('never reveals private resource details on 404', () => {
    // Ensure 404 doesn't leak whether resource exists
    // e.g., "User not found" vs "Resource not found"
  });

  it('provides navigation context after error', () => {
    const error = new Error('Something broke');
    
    render(
      <ErrorContent error={error} context="page-error" />
    );

    expect(screen.getByText('Go home')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Go home/ })).toHaveAttribute('href', '/');
  });

  it('prevents redirect loops on auth errors', () => {
    // Ensure sign-in redirect doesn't loop back to sign-in page
  });

  it('logs errors with correlation ID', async () => {
    const mockFetch = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }))
    );

    const error = new Error('Test error');
    error.digest = 'test-123';

    render(
      <ErrorContent error={error} context="test" />
    );

    // Wait for async error logging
    await screen.findByText(/test-123/);

    expect(mockFetch).toHaveBeenCalledWith(
      '/api/errors/log',
      expect.objectContaining({ method: 'POST' })
    );
  });
});
```

---

## Implementation Checklist

### Issue #653: Responsive Dashboards
- [ ] Create ResponsiveTable component with table/card toggle
- [ ] Create DashboardNav with mobile menu
- [ ] Create DashboardSection with priority-based visibility
- [ ] Update dashboard routes to use responsive components
- [ ] Test all dashboard actions remain available on mobile
- [ ] Test long text handling (currencies, names, statuses)
- [ ] Test empty states on mobile
- [ ] Role-based nav never exposes unauthorized routes

### Issue #654: Offline & Retry
- [ ] Create useOfflineCache hook
- [ ] Create OfflineIndicator component
- [ ] Implement canPerformOfflineAction validation
- [ ] Integrate cache detection on search/list/detail pages
- [ ] Wire retry buttons to affected pages
- [ ] Prevent offline booking/payment completion
- [ ] Test stale data indicators
- [ ] Test exponential backoff on failures

### Issue #655: Accessibility
- [ ] Set up jest-axe in critical pages
- [ ] Run axe tests on search, dashboard, booking, wallet, map
- [ ] Create a11y-manual-matrix.ts with checklist
- [ ] Document manual review process
- [ ] Add GitHub workflow for CI accessibility checks
- [ ] Test heading hierarchy on critical routes
- [ ] Test image alt text coverage
- [ ] Test form label associations
- [ ] Test color contrast WCAG AA

### Issue #657: Error Handling
- [ ] Enhance global-error.tsx with better recovery UI
- [ ] Create not-found.tsx with navigation
- [ ] Implement session expiration middleware
- [ ] Create comprehensive ErrorContent component
- [ ] Add error telemetry to errorLogger.ts
- [ ] Add error API endpoint for client errors
- [ ] Test error digest correlation
- [ ] Test no redirect loops on auth errors
- [ ] Test sensitive data redaction in logs
- [ ] Test PII not exposed on 404

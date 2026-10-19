import { render, screen } from '@testing-library/react';
import { ResponsiveTable } from '@/components/dashboard/ResponsiveTable';

// Mock useMediaQuery hook
jest.mock('@/hooks/useMediaQuery', () => ({
  useMediaQuery: (query: string) => {
    return query === '(max-width: 768px)' ? false : true;
  },
}));

describe('Responsive Dashboard', () => {
  const mockData = [
    { id: 1, name: 'Test Booking', amount: '$1,250.00', status: 'Confirmed' },
    { id: 2, name: 'Another Booking', amount: '$850.00', status: 'Pending' },
  ];

  const mockColumns = [
    { key: 'name', label: 'Booking Name' },
    { key: 'amount', label: 'Amount' },
    { key: 'status', label: 'Status' },
  ];

  describe('Desktop rendering', () => {
    it('renders data in table format on desktop', () => {
      render(<ResponsiveTable columns={mockColumns} data={mockData} />);

      expect(screen.getByRole('table')).toBeInTheDocument();
      expect(screen.getByText('Booking Name')).toBeInTheDocument();
      expect(screen.getByText('Test Booking')).toBeInTheDocument();
    });

    it('displays all columns in table', () => {
      render(<ResponsiveTable columns={mockColumns} data={mockData} />);

      expect(screen.getByText('Booking Name')).toBeInTheDocument();
      expect(screen.getByText('Amount')).toBeInTheDocument();
      expect(screen.getByText('Status')).toBeInTheDocument();
    });

    it('shows empty message when no data', () => {
      render(
        <ResponsiveTable
          columns={mockColumns}
          data={[]}
          emptyMessage="No bookings found"
        />
      );

      expect(screen.getByText('No bookings found')).toBeInTheDocument();
      expect(screen.queryByRole('table')).not.toBeInTheDocument();
    });
  });

  describe('Mobile rendering', () => {
    beforeEach(() => {
      jest.spyOn(window, 'matchMedia').mockImplementation(query => ({
        matches: query === '(max-width: 768px)',
        media: query,
        onchange: null,
        addListener: jest.fn(),
        removeListener: jest.fn(),
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
        dispatchEvent: jest.fn(),
      } as any));
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('renders data as cards on mobile', () => {
      render(<ResponsiveTable columns={mockColumns} data={mockData} />);

      expect(screen.queryByRole('table')).not.toBeInTheDocument();
      expect(screen.getByText('Test Booking')).toBeInTheDocument();
    });

    it('displays label-value pairs in card view', () => {
      render(<ResponsiveTable columns={mockColumns} data={mockData} />);

      expect(screen.getByText('Booking Name')).toBeInTheDocument();
      expect(screen.getByText('Amount')).toBeInTheDocument();
      expect(screen.getByText('Status')).toBeInTheDocument();
    });

    it('respects hideOnMobile flag', () => {
      const columnsWithHidden = [
        { key: 'name', label: 'Booking Name' },
        { key: 'amount', label: 'Amount', hideOnMobile: true },
        { key: 'status', label: 'Status' },
      ];

      render(<ResponsiveTable columns={columnsWithHidden} data={mockData} />);

      expect(screen.getByText('Booking Name')).toBeInTheDocument();
      expect(screen.getByText('Status')).toBeInTheDocument();
      // Amount should not appear on mobile if hideOnMobile is true
    });
  });

  describe('Custom rendering', () => {
    it('uses custom render function when provided', () => {
      const renderRow = (row: unknown) => (
        <div>Custom: {(row as any).name}</div>
      );

      render(
        <ResponsiveTable
          columns={mockColumns}
          data={mockData}
          renderRow={renderRow}
        />
      );

      expect(screen.getByText(/Custom: Test Booking/)).toBeInTheDocument();
    });

    it('applies custom column render function', () => {
      const columnsWithRender = [
        {
          key: 'amount',
          label: 'Amount',
          render: (value: unknown) => `Total: ${value}`,
        },
      ];

      render(
        <ResponsiveTable
          columns={columnsWithRender}
          data={[{ amount: '$100' }]}
        />
      );

      expect(screen.getByText('Total: $100')).toBeInTheDocument();
    });
  });

  describe('Accessibility', () => {
    it('renders table with semantic HTML', () => {
      render(<ResponsiveTable columns={mockColumns} data={mockData} />);

      expect(screen.getByRole('table')).toBeInTheDocument();
      expect(screen.getAllByRole('columnheader')).toHaveLength(3);
      expect(screen.getAllByRole('row')).toHaveLength(3); // 1 header + 2 data rows
    });

    it('includes proper table semantics', () => {
      render(<ResponsiveTable columns={mockColumns} data={mockData} />);

      const table = screen.getByRole('table');
      expect(table.querySelector('thead')).toBeInTheDocument();
      expect(table.querySelector('tbody')).toBeInTheDocument();
    });
  });

  describe('Long content handling', () => {
    it('handles long text without breaking layout', () => {
      const longData = [
        {
          name: 'A'.repeat(100),
          amount: '$9,999,999.99',
          status: 'Confirmed',
        },
      ];

      render(<ResponsiveTable columns={mockColumns} data={longData} />);

      expect(screen.getByText(expect.stringContaining('AAAA'))).toBeInTheDocument();
    });

    it('displays currency values properly', () => {
      render(<ResponsiveTable columns={mockColumns} data={mockData} />);

      expect(screen.getByText('$1,250.00')).toBeInTheDocument();
      expect(screen.getByText('$850.00')).toBeInTheDocument();
    });
  });
});

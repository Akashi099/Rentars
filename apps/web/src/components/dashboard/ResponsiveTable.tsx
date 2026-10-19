'use client';

import { useMediaQuery } from '@/hooks/useMediaQuery';

interface Column {
  key: string;
  label: string;
  render?: (value: unknown, row: unknown) => React.ReactNode;
  hideOnMobile?: boolean;
}

interface ResponsiveTableProps {
  columns: Column[];
  data: unknown[];
  renderRow?: (row: unknown, isMobile: boolean) => React.ReactNode;
  emptyMessage?: string;
}

function renderDefaultCardRow(row: unknown, columns: Column[]) {
  return columns
    .filter(col => !col.hideOnMobile)
    .map(col => (
      <div key={col.key} className="flex justify-between py-2">
        <span className="font-medium text-gray-700">{col.label}</span>
        <span className="text-gray-900 text-right">
          {col.render?.(row[col.key as keyof unknown], row) ?? row[col.key as keyof unknown]}
        </span>
      </div>
    ));
}

export function ResponsiveTable({
  columns,
  data,
  renderRow,
  emptyMessage = 'No data available',
}: ResponsiveTableProps) {
  const isMobile = useMediaQuery('(max-width: 768px)');

  if (data.length === 0) {
    return (
      <div className="text-center py-8 text-gray-500">
        {emptyMessage}
      </div>
    );
  }

  if (isMobile) {
    return (
      <div className="space-y-3">
        {data.map((row, idx) => (
          <div
            key={idx}
            className="border rounded-lg p-4 space-y-2 bg-white shadow-sm hover:shadow-md transition-shadow"
          >
            {renderRow
              ? renderRow(row, true)
              : renderDefaultCardRow(row, columns)}
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-gray-50 border-b border-gray-200">
          <tr>
            {columns.map(col => (
              <th
                key={col.key}
                className="px-4 py-3 text-left font-semibold text-gray-700 whitespace-nowrap"
              >
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-200">
          {data.map((row, idx) => (
            <tr key={idx} className="hover:bg-gray-50 transition-colors">
              {columns.map(col => (
                <td
                  key={col.key}
                  className="px-4 py-3 text-gray-900"
                >
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

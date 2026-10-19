import type { Meta, StoryObj } from '@storybook/react';
import { ResponsiveTable } from '@/components/dashboard/ResponsiveTable';

const meta = {
  title: 'UI/Table',
  component: ResponsiveTable,
  parameters: {
    layout: 'padded',
  },
  tags: ['autodocs'],
} satisfies Meta<typeof ResponsiveTable>;

export default meta;
type Story = StoryObj<typeof meta>;

const mockData = [
  { id: 1, name: 'Modern Apartment', status: 'Published', price: '$150', bookings: 12 },
  { id: 2, name: 'Cozy Studio', status: 'Draft', price: '$85', bookings: 0 },
  { id: 3, name: 'Luxury Villa', status: 'Published', price: '$350', bookings: 8 },
  { id: 4, name: 'Beach House', status: 'Published', price: '$275', bookings: 15 },
];

const columns = [
  { key: 'name', label: 'Property Name' },
  { key: 'status', label: 'Status' },
  { key: 'price', label: 'Price/Night' },
  { key: 'bookings', label: 'Total Bookings' },
];

export const Default: Story = {
  args: {
    columns,
    data: mockData,
  },
};

export const Empty: Story = {
  args: {
    columns,
    data: [],
    emptyMessage: 'No properties found. Add your first property to get started.',
  },
};

export const WithCustomRendering: Story = {
  args: {
    columns: [
      { key: 'name', label: 'Property Name' },
      {
        key: 'status',
        label: 'Status',
        render: (value: unknown) => {
          const status = value as string;
          const colors = {
            Published: 'bg-green-100 text-green-700',
            Draft: 'bg-yellow-100 text-yellow-700',
          };
          return (
            <span className={`px-2 py-1 rounded-full text-xs font-medium ${colors[status as keyof typeof colors]}`}>
              {status}
            </span>
          );
        },
      },
      { key: 'price', label: 'Price/Night' },
      { key: 'bookings', label: 'Total Bookings' },
    ],
    data: mockData,
  },
};

export const LongContent: Story = {
  args: {
    columns,
    data: [
      {
        id: 1,
        name: 'This is a very long property name that should truncate or wrap properly on small screens',
        status: 'Published',
        price: '$999,999',
        bookings: 9999,
      },
    ],
  },
};

export const MobileView: Story = {
  parameters: {
    viewport: {
      defaultViewport: 'mobile1',
    },
  },
  args: {
    columns,
    data: mockData,
  },
};

export const HiddenMobileColumns: Story = {
  parameters: {
    viewport: {
      defaultViewport: 'mobile1',
    },
  },
  args: {
    columns: [
      { key: 'name', label: 'Property Name' },
      { key: 'status', label: 'Status' },
      { key: 'price', label: 'Price/Night', hideOnMobile: true },
      { key: 'bookings', label: 'Total Bookings' },
    ],
    data: mockData,
  },
};

export const Loading: Story = {
  args: {
    columns,
    data: Array(5).fill(null).map((_, idx) => ({
      id: idx,
      name: '...',
      status: '...',
      price: '...',
      bookings: '...',
    })),
  },
};

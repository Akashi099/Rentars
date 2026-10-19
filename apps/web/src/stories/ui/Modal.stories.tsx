import type { Meta, StoryObj } from '@storybook/react';
import { Modal, ModalHeader, ModalContent, ModalFooter } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useState } from 'react';

const meta = {
  title: 'UI/Modal',
  component: Modal,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
} satisfies Meta<typeof Modal>;

export default meta;
type Story = StoryObj<typeof meta>;

function ModalWrapper({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(true);
  
  return (
    <>
      <Button onClick={() => setOpen(true)}>Open Modal</Button>
      <Modal open={open} onOpenChange={setOpen} title="Modal Title">
        {children}
      </Modal>
    </>
  );
}

export const Default: Story = {
  render: () => (
    <ModalWrapper>
      <ModalHeader title="Example Modal" onClose={() => {}} />
      <ModalContent>
        <p>This is a basic modal with default styling.</p>
      </ModalContent>
      <ModalFooter>
        <Button variant="outline">Cancel</Button>
        <Button>Confirm</Button>
      </ModalFooter>
    </ModalWrapper>
  ),
};

export const WithForm: Story = {
  render: () => (
    <ModalWrapper>
      <ModalHeader title="Edit Profile" onClose={() => {}} />
      <ModalContent>
        <div className="space-y-4">
          <div>
            <Label htmlFor="name">Name</Label>
            <Input id="name" placeholder="Enter your name" />
          </div>
          <div>
            <Label htmlFor="email">Email</Label>
            <Input id="email" type="email" placeholder="you@example.com" />
          </div>
        </div>
      </ModalContent>
      <ModalFooter>
        <Button variant="ghost">Cancel</Button>
        <Button>Save Changes</Button>
      </ModalFooter>
    </ModalWrapper>
  ),
};

export const Loading: Story = {
  render: () => (
    <ModalWrapper>
      <ModalHeader title="Processing" onClose={() => {}} />
      <ModalContent>
        <div className="flex items-center gap-3">
          <div className="animate-spin h-5 w-5 border-2 border-gray-300 border-t-blue-600 rounded-full" />
          <p>Please wait while we process your request...</p>
        </div>
      </ModalContent>
      <ModalFooter>
        <Button disabled>Processing...</Button>
      </ModalFooter>
    </ModalWrapper>
  ),
};

export const Error: Story = {
  render: () => (
    <ModalWrapper>
      <ModalHeader title="Error" onClose={() => {}} />
      <ModalContent>
        <div className="bg-red-50 border border-red-200 rounded-lg p-4">
          <p className="text-red-900 font-medium">Something went wrong</p>
          <p className="text-red-700 text-sm mt-1">
            Failed to save changes. Please try again.
          </p>
        </div>
      </ModalContent>
      <ModalFooter>
        <Button variant="outline">Close</Button>
        <Button>Try Again</Button>
      </ModalFooter>
    </ModalWrapper>
  ),
};

export const Confirmation: Story = {
  render: () => (
    <ModalWrapper>
      <ModalHeader title="Confirm Action" onClose={() => {}} />
      <ModalContent>
        <p>Are you sure you want to delete this item? This action cannot be undone.</p>
      </ModalContent>
      <ModalFooter>
        <Button variant="outline">Cancel</Button>
        <Button variant="destructive">Delete</Button>
      </ModalFooter>
    </ModalWrapper>
  ),
};

export const ResponsiveMobile: Story = {
  parameters: {
    viewport: {
      defaultViewport: 'mobile1',
    },
  },
  render: () => (
    <ModalWrapper>
      <ModalHeader title="Mobile Modal" onClose={() => {}} />
      <ModalContent>
        <p>This modal adapts to mobile screens with proper spacing and scrolling.</p>
      </ModalContent>
      <ModalFooter>
        <Button className="w-full">Confirm</Button>
      </ModalFooter>
    </ModalWrapper>
  ),
};

import type { Meta, StoryObj } from '@storybook/react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import { Loader2, AlertCircle, CheckCircle } from 'lucide-react';

const meta = {
  title: 'UI/Form States',
  parameters: {
    layout: 'padded',
  },
  tags: ['autodocs'],
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const NormalForm: Story = {
  render: () => (
    <form className="space-y-4 max-w-md">
      <div>
        <Label htmlFor="name">Name</Label>
        <Input id="name" placeholder="Enter your name" />
      </div>
      <div>
        <Label htmlFor="email">Email</Label>
        <Input id="email" type="email" placeholder="you@example.com" />
      </div>
      <Button type="submit">Submit</Button>
    </form>
  ),
};

export const LoadingForm: Story = {
  render: () => (
    <form className="space-y-4 max-w-md">
      <div>
        <Label htmlFor="name">Name</Label>
        <Input id="name" disabled value="John Doe" />
      </div>
      <div>
        <Label htmlFor="email">Email</Label>
        <Input id="email" type="email" disabled value="john@example.com" />
      </div>
      <Button type="submit" disabled>
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        Submitting...
      </Button>
    </form>
  ),
};

export const FormWithErrors: Story = {
  render: () => (
    <form className="space-y-4 max-w-md">
      <div>
        <Label htmlFor="name" className="text-red-600">Name *</Label>
        <Input 
          id="name" 
          placeholder="Enter your name"
          aria-invalid="true"
          aria-describedby="name-error"
          className="border-red-500 focus:ring-red-500"
        />
        <p id="name-error" className="text-red-600 text-sm mt-1">Name is required</p>
      </div>
      <div>
        <Label htmlFor="email" className="text-red-600">Email *</Label>
        <Input 
          id="email" 
          type="email" 
          placeholder="you@example.com"
          value="invalid-email"
          aria-invalid="true"
          aria-describedby="email-error"
          className="border-red-500 focus:ring-red-500"
        />
        <p id="email-error" className="text-red-600 text-sm mt-1">Please enter a valid email</p>
      </div>
      <Button type="submit">Submit</Button>
    </form>
  ),
};

export const FormWithSuccess: Story = {
  render: () => (
    <div className="space-y-4 max-w-md">
      <Alert className="border-green-500 bg-green-50">
        <CheckCircle className="h-4 w-4 text-green-600" />
        <AlertTitle className="text-green-900">Success!</AlertTitle>
        <AlertDescription className="text-green-700">
          Your information has been saved successfully.
        </AlertDescription>
      </Alert>
      <form className="space-y-4">
        <div>
          <Label htmlFor="name">Name</Label>
          <Input id="name" value="John Doe" />
        </div>
        <div>
          <Label htmlFor="email">Email</Label>
          <Input id="email" type="email" value="john@example.com" />
        </div>
        <Button type="submit">Submit</Button>
      </form>
    </div>
  ),
};

export const FormWithServerError: Story = {
  render: () => (
    <div className="space-y-4 max-w-md">
      <Alert className="border-red-500 bg-red-50">
        <AlertCircle className="h-4 w-4 text-red-600" />
        <AlertTitle className="text-red-900">Error</AlertTitle>
        <AlertDescription className="text-red-700">
          Failed to save changes. Please try again later.
        </AlertDescription>
      </Alert>
      <form className="space-y-4">
        <div>
          <Label htmlFor="name">Name</Label>
          <Input id="name" placeholder="Enter your name" />
        </div>
        <div>
          <Label htmlFor="email">Email</Label>
          <Input id="email" type="email" placeholder="you@example.com" />
        </div>
        <div className="flex gap-2">
          <Button type="button" variant="outline">Cancel</Button>
          <Button type="submit">Try Again</Button>
        </div>
      </form>
    </div>
  ),
};

export const DisabledForm: Story = {
  render: () => (
    <form className="space-y-4 max-w-md">
      <div>
        <Label htmlFor="name" className="text-gray-500">Name</Label>
        <Input id="name" disabled value="John Doe" />
      </div>
      <div>
        <Label htmlFor="email" className="text-gray-500">Email</Label>
        <Input id="email" type="email" disabled value="john@example.com" />
      </div>
      <Button type="submit" disabled>Submit</Button>
    </form>
  ),
};

export const MobileForm: Story = {
  parameters: {
    viewport: {
      defaultViewport: 'mobile1',
    },
  },
  render: () => (
    <form className="space-y-4">
      <div>
        <Label htmlFor="name">Name</Label>
        <Input id="name" placeholder="Enter your name" className="w-full" />
      </div>
      <div>
        <Label htmlFor="email">Email</Label>
        <Input id="email" type="email" placeholder="you@example.com" className="w-full" />
      </div>
      <Button type="submit" className="w-full">Submit</Button>
    </form>
  ),
};

export const RequiredFields: Story = {
  render: () => (
    <form className="space-y-4 max-w-md">
      <div>
        <Label htmlFor="name">
          Name <span className="text-red-600" aria-label="required">*</span>
        </Label>
        <Input id="name" placeholder="Enter your name" required />
      </div>
      <div>
        <Label htmlFor="email">
          Email <span className="text-red-600" aria-label="required">*</span>
        </Label>
        <Input id="email" type="email" placeholder="you@example.com" required />
      </div>
      <div>
        <Label htmlFor="phone">Phone (optional)</Label>
        <Input id="phone" type="tel" placeholder="+1 (555) 000-0000" />
      </div>
      <Button type="submit">Submit</Button>
    </form>
  ),
};

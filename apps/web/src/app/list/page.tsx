'use client';

import { RoleGuard } from '@/components/guards/RoleGuard';
import ListingForm from '@/components/properties/ListingForm';

export default function ListPage() {
  return (
    <RoleGuard requiredRoles={['host', 'admin']}>
      <main className="min-h-screen w-full overflow-x-hidden bg-gray-50 py-6 sm:py-8">
        <div className="mx-auto w-full max-w-full px-4 sm:max-w-2xl sm:px-6 lg:max-w-3xl">
          <h1 className="mb-2 text-2xl font-bold sm:text-3xl">List Your Property</h1>
          <p className="mb-6 text-gray-600 sm:mb-8">
            Get your property on Rentars and start earning with instant USDC payments.
          </p>
          <ListingForm />
        </div>
      </main>
    </RoleGuard>
  );
}
</｜｜DSML｜｜ parameter>
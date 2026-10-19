/**
 * Lazy-loaded PropertyMap component wrapper.
 * 
 * Reduces initial bundle size by code-splitting the Leaflet map library.
 * Shows a skeleton placeholder during load.
 */

'use client';

import dynamic from 'next/dynamic';

const PropertyMap = dynamic(
  () => import('@/components/features/properties/PropertyMap').then((mod) => mod.PropertyMap),
  {
    loading: () => (
      <div className="w-full h-[400px] bg-gray-100 dark:bg-gray-800 rounded-lg animate-pulse flex items-center justify-center">
        <p className="text-sm text-gray-500 dark:text-gray-400">Loading map...</p>
      </div>
    ),
    ssr: false, // Leaflet requires browser APIs
  }
);

export { PropertyMap };

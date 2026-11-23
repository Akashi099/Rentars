'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import PropertyCard from '@/components/search/PropertyCard';
import type { Property } from '@/types/property';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

type WishlistState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'success'; properties: Property[] };

export default function WishlistPage() {
  const [state, setState] = useState<WishlistState>({ status: 'loading' });
  const [reloadKey, setReloadKey] = useState(0);

  const retry = useCallback(() => {
    setState({ status: 'loading' });
    setReloadKey((key) => key + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const token = localStorage.getItem('token');
    if (!token) {
      setState({ status: 'success', properties: [] });
      return;
    }

    fetch(`${API_URL}/api/wishlists`, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => {
        if (!r.ok) {
          throw new Error(`Failed to load saved properties (${r.status})`);
        }
        return r.json();
      })
      .then((data: { properties: Property }[]) => {
        if (cancelled) return;
        setState({
          status: 'success',
          properties: data.map((item) => item.properties).filter(Boolean),
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({
          status: 'error',
          message: err instanceof Error ? err.message : 'Failed to load saved properties',
        });
      });

    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  return (
    <main className="max-w-7xl mx-auto px-4 py-8">
      <h1 className="text-3xl font-bold text-gray-900 mb-6">Saved Properties</h1>

      <div role="status" aria-live="polite" className="sr-only">
        {state.status === 'loading' && 'Loading saved properties'}
        {state.status === 'error' && 'Failed to load saved properties'}
        {state.status === 'success' &&
          (state.properties.length === 0
            ? 'No saved properties'
            : `Loaded ${state.properties.length} saved properties`)}
      </div>

      {state.status === 'loading' && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-64 rounded-lg bg-gray-100 animate-pulse" />
          ))}
        </div>
      )}

      {state.status === 'error' && (
        <div role="alert" className="text-center py-16">
          <p className="text-gray-700 mb-4">{state.message}</p>
          <button
            type="button"
            onClick={retry}
            className="px-4 py-2 rounded-md bg-blue-600 text-white font-medium hover:bg-blue-700"
          >
            Try again
          </button>
        </div>
      )}

      {state.status === 'success' && state.properties.length === 0 && (
        <div className="text-center py-16">
          <p className="text-gray-500 mb-4">You haven't saved any properties yet.</p>
          <Link href="/search" className="text-blue-600 hover:underline font-medium">
            Browse properties
          </Link>
        </div>
      )}

      {state.status === 'success' && state.properties.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
          {state.properties.map((property) => (
            <Link key={property.id} href={`/property/${property.id}`}>
              <PropertyCard property={property} />
            </Link>
          ))}
        </div>
      )}
    </main>
  );
}

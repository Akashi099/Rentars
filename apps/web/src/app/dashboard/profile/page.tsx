'use client';

import { useEffect, useState } from 'react';
import type { UserProfile } from '@/types/profile';
import ProfileManagement from '@/components/dashboard/ProfileManagement';
import PropertyManagement from '@/components/dashboard/PropertyManagement';
import PropertyCalendar from '@/components/dashboard/PropertyCalendar';

export default function ProfilePage() {
  const [showCalendar, setShowCalendar] = useState(false);
  const [selectedPropertyId, setSelectedPropertyId] = useState<string | null>(null);

  const mockProperties = [
    {
      id: '1',
      title: 'Downtown Apartment',
      location: 'New York, NY',
      pricePerNight: 120,
    },
    {
      id: '2',
      title: 'Beach House',
      location: 'Miami, FL',
      pricePerNight: 200,
    },
  ];

  // The real profile is loaded from the API so the form never shows placeholder data (#918).
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [profileState, setProfileState] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const token = localStorage.getItem('token');
        const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000'}/api/profile`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as UserProfile;
        if (!cancelled) {
          setProfile(data);
          setProfileState('ready');
        }
      } catch {
        if (!cancelled) setProfileState('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handlePropertyEdit = (property: any) => {
  };

  const handlePropertyDelete = (id: string) => {
  };

  const handlePropertyAdd = () => {
    console.log('Add property');
  };

  const handleCalendarOpen = (propertyId: string) => {
    setSelectedPropertyId(propertyId);
    setShowCalendar(true);
  };

  return (
    <main className="min-h-screen bg-gray-50 py-8">
      <div className="max-w-4xl mx-auto px-4 space-y-8">
        {/* Header */}
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Settings</h1>
          <p className="text-gray-600 mt-1">Manage your profile and properties</p>
        </div>

        {/* Profile Management */}
        {profileState === 'loading' && (
          <p role="status" className="text-sm text-gray-600">Loading your profile…</p>
        )}
        {profileState === 'error' && (
          <p role="alert" className="text-sm text-red-700">
            We could not load your profile. Refresh the page to try again.
          </p>
        )}
        {profileState === 'ready' && profile && (
          <ProfileManagement profile={profile} onUpdate={(data) => setProfile((p) => (p ? { ...p, ...data } : p))} />
        )}

        {/* Property Management */}
        <PropertyManagement
          properties={mockProperties}
          onAdd={handlePropertyAdd}
          onEdit={handlePropertyEdit}
          onDelete={handlePropertyDelete}
        />

        {/* Property Calendar */}
        {showCalendar && selectedPropertyId && (
          <PropertyCalendar
            propertyId={selectedPropertyId}
            onClose={() => setShowCalendar(false)}
          />
        )}
      </div>
    </main>
  );
}

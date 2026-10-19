'use client';

import { Calendar, MapPin, DollarSign, Clock } from 'lucide-react';

interface BookingCardProps {
  id: string;
  propertyTitle: string;
  location: string;
  checkIn: Date;
  checkOut: Date;
  totalPrice: number;
  status: 'pending' | 'confirmed' | 'completed' | 'cancelled' | 'escrow_reconcile_failed';
  escrowStatus?: 'locked' | 'released' | 'refunded' | 'pending' | 'manual_review';
  thumbnail?: string;
}

export default function BookingCard({
  id,
  propertyTitle,
  location,
  checkIn,
  checkOut,
  totalPrice,
  status,
  escrowStatus,
  thumbnail,
}: BookingCardProps) {
  const normalizedStatus = status.toLowerCase();
  const normalizedEscrowStatus = escrowStatus ?? 'pending';
  const statusColors = {
    pending: 'bg-yellow-100 text-yellow-700',
    confirmed: 'bg-blue-100 text-blue-700',
    completed: 'bg-green-100 text-green-700',
    cancelled: 'bg-red-100 text-red-700',
    escrow_reconcile_failed: 'bg-red-100 text-red-700',
  };

  const escrowColors = {
    locked: 'bg-yellow-50 text-yellow-700',
    released: 'bg-green-50 text-green-700',
    refunded: 'bg-blue-50 text-blue-700',
    pending: 'bg-yellow-50 text-yellow-700',
    manual_review: 'bg-red-50 text-red-700',
  };
  const statusLabel = normalizedStatus === 'escrow_reconcile_failed'
    ? 'Escrow review required'
    : normalizedStatus.charAt(0).toUpperCase() + normalizedStatus.slice(1);
  const escrowLabel = normalizedStatus === 'escrow_reconcile_failed'
    ? 'Manual review required'
    : normalizedEscrowStatus === 'pending'
      ? 'Verification pending'
      : normalizedEscrowStatus === 'manual_review'
        ? 'Manual review required'
        : normalizedEscrowStatus.charAt(0).toUpperCase() + normalizedEscrowStatus.slice(1);

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-100 overflow-hidden hover:shadow-md transition">
      {thumbnail && (
        <div className="h-40 bg-gray-200 overflow-hidden">
          <img
            src={thumbnail}
            alt={propertyTitle}
            className="w-full h-full object-cover"
          />
        </div>
      )}

      <div className="p-4 space-y-3">
        <div>
          <h3 className="font-semibold text-gray-900">{propertyTitle}</h3>
          <div className="flex items-center gap-1 text-sm text-gray-500 mt-1">
            <MapPin size={14} />
            {location}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2 text-sm">
          <div className="flex items-center gap-2 text-gray-600">
            <Calendar size={14} />
            <span>{checkIn.toLocaleDateString()}</span>
          </div>
          <div className="flex items-center gap-2 text-gray-600">
            <Clock size={14} />
            <span>{checkOut.toLocaleDateString()}</span>
          </div>
        </div>

        <div className="flex items-center justify-between pt-2 border-t">
          <div className="flex items-center gap-2">
            <DollarSign size={16} className="text-blue-600" />
            <span className="font-semibold text-gray-900">{totalPrice} USDC</span>
          </div>
          <span className={`text-xs px-2 py-1 rounded-full font-medium ${statusColors[normalizedStatus as keyof typeof statusColors]}`}>
            {statusLabel}
          </span>
        </div>

        <div className={`text-xs px-2 py-1 rounded-full font-medium ${escrowColors[normalizedEscrowStatus]} text-center`}>
          Escrow: {escrowLabel}
        </div>

        <a
          href={`/booking/confirmation/${id}`}
          className="block text-center text-blue-600 hover:text-blue-700 text-sm font-medium mt-2"
        >
          View Details
        </a>
      </div>
    </div>
  );
}

'use client';

import { useEffect, useState } from 'react';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

export interface EscrowStatus {
  status: 'locked' | 'released' | 'refunded' | 'pending' | 'manual_review';
  amount: number;
  releaseDate?: string;
}

export function useEscrowStatus(bookingId: string) {
  const [escrow, setEscrow] = useState<EscrowStatus | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (!bookingId) return;

    const token = localStorage.getItem('token');
    const pollInterval = setInterval(() => {
      fetch(`${API_URL}/api/bookings/${bookingId}/escrow`, {
        headers: { Authorization: `Bearer ${token}` },
      })
        .then((r) => r.json())
        .then((data) => {
          setEscrow(data);
          setIsLoading(false);
        })
        .catch(() => setIsLoading(false));
    }, 5000);

    return () => clearInterval(pollInterval);
  }, [bookingId]);

  return { escrow, isLoading };
}

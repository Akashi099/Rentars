'use client';

import { Lock, CheckCircle, RefreshCw, AlertTriangle } from 'lucide-react';

interface EscrowStatusCardProps {
  status: 'locked' | 'released' | 'refunded' | 'pending' | 'manual_review';
  amount: number;
  releaseDate?: string;
}

export default function EscrowStatusCard({
  status,
  amount,
  releaseDate,
}: EscrowStatusCardProps) {
  const statusConfig = {
    locked: {
      icon: Lock,
      label: 'Escrow Locked',
      color: 'text-yellow-600 dark:text-yellow-400',
      bgColor: 'bg-yellow-50 dark:bg-yellow-950',
    },
    released: {
      icon: CheckCircle,
      label: 'Escrow Released',
      color: 'text-green-600 dark:text-green-400',
      bgColor: 'bg-green-50 dark:bg-green-950',
    },
    refunded: {
      icon: RefreshCw,
      label: 'Refunded',
      color: 'text-blue-600 dark:text-blue-400',
      bgColor: 'bg-blue-50 dark:bg-blue-950',
    },
    pending: {
      icon: RefreshCw,
      label: 'Escrow verification pending',
      color: 'text-yellow-600 dark:text-yellow-400',
      bgColor: 'bg-yellow-50 dark:bg-yellow-950',
    },
    manual_review: {
      icon: AlertTriangle,
      label: 'Escrow requires manual review',
      color: 'text-red-600 dark:text-red-400',
      bgColor: 'bg-red-50 dark:bg-red-950',
    },
  };

  const config = statusConfig[status];
  const Icon = config.icon;

  return (
    <div className={`${config.bgColor} rounded-lg p-4 border border-gray-200 dark:border-gray-700`}>
      <div className="flex items-center gap-3 mb-2">
        <Icon className={config.color} size={20} />
        <h3 className="font-semibold text-gray-900 dark:text-white">{config.label}</h3>
      </div>
      <p className="text-2xl font-bold text-gray-900 dark:text-white mb-2">{amount} USDC</p>
      {releaseDate && (
        <p className="text-sm text-gray-600 dark:text-gray-400">
          Release date: {new Date(releaseDate).toLocaleDateString()}
        </p>
      )}
    </div>
  );
}

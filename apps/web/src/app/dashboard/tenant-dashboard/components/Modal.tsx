'use client';

import SharedModal from '@/components/ui/modal';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}

export default function Modal({
  isOpen,
  onClose,
  title,
  children,
}: ModalProps) {
  return (
    <SharedModal isOpen={isOpen} onClose={onClose} title={title}>
      {children}
    </SharedModal>
  );
}
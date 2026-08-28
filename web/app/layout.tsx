import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Oubliette - Data Erasure Control Center',
  description: 'Discover, plan, rehearse, approve, and certify a multi-system erasure.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

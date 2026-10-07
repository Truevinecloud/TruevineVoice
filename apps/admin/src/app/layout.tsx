import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { ADMIN_APP_INFO } from '../lib/app-info';
import './globals.css';

export const metadata: Metadata = {
  title: `${ADMIN_APP_INFO.product} - Admin`,
  description: `${ADMIN_APP_INFO.surface} - foundation placeholder`,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

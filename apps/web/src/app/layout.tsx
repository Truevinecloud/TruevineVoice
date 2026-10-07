import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { WEB_APP_INFO } from '../lib/app-info';
import './globals.css';

export const metadata: Metadata = {
  title: WEB_APP_INFO.product,
  description: `${WEB_APP_INFO.surface} - foundation placeholder`,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

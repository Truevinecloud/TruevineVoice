import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { WEB_APP_INFO } from '../lib/app-info';
import './globals.css';

export const metadata: Metadata = {
  title: WEB_APP_INFO.product,
  description:
    'Automated voice calls for customer engagement in Uganda — reminders, announcements and customer updates in local languages.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { ADMIN_APP_INFO } from '../lib/app-info';
import { PlatformShell } from './PlatformShell';
import './globals.css';
import './platform-shell.css';

export const metadata: Metadata = {
  title: `${ADMIN_APP_INFO.product} - Admin`,
  description: `${ADMIN_APP_INFO.surface} - operations console`,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <PlatformShell>{children}</PlatformShell>
      </body>
    </html>
  );
}

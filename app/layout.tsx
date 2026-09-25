import type { Metadata } from 'next';
import './globals.css';
import './portal.css';
import './route-nav.css';
import './factorcloud-theme.css';

export const metadata: Metadata = {
  title: 'FactorCloud Client Portal',
  description: 'Client invoice intake, status, alerts and portfolio dashboard powered by FactorCloud',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}

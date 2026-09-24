import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'FactorCloud Invoice Validator',
  description: 'External invoice intake and validation prototype for FactorCloud',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}

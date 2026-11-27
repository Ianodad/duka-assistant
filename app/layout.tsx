import type { ReactNode } from 'react';
import localFont from 'next/font/local';
import './globals.css';

// Font setup copied from the spike: bundled at build time from node_modules (SIL OFL 1.1). No remote font requests.
const bricolage = localFont({
  src: '../node_modules/@fontsource-variable/bricolage-grotesque/files/bricolage-grotesque-latin-wght-normal.woff2',
  variable: '--font-bricolage',
  weight: '200 800',
  display: 'swap',
});

export const metadata = { title: 'Duka: your corner shop' };
export const viewport = { width: 'device-width', initialScale: 1, themeColor: '#0e5a34' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={bricolage.variable}>
      <body>{children}</body>
    </html>
  );
}

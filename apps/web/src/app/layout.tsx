import type { Metadata } from 'next';
import { Fredoka, Nunito } from 'next/font/google';
import './globals.css';

/** Chunky rounded display font for headings, tags and banners. */
const fun = Fredoka({ subsets: ['latin'], weight: ['500', '600', '700'], variable: '--font-fun', display: 'swap' });
/** Friendly, very readable body font for answers and reasons. */
const body = Nunito({ subsets: ['latin'], weight: ['400', '600', '700', '800'], variable: '--font-body', display: 'swap' });

export const metadata: Metadata = {
  title: 'SusAgent',
  description: 'Social deduction between AI agents',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${fun.variable} ${body.variable}`}>
      <body>{children}</body>
    </html>
  );
}

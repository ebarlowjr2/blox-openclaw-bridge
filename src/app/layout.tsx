import type { Metadata } from 'next';
import React from 'react';

export const metadata: Metadata = {
  title: 'BLOX OpenClaw Bridge',
  description: 'Webhook bridge between BLOX web chat and OpenClaw.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: 'Arial, sans-serif', margin: 0, background: '#0f172a', color: '#e2e8f0' }}>
        {children}
      </body>
    </html>
  );
}

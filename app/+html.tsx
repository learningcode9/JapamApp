import { ScrollViewStyleReset } from 'expo-router/html';
import type { PropsWithChildren } from 'react';

export default function RootHtml({ children }: PropsWithChildren) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, viewport-fit=cover"
        />
        <meta name="theme-color" content="#05010c" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="apple-mobile-web-app-title" content="Mantra Japam" />
        <link rel="manifest" href="/manifest-v12.json?v=12" />
        <link
          rel="apple-touch-icon"
          sizes="180x180"
          type="image/png"
          href="/apple-touch-icon.png?v=12"
        />
        <link
          rel="icon"
          sizes="48x48"
          type="image/png"
          href="/favicon-48.png?v=12"
        />
        <ScrollViewStyleReset />
      </head>
      <body>{children}</body>
    </html>
  );
}

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
        <meta name="theme-color" content="#f5fafa" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="apple-mobile-web-app-title" content="Mantra Japam" />
        <link rel="manifest" href="/manifest.json" />
        <link
          rel="apple-touch-icon"
          sizes="180x180"
          type="image/png"
          href="/apple-touch-icon.png"
        />
        <link
          rel="icon"
          sizes="48x48"
          type="image/png"
          href="/favicon-48.png"
        />
        <style
          dangerouslySetInnerHTML={{
            __html: `
              #launch-screen {
                position: fixed;
                inset: 0;
                z-index: 2147483647;
                display: flex;
                align-items: center;
                justify-content: center;
                background:
                  linear-gradient(rgba(245,250,250,0.52), rgba(245,250,250,0.52)),
                  url('/icon-512.png') center 42% / 112px 112px no-repeat,
                  radial-gradient(circle at 50% 42%, rgba(15,143,135,0.18), transparent 34%),
                  linear-gradient(180deg, #edf8f5 0%, #dbeeea 58%, #f8fbf7 100%);
                opacity: 1;
                transition: opacity 420ms ease;
              }
              #launch-screen::after {
                content: 'Mantra Japam';
                position: absolute;
                top: calc(50% + 78px);
                left: 0;
                right: 0;
                text-align: center;
                color: #063B3B;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
                font-size: 16px;
                font-weight: 700;
                letter-spacing: 0.01em;
              }
              #launch-screen.is-hidden {
                opacity: 0;
                pointer-events: none;
              }
              @keyframes fadeIn {
                from { opacity: 0; transform: translateY(-4px); }
                to { opacity: 1; transform: translateY(0); }
              }
              @keyframes sheetIn {
                from { opacity: 0; transform: translateY(24px); }
                to { opacity: 1; transform: translateY(0); }
              }
            `,
          }}
        />
        <ScrollViewStyleReset />
      </head>
      <body>
        <div id="launch-screen" aria-hidden="true" />
        {children}
      </body>
    </html>
  );
}

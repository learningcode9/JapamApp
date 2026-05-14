const fs = require('fs');
const path = require('path');

const file = path.resolve(__dirname, '..', 'dist', 'index.html');

if (!fs.existsSync(file)) {
  console.log('No dist/index.html found; skipping web HTML postprocess.');
  process.exit(0);
}

let html = fs.readFileSync(file, 'utf8');

const launchStyles = `
    <style id="japam-launch-screen-style">
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
    </style>`;

const pwaTags = `
    <meta name="theme-color" content="#f5fafa">
    <meta name="apple-mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
    <meta name="apple-mobile-web-app-title" content="Mantra Japam">
    <link rel="manifest" href="/manifest.json">
    <link rel="apple-touch-icon" sizes="180x180" type="image/png" href="/apple-touch-icon.png">
    <link rel="icon" sizes="48x48" type="image/png" href="/favicon-48.png">`;

html = html
  .replace(/<meta name="theme-color"[^>]*>\s*/g, '')
  .replace(/<meta name="apple-mobile-web-app-[^>]*>\s*/g, '')
  .replace(/<link rel="manifest"[^>]*>\s*/g, '')
  .replace(/<link rel="apple-touch-icon"[^>]*>\s*/g, '')
  .replace(/<link rel="icon"[^>]*>\s*/g, '')
  .replace(/<meta name="viewport" content="[^"]*"\s*\/?>/, '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />')
  .replace('</head>', `${pwaTags}${launchStyles}\n  </head>`);

if (!html.includes('id="launch-screen"')) {
  html = html.replace('<body>', '<body>\n    <div id="launch-screen" aria-hidden="true"></div>');
}

fs.writeFileSync(file, html);
console.log('Postprocessed web HTML with PWA metadata and launch screen.');

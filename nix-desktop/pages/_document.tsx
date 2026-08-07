import { Html, Head, Main, NextScript } from 'next/document'

// Applies the persisted theme before paint (defaults to dark), matching T3 Code's boot script.
const themeScript = `(() => {
  try {
    const stored = window.localStorage.getItem('nix:theme');
    const isDark = stored !== 'light';
    document.documentElement.classList.toggle('dark', isDark);
  } catch {
    document.documentElement.classList.add('dark');
  }
})();`

export default function Document() {
  return (
    <Html lang="en" className="dark">
      <Head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </Head>
      <body>
        <Main />
        <NextScript />
      </body>
    </Html>
  )
}

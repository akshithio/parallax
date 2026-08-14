import type { AppProps } from 'next/app'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/500.css'
import '../styles/globals.css'
import 'katex/dist/katex.min.css'

export default function App({ Component, pageProps }: AppProps) {
  return <Component {...pageProps} />
}

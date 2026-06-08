import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { sentryVitePlugin } from '@sentry/vite-plugin'
import { resolve } from 'path'

const sentryToken = process.env.SENTRY_AUTH_TOKEN;
const sentryEnabled = !!sentryToken && !sentryToken.startsWith("PLACEHOLDER");

export default defineConfig({
  plugins: [
    react(),
    ...(sentryEnabled ? [sentryVitePlugin({
      org: "mixsync",
      project: "javascript-react",
      authToken: sentryToken,
      sourcemaps: { assets: "./dist/**" },
      release: { name: process.env.VERCEL_GIT_COMMIT_SHA || "dev" },
    })] : []),
  ],
  // Surfaces the deploy SHA into client code as
  // import.meta.env.VITE_SENTRY_RELEASE. Vite only exposes VITE_-prefixed
  // env vars to the client bundle, but Vercel's VERCEL_GIT_COMMIT_SHA
  // lacks the prefix — so without this define block the client-side read
  // falls through to "dev" even though the Sentry plugin above gets the
  // real SHA. Same source value, two consumers, one truth.
  define: {
    'import.meta.env.VITE_SENTRY_RELEASE': JSON.stringify(
      process.env.VERCEL_GIT_COMMIT_SHA || 'dev'
    ),
  },
  build: {
    sourcemap: true,
    rollupOptions: {
      input: {
        main:     resolve(__dirname, 'index.html'),
        library:  resolve(__dirname, 'library.html'),
        diagnose: resolve(__dirname, 'diagnose.html'),
      }
    }
  }
})

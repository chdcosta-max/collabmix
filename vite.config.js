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

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { sentryVitePlugin } from '@sentry/vite-plugin'
import { resolve } from 'path'

export default defineConfig({
  plugins: [
    react(),
    sentryVitePlugin({
      org: "mixsync",
      project: "mixsync",
      authToken: process.env.SENTRY_AUTH_TOKEN,
      disable: !process.env.SENTRY_AUTH_TOKEN,
      sourcemaps: { assets: "./dist/**" },
      release: { name: process.env.VERCEL_GIT_COMMIT_SHA || "dev" },
    }),
  ],
  build: {
    sourcemap: true,
    rollupOptions: {
      input: {
        main:    resolve(__dirname, 'index.html'),
        library: resolve(__dirname, 'library.html'),
      }
    }
  }
})

import path from 'path'
import { fileURLToPath } from 'url'
import { defineConfig } from 'vite'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
import { devtools } from '@tanstack/devtools-vite'
import tsconfigPaths from 'vite-tsconfig-paths'

import { tanstackStart } from '@tanstack/react-start/plugin/vite'

import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { cloudflare } from '@cloudflare/vite-plugin'

const config = defineConfig({
  server: {
    allowedHosts: true,
    host: true,
    cors: true,
    hmr: false,
  },
  plugins: [
    devtools(),
    cloudflare({ viteEnvironment: { name: 'ssr' } }),
    tsconfigPaths({ projects: ['./tsconfig.json'] }),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  environments: {
    client: {
      build: {
        rollupOptions: {
          output: {
            manualChunks(id) {
              // Split heavy vendor libs into their own cacheable chunks
              if (id.includes('node_modules')) {
                if (id.includes('better-auth')) return 'vendor-auth'
                if (id.includes('radix-ui') || id.includes('@radix-ui')) return 'vendor-ui'
                if (id.includes('framer-motion')) return 'vendor-motion'
                if (id.includes('date-fns')) return 'vendor-date'
                if (id.includes('qrcode')) return 'vendor-qrcode'
              }
            },
          },
        },
      },
    },
  },
})

export default config

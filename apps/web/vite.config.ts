import path from 'path'
import { fileURLToPath } from 'url'
import { defineConfig } from 'vite'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
import tsconfigPaths from 'vite-tsconfig-paths'

import { tanstackStart } from '@tanstack/react-start/plugin/vite'

import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { cloudflare } from '@cloudflare/vite-plugin'

const cloudflareWorkersShim = path.resolve(__dirname, './src/lib/cloudflare-workers-shim.ts')
const prismaClientShim = path.resolve(__dirname, './src/lib/prisma-client-shim.ts')

const config = defineConfig({
  server: {
    allowedHosts: true,
    host: true,
    cors: true,
    hmr: false,
  },
  plugins: [
    {
      name: 'cloudflare-workers-client-shim',
      enforce: 'pre' as const,
      resolveId(id: string) {
        const envName = (this as unknown as { environment?: { name?: string } }).environment?.name
        if (envName === 'client') {
          if (id === 'cloudflare:workers') return cloudflareWorkersShim
          if (id === '@prisma/adapter-d1') return prismaClientShim
          if (id.includes('generated/prisma') || id.includes('generated\\prisma')) return prismaClientShim
          if (id.match(/query_compiler_fast_bg\.wasm/)) return prismaClientShim
        }
      },
    },
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
      resolve: {
        alias: {
          'cloudflare:workers': path.resolve(__dirname, './src/lib/cloudflare-workers-shim.ts'),
        },
      },
      build: {
        rollupOptions: {
          external: [],
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

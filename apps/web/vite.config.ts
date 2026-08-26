import path from 'path'
import { fileURLToPath } from 'url'
import { networkInterfaces } from 'node:os'
import { defineConfig } from 'vite'
import { isLocalDevelopmentHost } from './src/lib/auth-origins'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
import tsconfigPaths from 'vite-tsconfig-paths'

import { tanstackStart } from '@tanstack/react-start/plugin/vite'

import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { cloudflare } from '@cloudflare/vite-plugin'

const cloudflareWorkersShim = path.resolve(__dirname, './src/lib/cloudflare-workers-shim.ts')
const prismaClientShim = path.resolve(__dirname, './src/lib/prisma-client-shim.ts')
const developmentHosts = new Set(['localhost', '127.0.0.1', '[::1]'])
for (const addresses of Object.values(networkInterfaces())) {
  for (const address of addresses ?? []) {
    if (
      address.family === 'IPv4' &&
      !address.internal &&
      isLocalDevelopmentHost(address.address)
    ) {
      developmentHosts.add(address.address)
    }
  }
}
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const developmentHostPattern = [...developmentHosts].map(escapeRegExp).join('|')
const credentialedDevOrigins = [
  /^https:\/\/(?:[a-z0-9-]+\.)*showpilot\.tech$/,
  'https://showpilot.reydisse.workers.dev',
  new RegExp(`^http:\/\/(?:${developmentHostPattern}):\\d+$`),
]

const config = defineConfig({
  server: {
    allowedHosts: true,
    host: true,
    // Expo's web target talks to this server from Metro's dev origin. Reflect
    // that origin so credentialed Better Auth requests are valid in local QA.
    cors: {
      origin: credentialedDevOrigins,
      credentials: true,
    },
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
      // 'cloudflare:workers' is shimmed for the client by the
      // cloudflare-workers-client-shim plugin above (per-environment
      // resolve.alias is not a supported Vite option).
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

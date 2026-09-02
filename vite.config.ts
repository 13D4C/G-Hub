import tailwindcss from '@tailwindcss/vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import react from '@vitejs/plugin-react'
import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  resolve: { tsconfigPaths: true },
  plugins: [
    tailwindcss(),
    // tanstackStart() registers Vite's `ssr` environment and must come before
    // both nitro() (which consumes it) and react().
    tanstackStart(),
    nitro({ plugins: ['./src/server/plugins/db.ts'] }),
    react(),
  ],
})

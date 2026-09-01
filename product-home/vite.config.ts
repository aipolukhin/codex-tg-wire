import react from '@vitejs/plugin-react-swc'
import { defineConfig } from 'vite'
import tsconfigPaths from 'vite-tsconfig-paths'

export default defineConfig({
  base: '/',
  build: {
    target: 'es2020',
  },
  plugins: [react(), tsconfigPaths()],
})

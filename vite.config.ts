import { defineConfig } from 'vite'

// GitHub Pages serves a project site from /<repo>/, so built assets must be
// requested from that prefix. Without this the deployed page is a blank screen
// with 404s on every bundle. The dev server keeps '/'.
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/WorldCreator/' : '/',
  build: {
    target: 'es2022',
  },
  worker: {
    format: 'es',
  },
}))

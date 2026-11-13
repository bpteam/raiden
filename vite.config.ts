import { defineConfig } from 'vite';
export default defineConfig({ base: './', worker: { format: 'es' }, optimizeDeps: { exclude: ['manifold-3d'] }, build: { target: 'es2022' } });

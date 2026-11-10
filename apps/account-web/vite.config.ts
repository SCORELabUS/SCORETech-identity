import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
export default defineConfig({base:process.env.IDENTITY_BASE_PATH ? process.env.IDENTITY_BASE_PATH+'/account/' : '/identity/account/',plugins:[react(),tailwindcss()],build:{target:'es2022'}});

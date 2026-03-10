import { defineConfig } from 'vite';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export default defineConfig({
  root: __dirname, 
  build: {
    outDir: 'dist',
    rollupOptions: {
      // 1. INPUT: Define all entry points here
      input: {
        // The UI (HTML acts as the entry, bringing its scripts with it)
        popup: resolve(__dirname, 'src/popup/popup.html'),
        offscreen: resolve(__dirname, 'src/offscreen/offscreen.html'),
        // The Background Worker (Direct TS file)
        background: resolve(__dirname, 'src/background/index.ts'),
        content: resolve(__dirname, 'src/content/index.ts'),
      },
      
      // 2. OUTPUT: Control how files are named in /dist
      output: {
        // This ensures the background script is named 'src/background/index.js'
        // matching the [name] key from the input object above.
        entryFileNames: 'src/[name]/index.js',
        
        // Helper files (shared code)
        chunkFileNames: 'assets/[name].js',
        
        // Images/CSS
        assetFileNames: 'assets/[name].[ext]',
      }
    },
    emptyOutDir: true
  }
});

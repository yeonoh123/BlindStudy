import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import path from 'path';
import {defineConfig} from 'vite';

const pdfjsRootDir = path.resolve(__dirname, 'node_modules/pdfjs-dist');
const pdfWorkerSourcePath = path.join(pdfjsRootDir, 'build/pdf.worker.min.mjs');
const pdfCmapsDir = path.join(pdfjsRootDir, 'cmaps');
const pdfStandardFontsDir = path.join(pdfjsRootDir, 'standard_fonts');

function serveStaticDir(
  mountPath: string,
  baseDir: string,
  contentTypeForExt: (ext: string) => string
) {
  return (req: {url?: string}, res: {statusCode: number; setHeader: (k: string, v: string) => void; end: () => void}, next: () => void) => {
    const reqPath = (req.url || '').split('?')[0].replace(/^\/+/, '');
    if (!reqPath || reqPath.includes('..')) {
      next();
      return;
    }
    const resolved = path.resolve(baseDir, reqPath);
    if (!resolved.startsWith(baseDir + path.sep) || !fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) {
      next();
      return;
    }
    res.setHeader('Content-Type', contentTypeForExt(path.extname(resolved)));
    res.setHeader('Cache-Control', 'public, max-age=3600');
    fs.createReadStream(resolved).pipe(res as unknown as NodeJS.WritableStream);
  };
}

export default defineConfig(() => {
  return {
    plugins: [
      react(),
      tailwindcss(),
      // Serves pdfjs-dist worker & Korean CMap/standard font assets cleanly at root paths
      // without /node_modules/ or ?import transforms, and copies them to dist/ for production.
      {
        name: 'serve-pdfjs-assets',
        configureServer(server) {
          server.middlewares.use('/pdf.worker.min.mjs', (_req, res, next) => {
            if (!fs.existsSync(pdfWorkerSourcePath)) {
              next();
              return;
            }
            res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
            res.setHeader('Cache-Control', 'public, max-age=3600');
            fs.createReadStream(pdfWorkerSourcePath).pipe(res);
          });
          server.middlewares.use(
            '/pdfjs/cmaps',
            serveStaticDir('/pdfjs/cmaps', pdfCmapsDir, (ext) =>
              ext === '.bcmap' ? 'application/octet-stream' : 'text/plain; charset=utf-8'
            )
          );
          server.middlewares.use(
            '/pdfjs/standard_fonts',
            serveStaticDir('/pdfjs/standard_fonts', pdfStandardFontsDir, (ext) =>
              ext === '.pfb' || ext === '.ttf' ? 'application/octet-stream' : 'text/plain; charset=utf-8'
            )
          );
        },
        closeBundle(error?: Error): void {
          if (error) {
            return;
          }
          const distDir = path.resolve(__dirname, 'dist');
          if (!fs.existsSync(distDir)) return;
          if (fs.existsSync(pdfWorkerSourcePath)) {
            fs.copyFileSync(
              pdfWorkerSourcePath,
              path.resolve(distDir, 'pdf.worker.min.mjs')
            );
          }
          if (fs.existsSync(pdfCmapsDir)) {
            fs.cpSync(pdfCmapsDir, path.resolve(distDir, 'pdfjs/cmaps'), {
              recursive: true,
              force: true,
            });
          }
          if (fs.existsSync(pdfStandardFontsDir)) {
            fs.cpSync(
              pdfStandardFontsDir,
              path.resolve(distDir, 'pdfjs/standard_fonts'),
              {recursive: true, force: true}
            );
          }
        },
      },
      // Copies src/assets into dist/ so root-relative URLs like
      // "/src/assets/images/..." (e.g. generate_image output) still resolve
      // in production builds. Do not remove.
      {
        name: 'copy-unbundled-src-assets',
        apply: 'build',
        closeBundle(error?: Error): void {
          if (error) {
            return;
          }
          const distDir = path.resolve(__dirname, 'dist');
          const srcAssets = path.resolve(__dirname, 'src/assets');
          const distAssets = path.resolve(distDir, 'src/assets');
          if (fs.existsSync(distDir) && fs.existsSync(srcAssets)) {
            fs.cpSync(srcAssets, distAssets, {recursive: true, force: true});
          }
        },
      },
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});

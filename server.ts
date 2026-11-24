import 'dotenv/config';
import express from 'express';
import type { Request, Response } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { createApiApp } from './server/createApiApp.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = createApiApp();

  // Vite dev middleware or static dist
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: false,
      },
      appType: 'spa',
    });
    // Prevent Vite 8 @vite/client from opening a failing ws://...:24678 WebSocket when HMR is disabled
    app.get('/@vite/client', async (_req: Request, res: Response, next: express.NextFunction) => {
      try {
        const result = await vite.transformRequest('/@vite/client');
        if (!result?.code) {
          next();
          return;
        }
        const patched = result.code.replace(
          /transport\.connect\(createHMRHandler\(handleMessage\)\);?/g,
          '/* HMR WebSocket disabled in middlewareMode */'
        );
        res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        res.send(patched);
      } catch (err) {
        next(err);
      }
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const PORT = Number(process.env.PORT) || 3000;
  const httpServer = app.listen(PORT, '0.0.0.0', () => {
    console.log(`BlindStudy server running on http://0.0.0.0:${PORT}`);
  });
  httpServer.keepAliveTimeout = 65000;
  httpServer.headersTimeout = 66000;
  httpServer.requestTimeout = 120000;
}

startServer().catch((err) => {
  console.error('Failed to start BlindStudy server:', err);
  process.exit(1);
});

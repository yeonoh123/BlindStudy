import type { IncomingMessage, ServerResponse } from 'http';
import type { Request, Response } from 'express';
import { createApiApp } from '../server/createApiApp.ts';

const apiApp = createApiApp();

export default function handler(req: IncomingMessage, res: ServerResponse) {
  return apiApp(req as unknown as Request, res as unknown as Response);
}

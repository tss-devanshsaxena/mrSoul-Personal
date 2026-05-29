import { Router } from 'express';

/** Legacy entry — admin portal lives under /admin */
export const storeOutreachRouter = Router();

storeOutreachRouter.get('/dashboard/store-owners', (_req, res) => {
  res.redirect(302, '/admin/stores.html');
});

storeOutreachRouter.get(/^\/store-outreach\.html$/, (_req, res) => {
  res.redirect(302, '/admin/');
});

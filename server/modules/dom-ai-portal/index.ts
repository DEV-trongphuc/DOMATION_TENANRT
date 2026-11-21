import {
  domAiPortalRouter,
  publicDomAiPortalRouter,
  signPortalViewerToken,
  verifyPortalViewerToken,
} from './routes.ts';
import {
  DOM_AI_PORTAL_TABLES,
  runDomAiPortalSchema,
  ensureDomAiPortalSchema,
} from './schema.ts';

export const router = domAiPortalRouter;
export {
  domAiPortalRouter,
  publicDomAiPortalRouter,
  signPortalViewerToken,
  verifyPortalViewerToken,
  DOM_AI_PORTAL_TABLES,
  runDomAiPortalSchema,
  ensureDomAiPortalSchema,
};
export * from './schema.ts';
export * from './rag.service.ts';
export default domAiPortalRouter;

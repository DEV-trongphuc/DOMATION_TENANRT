import { audiencesRouter } from './audiences.routes.ts';
import { registerAudienceEventListeners } from './audiences.service.ts';

registerAudienceEventListeners();

export const router = audiencesRouter;
export { audiencesRouter };
export * from './audiences.service.ts';
export * from './segment-compiler.ts';

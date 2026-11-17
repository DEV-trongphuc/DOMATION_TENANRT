import { domAgentRouter } from './dom-agent.routes.ts';
import { ensureDomAgentSchema, DOM_AGENT_TABLES } from './schema.ts';

export const router = domAgentRouter;
export { domAgentRouter, ensureDomAgentSchema, DOM_AGENT_TABLES };
export * from './tools-registry.ts';
export * from './rag.service.ts';
export * from './orchestrator.service.ts';
export default domAgentRouter;

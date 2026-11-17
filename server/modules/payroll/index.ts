import { payrollRouter } from './payroll.routes.ts';

export const router = payrollRouter;
export { payrollRouter };
export * from './payroll-engine.ts';
export default payrollRouter;

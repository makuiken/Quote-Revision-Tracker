import { Router, type IRouter } from "express";
import healthRouter from "./health";
import publicRouter from "./public";
import quotesRouter from "./quotes";
import adminRouter from "./admin";
import storageRouter from "./storage";
import packetsRouter from "./packets";
import templateAdminRouter from "./templateAdmin";

const router: IRouter = Router();

router.use(healthRouter);
router.use(publicRouter);
router.use(adminRouter);
router.use(templateAdminRouter);
router.use(packetsRouter);
router.use(quotesRouter);
router.use(storageRouter);

export default router;

import { Router, type IRouter } from "express";
import healthRouter from "./health";
import publicRouter from "./public";
import quotesRouter from "./quotes";

const router: IRouter = Router();

router.use(healthRouter);
router.use(publicRouter);
router.use(quotesRouter);

export default router;

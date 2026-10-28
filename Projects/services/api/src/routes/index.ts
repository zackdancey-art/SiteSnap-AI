import { Router } from "express";
import { asyncSafeRouter } from "../middleware/asyncRouter";
import authRouter from "./auth";
import { aiRouter } from "./ai";
import { uploadsRouter } from "./uploads";
import { healthRouter } from "./health";
import { projectsRouter } from "./projects";
import { pushRouter } from "./push";
import { crewRouter } from "./crew";
import { incidentsRouter } from "./incidents";
import { inspectionsRouter } from "./inspections";
import { deliveriesRouter } from "./deliveries";
import { templatesRouter } from "./templates";
import { locationRouter } from "./location";
import { companyRouter } from "./company";
import { clientsRouter } from "./clients";

const apiRouter: Router = asyncSafeRouter();

apiRouter.use(authRouter);
apiRouter.use(aiRouter);
apiRouter.use(uploadsRouter);
apiRouter.use(healthRouter);
apiRouter.use(projectsRouter);
apiRouter.use(pushRouter);
apiRouter.use(crewRouter);
apiRouter.use(incidentsRouter);
apiRouter.use(inspectionsRouter);
apiRouter.use(deliveriesRouter);
apiRouter.use(templatesRouter);
apiRouter.use(locationRouter);
apiRouter.use(companyRouter);
apiRouter.use(clientsRouter);

export { apiRouter };

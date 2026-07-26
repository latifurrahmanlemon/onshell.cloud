import type { FastifyInstance } from "fastify";
import type { RuntimeConfig } from "@onshell/config";
import { registerAdminRoutes } from "./modules/admin.js";
import { registerAiRoutes } from "./modules/ai.js";
import { registerAuditRoutes } from "./modules/audit.js";
import { registerAuthRoutes } from "./modules/auth.js";
import { registerBillingRoutes } from "./modules/billing.js";
import { registerCredentialRoutes } from "./modules/credentials.js";
import { registerGrowthRoutes } from "./modules/growth.js";
import { registerHealthRoutes } from "./modules/health.js";
import { registerHostRoutes } from "./modules/hosts.js";
import { registerHostTransferRoutes } from "./modules/host-transfer.js";
import { registerLogRoutes } from "./modules/logs.js";
import { registerOrganizationRoutes } from "./modules/organizations.js";
import { registerProfileRoutes } from "./modules/profile.js";
import { registerPublicRoutes } from "./modules/public.js";
import { registerSessionRoutes } from "./modules/sessions.js";
import { registerSnippetRoutes } from "./modules/snippets.js";

export async function registerRoutes(app: FastifyInstance, config: RuntimeConfig) {
  await registerHealthRoutes(app, config);
  await registerPublicRoutes(app, config);
  await registerBillingRoutes(app, config);
  await registerAuthRoutes(app, config);
  await registerProfileRoutes(app, config);
  await registerOrganizationRoutes(app);
  await registerHostRoutes(app);
  await registerHostTransferRoutes(app);
  await registerCredentialRoutes(app);
  await registerSessionRoutes(app, config);
  await registerSnippetRoutes(app);
  await registerAiRoutes(app, config);
  await registerGrowthRoutes(app, config);
  await registerAuditRoutes(app);
  await registerLogRoutes(app, config);
  await registerAdminRoutes(app, config);
}

import type { FastifyInstance } from "fastify";
import type { RuntimeConfig } from "@onshell/config";
import { registerAdminRoutes } from "./modules/admin.js";
import { registerAuditRoutes } from "./modules/audit.js";
import { registerAuthRoutes } from "./modules/auth.js";
import { registerBillingRoutes } from "./modules/billing.js";
import { registerCredentialRoutes } from "./modules/credentials.js";
import { registerHealthRoutes } from "./modules/health.js";
import { registerHostRoutes } from "./modules/hosts.js";
import { registerOrganizationRoutes } from "./modules/organizations.js";
import { registerSessionRoutes } from "./modules/sessions.js";
import { registerSnippetRoutes } from "./modules/snippets.js";

export async function registerRoutes(app: FastifyInstance, config: RuntimeConfig) {
  await registerHealthRoutes(app, config);
  await registerBillingRoutes(app, config);
  await registerAuthRoutes(app, config);
  await registerOrganizationRoutes(app);
  await registerHostRoutes(app);
  await registerCredentialRoutes(app);
  await registerSessionRoutes(app, config);
  await registerSnippetRoutes(app);
  await registerAuditRoutes(app);
  await registerAdminRoutes(app, config);
}

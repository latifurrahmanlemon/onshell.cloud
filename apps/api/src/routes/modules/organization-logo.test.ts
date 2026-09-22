import Fastify from 'fastify';
import { z } from 'zod';
import { expect, it, vi } from 'vitest';
import type { RuntimeConfig } from '@onshell/config';
const mocks = vi.hoisted(() => ({ update: vi.fn(), audit: vi.fn() }));
vi.mock('../../lib/prisma.js', () => ({ prisma: { organization: { update: mocks.update } } }));
vi.mock('../../lib/current-user.js', () => ({ getAuthenticatedUser: async (request: { headers: Record<string,string> }) => request.headers['x-role'] ? { id: 'user', organizationId: 'org-a', role: request.headers['x-role'] } : null }));
vi.mock('./auth.js', () => ({ createAudit: mocks.audit, emailField: z.string(), issueTokens: vi.fn() }));
import { registerOrganizationRoutes } from './organizations.js';
it('protects organization logo updates and scopes writes to the authenticated workspace', async () => {
 const app = Fastify(); mocks.update.mockResolvedValue({id:'org-a',name:'Team',slug:'team',logoUrl:null,createdAt:new Date()});
 try {
  await registerOrganizationRoutes(app, {} as RuntimeConfig);
  for (const [role,status] of [[undefined,401],['developer',403],['auditor',403]] as const) {
   const response = await app.inject({method:'PATCH',url:'/organizations/current',headers:role?{'x-role':role}:{},payload:{logoUrl:null}});expect(response.statusCode).toBe(status);
  }
  expect(mocks.update).not.toHaveBeenCalled();
  expect((await app.inject({method:'PATCH',url:'/organizations/current',headers:{'x-role':'owner'},payload:{logoUrl:'https://example.com/logo.svg'}})).statusCode).toBe(400);
  const response=await app.inject({method:'PATCH',url:'/organizations/current',headers:{'x-role':'admin'},payload:{logoUrl:null,organizationId:'org-b'}});
  expect(response.statusCode).toBe(200);expect(mocks.update).toHaveBeenCalledWith({where:{id:'org-a'},data:{logoUrl:null}});expect(response.json().organization.logoUrl).toBeNull();
 } finally {await app.close()}
},15000);

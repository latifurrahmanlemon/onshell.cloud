import { randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { RuntimeConfig } from "@onshell/config";
import { normalizeSlug, validatePassword } from "@onshell/shared";
import type { User as PublicUser } from "@onshell/shared";
import prismaPkg, { type AuthEventMethod, type AuthEventType, type Prisma } from "@prisma/client";
const { AuthProvider, Role } = prismaPkg;
import bcrypt from "bcryptjs";
import { generateSecret, generateURI, verify } from "otplib";
import QRCode from "qrcode";
import { z } from "zod";
import { resolveActiveMembership } from "../../lib/active-organization.js";
import { getAuthenticatedSession, getAuthenticatedUser } from "../../lib/current-user.js";
import { sendTransactionalEmail, isSmtpEnabled } from "../../lib/email.js";
import { passwordResetEmail, signInCodeEmail, twoFactorChangeCodeEmail } from "../../lib/email-template.js";
import { encryptSecret, decryptSecret } from "../../lib/encryption.js";
import { clearLoginFailures, getLoginLock, recordLoginFailure } from "../../lib/login-throttle.js";
import { prisma } from "../../lib/prisma.js";
import { isRefreshTokenUsable } from "../../lib/refresh-token-policy.js";
import { revokeRefreshTokens } from "../../lib/refresh-tokens.js";
import {
  membershipOrder,
  roleFromPrisma,
  toPublicUser,
  type UserWithMembership
} from "../../lib/prisma-mappers.js";
import {
  ensureFreeSubscription,
  ensureLocalHost,
  generateReferralCode,
  resolveReferrer
} from "../../lib/provisioning.js";
import { handleRouteError } from "../../lib/reply.js";
import { store } from "../../lib/store.js";
import { resolveSessionCookie } from "../../lib/session-cookie.js";
import { ACCESS_TOKEN_TTL_SECONDS, createRefreshToken, hashToken, signAccessToken } from "../../lib/token.js";
import {
  readTurnstileToken,
  turnstileFailureResponse,
  verifyTurnstile,
  type TurnstileForm
} from "../../lib/turnstile.js";

const EMAIL_OTP_TTL_MS = 10 * 60 * 1000;
const PASSWORD_RESET_TTL_MS = 15 * 60 * 1000;
const CHALLENGE_RESEND_INTERVAL_MS = 30 * 1000;
const MAX_CHALLENGE_ATTEMPTS = 5;

/** Rate limits for the endpoints an attacker would hammer. */
const authRateLimit = (max: number, timeWindow = "1 minute") => ({
  config: { rateLimit: { max, timeWindow } }
});

/**
 * Emails are compared case-insensitively everywhere else, so normalise on the
 * way in. Without this, `Ada@x.com` and `ada@x.com` become two accounts and the
 * unique index does not prevent the duplicate.
 */
export const emailField = z
  .string()
  .email()
  .transform((value) => value.trim().toLowerCase());

const registerSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: emailField,
  password: z.string().min(1),
  organizationName: z.string().trim().min(2).max(120).default("My workspace"),
  /** Growth attribution from a `?ref=CODE` signup link. */
  referralCode: z.string().trim().max(16).optional(),
  turnstileToken: z.string().optional()
});

const loginSchema = z.object({
  email: emailField,
  password: z.string().min(1),
  totpCode: z.string().optional(),
  turnstileToken: z.string().optional()
});

const completeTwoFactorSchema = z.object({
  challengeId: z.string(),
  totpCode: z.string().min(6).max(8).optional(),
  code: z.string().min(6).max(8).optional()
});

const resendChallengeSchema = z.object({
  challengeId: z.string()
});

const verifyTwoFactorSchema = z.object({
  totpCode: z.string().min(6).max(8)
});

const emailTwoFactorVerifySchema = z.object({
  code: z.string().min(6).max(8)
});

const forgotPasswordSchema = z.object({
  email: emailField,
  turnstileToken: z.string().optional()
});

const resetPasswordSchema = z.object({
  email: emailField,
  otp: z.string().length(6),
  newPassword: z.string().min(1)
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(1)
});

const googleCallbackSchema = z.object({
  code: z.string(),
  state: z.string()
});

const switchOrganizationParamsSchema = z.object({
  organizationId: z.string().min(1).max(64)
});

type GoogleProfile = {
  sub: string;
  email: string;
  email_verified?: boolean;
  name?: string;
};

export async function createAudit(input: {
  organizationId: string;
  actorId: string;
  action: string;
  targetType: string;
  targetId?: string;
  ipAddress?: string;
  metadata?: Record<string, unknown>;
}) {
  await prisma.auditLog.create({
    data: {
      ...input,
      metadata: input.metadata as Prisma.InputJsonValue | undefined
    }
  });
}

/**
 * Records a sign-in lifecycle event for the admin login log.
 *
 * Sits alongside `createAudit` rather than replacing it: audit rows need an
 * organization and an actor, which a failed login against an unknown email has
 * neither of. Errors are swallowed so logging can never block authentication.
 */
export async function recordAuthEvent(
  request: FastifyRequest,
  input: {
    email: string;
    userId?: string | null;
    event: AuthEventType;
    method: AuthEventMethod;
    success: boolean;
    reason?: string;
  }
) {
  try {
    await prisma.authEventLog.create({
      data: {
        email: input.email.slice(0, 190),
        userId: input.userId ?? null,
        event: input.event,
        method: input.method,
        success: input.success,
        reason: input.reason ?? null,
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"]?.slice(0, 500) ?? null
      }
    });
  } catch (error) {
    request.log.error(error, "Failed to write auth event log");
  }
}

async function uniqueOrganizationSlug(name: string) {
  const base = normalizeSlug(name) || "workspace";
  let slug = base;
  let counter = 1;

  while (await prisma.organization.findUnique({ where: { slug } })) {
    counter += 1;
    slug = `${base}-${counter}`;
  }

  return slug;
}

/**
 * Mints a session for `user`, in the workspace `user.organizationId` names.
 *
 * There is no separate organization parameter because there must not be one:
 * `user` came out of `toPublicUser`, which already had to be told which
 * workspace it meant, and a second source of truth here is how the JWT and the
 * session row would come to disagree.
 *
 * The workspace is written onto the session row as well as into the token. The
 * clients call `/auth/refresh` on any 401 and on tab focus, so a choice that
 * lived only in the access token would be reset to the default by a background
 * refresh — the user bounced into another workspace with nothing to explain it.
 * It is also recorded on the account, so the next sign-in starts where this one
 * left off.
 */
export async function issueTokens(
  reply: FastifyReply,
  config: RuntimeConfig,
  user: PublicUser,
  request?: FastifyRequest
) {
  const accessToken = signAccessToken(
    {
      sub: user.id,
      email: user.email,
      organizationId: user.organizationId,
      role: user.role,
      isPlatformAdmin: user.isPlatformAdmin
    },
    config.jwtSecret
  );
  const refreshToken = createRefreshToken();
  const sessionTtlSeconds = config.sessionTtlDays * 24 * 60 * 60;
  const expiresAt = new Date(Date.now() + sessionTtlSeconds * 1000);

  // Empty for an account with no membership at all, which the column models as
  // null rather than as a foreign key to nothing.
  const organizationId = user.organizationId || null;

  await prisma.$transaction([
    prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: hashToken(refreshToken),
        organizationId,
        expiresAt
      }
    }),
    prisma.user.update({
      where: { id: user.id },
      data: { lastActiveOrganizationId: organizationId }
    })
  ]);

  // Scoped to the registrable domain (".onshell.cloud") when the request is
  // actually on it, so onshell.cloud and api.onshell.cloud share one session.
  // Both are the same site, so SameSite=Lax still blocks cross-site POSTs while
  // allowing the console's XHR.
  const cookieOptions = resolveSessionCookie(
    { host: request?.headers.host, protocol: request?.protocol ?? "http" },
    config
  );

  // The access token stays short-lived — it is a bearer JWT that nothing can
  // recall early — while the refresh cookie carries the month-long session and
  // silently mints a new one whenever the console asks.
  reply.setCookie("access_token", accessToken, { ...cookieOptions, maxAge: ACCESS_TOKEN_TTL_SECONDS });
  reply.setCookie("refresh_token", refreshToken, { ...cookieOptions, maxAge: sessionTtlSeconds });

  return {
    user,
    accessToken,
    refreshToken
  };
}

/**
 * Cookie attributes must match on clear, or the browser keeps the old cookie.
 * Both variants are cleared because a session may have been issued before the
 * host started matching the configured domain (e.g. mid-DNS-cutover).
 */
export function clearAuthCookies(reply: FastifyReply, config: RuntimeConfig) {
  for (const domain of [config.cookieDomain, undefined]) {
    reply.clearCookie("access_token", { path: "/", domain });
    reply.clearCookie("refresh_token", { path: "/", domain });
  }
}

/**
 * Runs the Turnstile check for a form and, on failure, writes the response.
 * Returns true when the caller should stop.
 */
async function turnstileBlocked(
  form: TurnstileForm,
  request: FastifyRequest,
  reply: FastifyReply,
  config: RuntimeConfig
) {
  const verification = await verifyTurnstile({
    form,
    token: readTurnstileToken(request.body),
    remoteIp: request.ip,
    masterEncryptionKey: config.masterEncryptionKey,
    logger: request.log
  });

  if (verification.ok) return false;

  const failure = turnstileFailureResponse(verification);
  reply.code(failure.status).send(failure.body);
  return true;
}

function createTwoFactorChallenge(userId: string, method: "totp" | "email" = "totp") {
  const challengeId = `mfa_${randomUUID()}`;
  store.pendingTwoFactorChallenges.set(challengeId, {
    userId,
    createdAt: new Date().toISOString(),
    method
  });

  return challengeId;
}

function generateEmailOtp() {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

async function sendChallengeEmailOtp(
  app: FastifyInstance,
  config: RuntimeConfig,
  challengeId: string,
  recipient: string
) {
  const challenge = store.pendingTwoFactorChallenges.get(challengeId);
  if (!challenge) return false;

  const otp = generateEmailOtp();
  challenge.emailOtpHash = hashToken(otp);
  challenge.emailOtpExpiresAt = new Date(Date.now() + EMAIL_OTP_TTL_MS).toISOString();
  challenge.lastEmailSentAt = new Date().toISOString();
  // Re-set so the TTL is refreshed alongside the mutated fields.
  store.pendingTwoFactorChallenges.set(challengeId, challenge);

  const message = signInCodeEmail({
    code: otp,
    expiresInMinutes: EMAIL_OTP_TTL_MS / 60_000,
    siteUrl: config.siteUrl
  });

  return sendTransactionalEmail({
    masterEncryptionKey: config.masterEncryptionKey,
    recipient,
    subject: message.subject,
    text: message.text,
    html: message.html,
    kind: "two_factor_login_code",
    logger: app.log
  });
}

function verifyEmailOtp(code: string, otpHash?: string, expiresAt?: string) {
  if (!otpHash || !expiresAt) return false;
  if (new Date(expiresAt).getTime() < Date.now()) return false;
  const candidate = Buffer.from(hashToken(code), "utf8");
  const expected = Buffer.from(otpHash, "utf8");
  if (candidate.length !== expected.length) return false;
  return timingSafeEqual(candidate, expected);
}

/**
 * Emails a one-time code used to confirm enabling or disabling email-based 2FA.
 * Kept separate from the login challenge store so a pending login cannot be
 * used to satisfy a settings change.
 */
async function sendEmailTwoFactorCode(
  app: FastifyInstance,
  config: RuntimeConfig,
  userId: string,
  recipient: string,
  purpose: "enable" | "disable"
) {
  const otp = generateEmailOtp();
  store.pendingEmailTwoFactorCodes.set(userId, {
    otpHash: hashToken(otp),
    expiresAt: new Date(Date.now() + EMAIL_OTP_TTL_MS).toISOString()
  });

  const message = twoFactorChangeCodeEmail({
    code: otp,
    purpose,
    expiresInMinutes: EMAIL_OTP_TTL_MS / 60_000,
    siteUrl: config.siteUrl
  });
  const sent = await sendTransactionalEmail({
    masterEncryptionKey: config.masterEncryptionKey,
    recipient,
    subject: message.subject,
    text: message.text,
    html: message.html,
    kind: `two_factor_${purpose}_code`,
    logger: app.log
  });

  if (!sent) store.pendingEmailTwoFactorCodes.delete(userId);
  return sent;
}

async function getTwoFactorMethod(userId: string, twoFactorEnabled: boolean) {
  if (!twoFactorEnabled) return null;
  const twoFactorSecret = await prisma.twoFactorSecret.findUnique({ where: { userId } });
  return twoFactorSecret ? ("totp" as const) : ("email" as const);
}

async function verifyTotp(config: RuntimeConfig, userId: string, code: string) {
  const twoFactorSecret = await prisma.twoFactorSecret.findUnique({ where: { userId } });
  if (!twoFactorSecret) return false;

  const secret = decryptSecret(
    {
      encryptedPayload: twoFactorSecret.encryptedSecret,
      nonce: twoFactorSecret.nonce,
      authTag: twoFactorSecret.authTag
    },
    config.masterEncryptionKey
  );
  const result = await verify({ secret, token: code });
  return result.valid;
}

function buildGoogleAuthUrl(config: RuntimeConfig, returnTo = "/console") {
  const state = `google_${randomUUID()}`;
  store.googleOAuthStates.set(state, {
    createdAt: new Date().toISOString(),
    returnTo
  });

  const params = new URLSearchParams({
    client_id: config.googleClientId,
    redirect_uri: config.googleRedirectUri,
    response_type: "code",
    scope: "openid email profile",
    access_type: "offline",
    prompt: "select_account",
    state
  });

  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

async function getGoogleProfile(config: RuntimeConfig, code: string) {
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      code,
      client_id: config.googleClientId,
      client_secret: config.googleClientSecret,
      redirect_uri: config.googleRedirectUri,
      grant_type: "authorization_code"
    })
  });

  if (!tokenResponse.ok) throw new Error("Google token exchange failed");
  const tokenPayload = (await tokenResponse.json()) as { access_token: string };
  const profileResponse = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: {
      authorization: `Bearer ${tokenPayload.access_token}`
    }
  });

  if (!profileResponse.ok) throw new Error("Google profile request failed");
  return (await profileResponse.json()) as GoogleProfile;
}

async function upsertGoogleUser(rawProfile: GoogleProfile) {
  // Google returns mixed-case addresses; the User.email unique index is
  // case-sensitive in MySQL utf8mb4_unicode_ci terms only for comparison, so
  // normalise here to match the rest of the auth surface.
  const profile: GoogleProfile = { ...rawProfile, email: rawProfile.email.trim().toLowerCase() };

  const existingAccount = await prisma.oAuthAccount.findUnique({
    where: {
      provider_providerAccountId: {
        provider: AuthProvider.GOOGLE,
        providerAccountId: profile.sub
      }
    },
    include: {
      user: {
        include: { memberships: membershipOrder }
      }
    }
  });

  if (existingAccount) return existingAccount.user;

  const existingByEmail = await prisma.user.findUnique({
    where: { email: profile.email },
    include: { memberships: membershipOrder }
  });

  if (existingByEmail) {
    await prisma.oAuthAccount.create({
      data: {
        userId: existingByEmail.id,
        provider: AuthProvider.GOOGLE,
        providerAccountId: profile.sub,
        email: profile.email
      }
    });

    return prisma.user.update({
      where: { id: existingByEmail.id },
      data: {
        emailVerifiedAt: profile.email_verified ? new Date() : existingByEmail.emailVerifiedAt
      },
      include: { memberships: membershipOrder }
    });
  }

  const organizationName = `${profile.email.split("@")[1] ?? "Google"} workspace`;
  const slug = await uniqueOrganizationSlug(organizationName);
  const referralCode = await generateReferralCode();

  return prisma.$transaction(async (tx) => {
    const organization = await tx.organization.create({
      data: {
        name: organizationName,
        slug
      }
    });

    const user = await tx.user.create({
      data: {
        email: profile.email,
        name: profile.name ?? profile.email.split("@")[0],
        passwordHash: null,
        referralCode,
        emailVerifiedAt: profile.email_verified ? new Date() : undefined,
        oauthAccounts: {
          create: {
            provider: AuthProvider.GOOGLE,
            providerAccountId: profile.sub,
            email: profile.email
          }
        },
        memberships: {
          create: {
            organizationId: organization.id,
            role: Role.OWNER
          }
        }
      },
      include: { memberships: membershipOrder }
    });

    return user;
  });
}

function toPublicOrganization(organization: {
  id: string;
  name: string;
  slug: string;
  createdAt: Date;
}) {
  return {
    id: organization.id,
    name: organization.name,
    slug: organization.slug,
    createdAt: organization.createdAt.toISOString()
  };
}

/**
 * Every workspace this account can switch into, with the role it holds in each.
 *
 * The role is read per membership rather than taken from the session, because
 * someone can be an owner of their own workspace and an auditor of a workspace
 * they were invited to — and a switcher that showed one role for both would be
 * telling them the wrong thing about what they are about to be able to do.
 */
async function listMemberships(userId: string, activeOrganizationId: string) {
  const memberships = await prisma.organizationMember.findMany({
    where: { userId },
    include: { organization: true },
    orderBy: { createdAt: "asc" }
  });

  return memberships.map((membership) => ({
    id: membership.organizationId,
    name: membership.organization.name,
    slug: membership.organization.slug,
    role: roleFromPrisma[membership.role],
    isActive: membership.organizationId === activeOrganizationId,
    joinedAt: membership.createdAt.toISOString()
  }));
}

/**
 * Describes a workspace substitution the caller did not ask for.
 *
 * The case is a live access token naming a workspace the person has since been
 * removed from. They keep working, in a workspace they genuinely belong to, so
 * nothing has leaked — but until this existed the change was invisible, and a
 * console whose host list silently becomes somebody else's is indistinguishable
 * from a console that has broken.
 *
 * Naming the workspace they lost is not a disclosure: they were a member of it
 * minutes ago and hold a token that says so.
 */
async function describeOrganizationChange(
  previousOrganizationId: string,
  organization: { id: string; name: string } | null
) {
  const previous = await prisma.organization.findUnique({
    where: { id: previousOrganizationId },
    select: { name: true }
  });

  return {
    reason: "membership_revoked" as const,
    previousOrganizationId,
    // Null when the workspace itself was deleted rather than the membership.
    previousOrganizationName: previous?.name ?? null,
    organizationId: organization?.id ?? null,
    organizationName: organization?.name ?? null
  };
}

async function addAuthMethods(user: PublicUser, prismaUser: UserWithMembership) {
  const oauthCount = await prisma.oAuthAccount.count({ where: { userId: prismaUser.id } });
  return {
    ...user,
    authMethods: [
      ...(prismaUser.passwordHash ? (["password"] as const) : []),
      ...(oauthCount > 0 ? (["google"] as const) : [])
    ]
  };
}

export async function registerAuthRoutes(app: FastifyInstance, config: RuntimeConfig) {
  app.post("/auth/register", authRateLimit(10), async (request, reply) => {
    try {
      const body = registerSchema.parse(request.body);
      if (await turnstileBlocked("signup", request, reply, config)) return reply;

      const passwordCheck = validatePassword(body.password);
      if (!passwordCheck.valid) {
        return reply.code(400).send({ error: "password_policy_violation", errors: passwordCheck.errors });
      }

      const existing = await prisma.user.findUnique({ where: { email: body.email } });
      if (existing) return reply.code(409).send({ error: "email_already_registered" });

      const slug = await uniqueOrganizationSlug(body.organizationName);
      const passwordHash = await bcrypt.hash(body.password, 12);
      const referredById = await resolveReferrer(body.referralCode);
      const referralCode = await generateReferralCode();

      const { prismaUser, organizationId } = await prisma.$transaction(async (tx) => {
        const organization = await tx.organization.create({
          data: {
            name: body.organizationName,
            slug
          }
        });

        const createdUser = await tx.user.create({
          data: {
            name: body.name,
            email: body.email,
            passwordHash,
            referralCode,
            referredById,
            lastActiveOrganizationId: organization.id,
            memberships: {
              create: {
                organizationId: organization.id,
                role: Role.OWNER
              }
            }
          },
          include: { memberships: membershipOrder }
        });

        return { prismaUser: createdUser, organizationId: organization.id };
      });

      const user = await addAuthMethods(toPublicUser(prismaUser, organizationId), prismaUser);
      // Start every new workspace on the Free tier so the freemium funnel and
      // the console's usage/upgrade surfaces have a plan to read from, and give
      // it the built-in local host so there is something to open a terminal on
      // before any server has been registered.
      await Promise.all([ensureFreeSubscription(user.organizationId), ensureLocalHost(user)]);
      await createAudit({
        organizationId: user.organizationId,
        actorId: user.id,
        action: "auth.register",
        targetType: "user",
        targetId: user.id,
        ipAddress: request.ip,
        metadata: { referred: Boolean(referredById) }
      });

      return reply.code(201).send(await issueTokens(reply, config, user, request));
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });

  app.post("/auth/login", authRateLimit(20), async (request, reply) => {
    try {
      const body = loginSchema.parse(request.body);
      if (await turnstileBlocked("login", request, reply, config)) return reply;

      // Per-account lockout on top of the IP rate limit, so a distributed
      // password-spray against one account still slows down.
      const lockSeconds = getLoginLock(body.email, request.ip);
      if (lockSeconds > 0) {
        return reply.code(429).send({
          error: "too_many_login_attempts",
          message: `Too many failed attempts. Try again in ${lockSeconds}s.`,
          retryAfterSeconds: lockSeconds
        });
      }

      const prismaUser = await prisma.user.findUnique({
        where: { email: body.email },
        include: { memberships: membershipOrder }
      });
      if (!prismaUser?.passwordHash) {
        recordLoginFailure(body.email, request.ip);
        // No audit row is possible here (unknown or password-less account), but
        // the attempt is exactly what the login log exists to surface.
        await recordAuthEvent(request, {
          email: body.email,
          userId: prismaUser?.id,
          event: "LOGIN_FAILED",
          method: "PASSWORD",
          success: false,
          reason: prismaUser ? "no_password_set" : "unknown_email"
        });
        return reply.code(401).send({ error: "invalid_credentials" });
      }

      const passwordValid = await bcrypt.compare(body.password, prismaUser.passwordHash);
      // Sign in where they were, not in whichever workspace is oldest. The
      // stored preference is checked against the live memberships rather than
      // trusted, so a workspace they have since been removed from — or one that
      // has been deleted — falls back instead of failing the sign-in.
      const publicUser = toPublicUser(prismaUser, prismaUser.lastActiveOrganizationId);
      if (!passwordValid) {
        recordLoginFailure(body.email, request.ip);
        await createAudit({
          organizationId: publicUser.organizationId,
          actorId: publicUser.id,
          action: "auth.login.failed",
          targetType: "user",
          targetId: publicUser.id,
          ipAddress: request.ip,
          metadata: { reason: "invalid_password" }
        });
        await recordAuthEvent(request, {
          email: publicUser.email,
          userId: publicUser.id,
          event: "LOGIN_FAILED",
          method: "PASSWORD",
          success: false,
          reason: "invalid_password"
        });
        return reply.code(401).send({ error: "invalid_credentials" });
      }

      clearLoginFailures(body.email, request.ip);

      if (prismaUser.twoFactorEnabled) {
        const method = await getTwoFactorMethod(prismaUser.id, true);

        if (method === "email") {
          const challengeId = createTwoFactorChallenge(prismaUser.id, "email");
          await sendChallengeEmailOtp(app, config, challengeId, prismaUser.email);
          return reply.code(202).send({
            requiresTwoFactor: true,
            method: "email",
            challengeId,
            message: "Enter the 6-digit code we emailed to you."
          });
        }

        if (!body.totpCode) {
          return reply.code(202).send({
            requiresTwoFactor: true,
            method: "totp",
            challengeId: createTwoFactorChallenge(prismaUser.id),
            message: "Enter the 6-digit code from Google Authenticator."
          });
        }

        if (!(await verifyTotp(config, prismaUser.id, body.totpCode))) {
          await recordAuthEvent(request, {
            email: publicUser.email,
            userId: publicUser.id,
            event: "LOGIN_FAILED",
            method: "TWO_FACTOR",
            success: false,
            reason: "invalid_two_factor_code"
          });
          return reply.code(401).send({ error: "invalid_two_factor_code" });
        }
      }

      const user = await addAuthMethods(publicUser, prismaUser);
      await createAudit({
        organizationId: user.organizationId,
        actorId: user.id,
        action: "auth.login",
        targetType: "user",
        targetId: user.id,
        ipAddress: request.ip,
        metadata: { twoFactorProvided: Boolean(body.totpCode) }
      });
      await recordAuthEvent(request, {
        email: user.email,
        userId: user.id,
        event: "LOGIN",
        method: "PASSWORD",
        success: true
      });

      return issueTokens(reply, config, user, request);
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });

  app.post("/auth/2fa/complete", authRateLimit(20), async (request, reply) => {
    try {
      const body = completeTwoFactorSchema.parse(request.body);
      const code = body.code ?? body.totpCode;
      if (!code) return reply.code(400).send({ error: "two_factor_code_required" });

      const challenge = store.pendingTwoFactorChallenges.get(body.challengeId);
      if (!challenge) return reply.code(404).send({ error: "two_factor_challenge_not_found" });

      challenge.attempts = (challenge.attempts ?? 0) + 1;
      if (challenge.attempts > MAX_CHALLENGE_ATTEMPTS) {
        store.pendingTwoFactorChallenges.delete(body.challengeId);
        return reply.code(429).send({ error: "too_many_attempts" });
      }
      store.pendingTwoFactorChallenges.set(body.challengeId, challenge);

      const prismaUser = await prisma.user.findUnique({
        where: { id: challenge.userId },
        include: { memberships: membershipOrder }
      });
      if (!prismaUser) return reply.code(404).send({ error: "user_not_found" });

      const codeValid =
        challenge.method === "email"
          ? verifyEmailOtp(code, challenge.emailOtpHash, challenge.emailOtpExpiresAt)
          : await verifyTotp(config, prismaUser.id, code);
      if (!codeValid) {
        await recordAuthEvent(request, {
          email: prismaUser.email,
          userId: prismaUser.id,
          event: "LOGIN_FAILED",
          method: "TWO_FACTOR",
          success: false,
          reason: "invalid_two_factor_code"
        });
        return reply.code(401).send({ error: "invalid_two_factor_code" });
      }

      store.pendingTwoFactorChallenges.delete(body.challengeId);
      // The second factor completes the sign-in that /auth/login started, so it
      // has to land in the same workspace that would have.
      const user = await addAuthMethods(
        toPublicUser(prismaUser, prismaUser.lastActiveOrganizationId),
        prismaUser
      );
      await createAudit({
        organizationId: user.organizationId,
        actorId: user.id,
        action: "auth.2fa.complete",
        targetType: "user",
        targetId: user.id,
        ipAddress: request.ip
      });
      await recordAuthEvent(request, {
        email: user.email,
        userId: user.id,
        event: "TWO_FACTOR_COMPLETED",
        method: "TWO_FACTOR",
        success: true,
        reason: challenge.method
      });

      return issueTokens(reply, config, user, request);
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });

  app.post("/auth/2fa/challenge/resend", authRateLimit(10), async (request, reply) => {
    try {
      const body = resendChallengeSchema.parse(request.body);
      const challenge = store.pendingTwoFactorChallenges.get(body.challengeId);
      if (!challenge) return reply.code(404).send({ error: "two_factor_challenge_not_found" });
      if (challenge.method !== "email") {
        return reply.code(400).send({ error: "challenge_does_not_use_email" });
      }

      if (challenge.lastEmailSentAt) {
        const elapsedMs = Date.now() - new Date(challenge.lastEmailSentAt).getTime();
        if (elapsedMs < CHALLENGE_RESEND_INTERVAL_MS) {
          return reply.code(429).send({
            error: "resend_rate_limited",
            retryAfterSeconds: Math.ceil((CHALLENGE_RESEND_INTERVAL_MS - elapsedMs) / 1000)
          });
        }
      }

      const prismaUser = await prisma.user.findUnique({ where: { id: challenge.userId } });
      if (!prismaUser) return reply.code(404).send({ error: "user_not_found" });

      const sent = await sendChallengeEmailOtp(app, config, body.challengeId, prismaUser.email);
      return { ok: true, sent };
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });

  app.post("/auth/2fa/setup", async (request, reply) => {
    const user = await getAuthenticatedUser(request, config);
    if (!user) return reply.code(401).send({ error: "unauthorized" });

    const secret = generateSecret();
    const otpauthUrl = generateURI({
      issuer: "Onshell.cloud",
      label: user.email,
      secret
    });
    const qrCodeDataUrl = await QRCode.toDataURL(otpauthUrl);
    store.pendingTwoFactorSetups.set(user.id, secret);

    return {
      issuer: "Onshell.cloud",
      accountName: user.email,
      manualEntryKey: secret,
      otpauthUrl,
      qrCodeDataUrl
    };
  });

  app.post("/auth/2fa/verify", async (request, reply) => {
    try {
      const user = await getAuthenticatedUser(request, config);
      if (!user) return reply.code(401).send({ error: "unauthorized" });

      const body = verifyTwoFactorSchema.parse(request.body);
      const pendingSecret = store.pendingTwoFactorSetups.get(user.id);
      if (!pendingSecret) return reply.code(404).send({ error: "two_factor_setup_not_started" });

      const result = await verify({ secret: pendingSecret, token: body.totpCode });
      if (!result.valid) return reply.code(401).send({ error: "invalid_two_factor_code" });

      const encrypted = encryptSecret(pendingSecret, config.masterEncryptionKey);
      await prisma.$transaction([
        prisma.twoFactorSecret.upsert({
          where: { userId: user.id },
          update: {
            encryptedSecret: encrypted.encryptedPayload,
            nonce: encrypted.nonce,
            authTag: encrypted.authTag
          },
          create: {
            userId: user.id,
            encryptedSecret: encrypted.encryptedPayload,
            nonce: encrypted.nonce,
            authTag: encrypted.authTag
          }
        }),
        prisma.user.update({
          where: { id: user.id },
          data: { twoFactorEnabled: true }
        })
      ]);

      store.pendingTwoFactorSetups.delete(user.id);
      await createAudit({
        organizationId: user.organizationId,
        actorId: user.id,
        action: "auth.2fa.enable",
        targetType: "user",
        targetId: user.id,
        ipAddress: request.ip
      });

      return { twoFactorEnabled: true };
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });

  app.post("/auth/2fa/email/enable", authRateLimit(6), async (request, reply) => {
    try {
      const user = await getAuthenticatedUser(request, config);
      if (!user) return reply.code(401).send({ error: "unauthorized" });

      if (!(await isSmtpEnabled())) {
        return reply.code(503).send({
          error: "smtp_not_configured",
          message: "Email delivery is not configured. Ask a platform admin to enable SMTP."
        });
      }

      const sent = await sendEmailTwoFactorCode(app, config, user.id, user.email, "enable");
      if (!sent) return reply.code(502).send({ error: "email_delivery_failed" });

      return { sent: true, expiresInSeconds: EMAIL_OTP_TTL_MS / 1000 };
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });

  /**
   * Sends the confirmation code needed to turn OFF email-based 2FA. Without
   * this, a user on email 2FA could never disable it: /auth/2fa/disable expects
   * a code, but the only issuing endpoint was the *enable* flow.
   */
  app.post("/auth/2fa/email/challenge", authRateLimit(6), async (request, reply) => {
    try {
      const user = await getAuthenticatedUser(request, config);
      if (!user) return reply.code(401).send({ error: "unauthorized" });
      if (!user.twoFactorEnabled) return reply.code(400).send({ error: "two_factor_not_enabled" });

      const method = await getTwoFactorMethod(user.id, user.twoFactorEnabled);
      if (method !== "email") {
        return reply.code(400).send({
          error: "two_factor_not_email",
          message: "This account uses an authenticator app. Use a code from the app instead."
        });
      }

      if (!(await isSmtpEnabled())) {
        return reply.code(503).send({
          error: "smtp_not_configured",
          message: "Email delivery is not configured. Ask a platform admin to enable SMTP."
        });
      }

      const sent = await sendEmailTwoFactorCode(app, config, user.id, user.email, "disable");
      if (!sent) return reply.code(502).send({ error: "email_delivery_failed" });

      return { sent: true, expiresInSeconds: EMAIL_OTP_TTL_MS / 1000 };
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });

  app.post("/auth/2fa/email/verify", authRateLimit(20), async (request, reply) => {
    try {
      const user = await getAuthenticatedUser(request, config);
      if (!user) return reply.code(401).send({ error: "unauthorized" });

      const body = emailTwoFactorVerifySchema.parse(request.body);
      const pending = store.pendingEmailTwoFactorCodes.get(user.id);
      if (!pending) return reply.code(404).send({ error: "two_factor_email_setup_not_started" });
      if (!verifyEmailOtp(body.code, pending.otpHash, pending.expiresAt)) {
        return reply.code(401).send({ error: "invalid_two_factor_code" });
      }

      store.pendingEmailTwoFactorCodes.delete(user.id);
      await prisma.$transaction([
        prisma.twoFactorSecret.deleteMany({ where: { userId: user.id } }),
        prisma.user.update({
          where: { id: user.id },
          data: { twoFactorEnabled: true }
        })
      ]);

      await createAudit({
        organizationId: user.organizationId,
        actorId: user.id,
        action: "auth.2fa.email.enable",
        targetType: "user",
        targetId: user.id,
        ipAddress: request.ip
      });

      return { twoFactorEnabled: true, method: "email" };
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });

  app.post("/auth/2fa/disable", authRateLimit(20), async (request, reply) => {
    try {
      const user = await getAuthenticatedUser(request, config);
      if (!user) return reply.code(401).send({ error: "unauthorized" });

      const body = verifyTwoFactorSchema.parse(request.body);
      const method = await getTwoFactorMethod(user.id, user.twoFactorEnabled);
      const pendingCode = store.pendingEmailTwoFactorCodes.get(user.id);
      const codeValid =
        method === "email"
          ? verifyEmailOtp(body.totpCode, pendingCode?.otpHash, pendingCode?.expiresAt)
          : await verifyTotp(config, user.id, body.totpCode);
      if (!codeValid) {
        return reply.code(401).send({ error: "invalid_two_factor_code" });
      }

      store.pendingEmailTwoFactorCodes.delete(user.id);

      await prisma.$transaction([
        prisma.twoFactorSecret.deleteMany({ where: { userId: user.id } }),
        prisma.user.update({ where: { id: user.id }, data: { twoFactorEnabled: false } })
      ]);
      await createAudit({
        organizationId: user.organizationId,
        actorId: user.id,
        action: "auth.2fa.disable",
        targetType: "user",
        targetId: user.id,
        ipAddress: request.ip
      });

      return { twoFactorEnabled: false };
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });

  app.get("/auth/2fa/status", async (request, reply) => {
    const user = await getAuthenticatedUser(request, config);
    if (!user) return reply.code(401).send({ error: "unauthorized" });

    const method = await getTwoFactorMethod(user.id, user.twoFactorEnabled);
    return {
      twoFactorEnabled: user.twoFactorEnabled,
      method,
      methods: method ? [method] : []
    };
  });

  app.get("/auth/google/start", async (request, reply) => {
    if (!config.googleClientId || !config.googleClientSecret) {
      return reply.code(503).send({
        error: "google_oauth_not_configured",
        message: "Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to enable Google login."
      });
    }

    const query = z.object({ returnTo: z.string().default("/console") }).parse(request.query);
    return { authUrl: buildGoogleAuthUrl(config, query.returnTo) };
  });

  app.get("/auth/google", async (request, reply) => {
    if (!config.googleClientId || !config.googleClientSecret) {
      return reply.redirect(`${config.publicBaseUrl}/login?error=google-not-configured`);
    }

    const query = z.object({ returnTo: z.string().default("/console") }).parse(request.query);
    return reply.redirect(buildGoogleAuthUrl(config, query.returnTo));
  });

  app.get("/auth/google/callback", async (request, reply) => {
    try {
      const query = googleCallbackSchema.parse(request.query);
      const state = store.googleOAuthStates.get(query.state);
      if (!state) return reply.redirect(`${config.publicBaseUrl}/login?error=invalid-google-state`);

      // Single-use: consume the state before the token exchange so a replayed
      // callback cannot mint a second session.
      store.googleOAuthStates.delete(query.state);
      const googleProfile = await getGoogleProfile(config, query.code);
      const prismaUser = await upsertGoogleUser(googleProfile);
      const user = await addAuthMethods(
        toPublicUser(prismaUser, prismaUser.lastActiveOrganizationId),
        prismaUser
      );
      await Promise.all([ensureFreeSubscription(user.organizationId), ensureLocalHost(user)]);

      await createAudit({
        organizationId: user.organizationId,
        actorId: user.id,
        action: "auth.google.login",
        targetType: "user",
        targetId: user.id,
        ipAddress: request.ip,
        metadata: { emailVerified: Boolean(googleProfile.email_verified) }
      });
      await recordAuthEvent(request, {
        email: user.email,
        userId: user.id,
        event: "LOGIN",
        method: "GOOGLE",
        success: true,
        // A 2FA challenge still stands between this and a usable session.
        reason: prismaUser.twoFactorEnabled ? "awaiting_two_factor" : undefined
      });

      if (prismaUser.twoFactorEnabled) {
        const method = (await getTwoFactorMethod(prismaUser.id, true)) ?? "totp";
        const challengeId = createTwoFactorChallenge(prismaUser.id, method);
        if (method === "email") {
          await sendChallengeEmailOtp(app, config, challengeId, prismaUser.email);
        }
        return reply.redirect(`${config.publicBaseUrl}/login?challengeId=${challengeId}&method=${method}`);
      }

      await issueTokens(reply, config, user, request);
      return reply.redirect(`${config.publicBaseUrl}${state.returnTo}?login=google`);
    } catch (error) {
      app.log.error(error);
      return reply.redirect(`${config.publicBaseUrl}/login?error=google-callback-failed`);
    }
  });

  app.get("/auth/me", async (request, reply) => {
    const session = await getAuthenticatedSession(request, config);
    if (!session) return reply.code(401).send({ error: "unauthorized" });

    const { user } = session;
    const organization = await prisma.organization.findUnique({ where: { id: user.organizationId } });
    return {
      user,
      organization,
      // Bundled in rather than left to a second request: the console needs it on
      // its very first call to decide whether to render a switcher at all, and a
      // switcher that appears a moment after the header has drawn is worse than
      // one that was always there.
      organizations: await listMemberships(user.id, user.organizationId),
      ...(session.revokedOrganizationId
        ? { activeOrganizationChanged: await describeOrganizationChange(session.revokedOrganizationId, organization) }
        : {})
    };
  });

  /**
   * The workspaces this account belongs to, and which one it is reading.
   *
   * Resolved from the authenticated user id. Nothing in the request says whose
   * memberships to list, because there is no answer to that question a caller
   * should be able to supply.
   */
  app.get("/auth/organizations", async (request, reply) => {
    const user = await getAuthenticatedUser(request, config);
    if (!user) return reply.code(401).send({ error: "unauthorized" });

    return {
      activeOrganizationId: user.organizationId,
      organizations: await listMemberships(user.id, user.organizationId)
    };
  });

  /**
   * Point this session at another of the caller's workspaces.
   *
   * The whole new attack surface of workspace switching is this handler, so:
   *
   *  * the membership is looked up by the *authenticated* user id and the
   *    organization id in the path — never by anything in a body, which would
   *    let a caller name someone else's membership;
   *  * the role comes from the target membership, re-read here. A role in a
   *    request would be a client asking to be an owner;
   *  * a workspace the caller is not in answers 404, not 403. A 403 would make
   *    this endpoint an oracle for which organization ids exist;
   *  * nothing is granted by the switch that the caller did not already have.
   *    The stored workspace is a preference: every later request re-reads the
   *    memberships (`getAuthenticatedSession`) and falls back if this one has
   *    gone, so being removed from a workspace still takes effect on the next
   *    request rather than at token expiry.
   *
   * The presented refresh token is deliberately *not* revoked. The browser's
   * cookie is overwritten by the new pair so nothing will present the old one
   * again, and a bearer client that ignores this response keeps the session it
   * already had — pointed at the workspace it was already reading — instead of
   * being signed out by a call it made itself.
   */
  app.post("/auth/organizations/:organizationId/switch", authRateLimit(20), async (request, reply) => {
    try {
      const actor = await getAuthenticatedUser(request, config);
      if (!actor) return reply.code(401).send({ error: "unauthorized" });

      const params = switchOrganizationParamsSchema.parse(request.params);
      const membership = await prisma.organizationMember.findUnique({
        where: {
          organizationId_userId: {
            organizationId: params.organizationId,
            userId: actor.id
          }
        },
        include: { organization: true }
      });
      // Same answer for "no such workspace" and "not yours". The caller learns
      // only that this switch is not available to them.
      if (!membership) return reply.code(404).send({ error: "organization_not_found" });

      if (membership.organizationId === actor.organizationId) {
        return { user: actor, organization: toPublicOrganization(membership.organization), changed: false };
      }

      const prismaUser = await prisma.user.findUnique({
        where: { id: actor.id },
        include: { memberships: membershipOrder }
      });
      if (!prismaUser) return reply.code(401).send({ error: "unauthorized" });

      const user = await addAuthMethods(toPublicUser(prismaUser, membership.organizationId), prismaUser);
      const tokens = await issueTokens(reply, config, user, request);

      await createAudit({
        organizationId: membership.organizationId,
        actorId: actor.id,
        action: "auth.organization.switch",
        targetType: "organization",
        targetId: membership.organizationId,
        ipAddress: request.ip,
        metadata: { from: actor.organizationId, role: user.role }
      });
      // A switch mints a session, so it belongs in the login log next to the
      // other ways one comes into existence. `SESSION` because the credential
      // that produced it was the session the caller already held.
      await recordAuthEvent(request, {
        email: user.email,
        userId: user.id,
        event: "LOGIN",
        method: "SESSION",
        success: true,
        reason: "organization_switch"
      });

      return { ...tokens, organization: toPublicOrganization(membership.organization), changed: true };
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });

  app.post("/auth/refresh", async (request, reply) => {
    try {
      // The cookie is the browser's session. A native client has no cookie jar
      // worth relying on and no origin to be first-party to, so the desktop app
      // sends the same token in the body instead. The cookie is preferred when
      // both are present: a browser must not be able to have its session
      // swapped by a body a page script chose.
      const body = request.body as { refreshToken?: unknown } | undefined;
      const refreshToken =
        request.cookies?.refresh_token ?? (typeof body?.refreshToken === "string" ? body.refreshToken : undefined);
      if (!refreshToken) return reply.code(401).send({ error: "missing_refresh_token" });

      const tokenRow = await prisma.refreshToken.findFirst({
        where: { tokenHash: hashToken(refreshToken) },
        include: {
          user: {
            include: { memberships: membershipOrder }
          }
        }
      });
      // Accepts a token that was rotated a moment ago, so two console tabs
      // refreshing at once do not sign each other out. A sign-out is expired,
      // not merely revoked, and so is never forgiven here.
      if (!isRefreshTokenUsable(tokenRow)) {
        clearAuthCookies(reply, config);
        return reply.code(401).send({ error: "invalid_refresh_token" });
      }

      if (!tokenRow.revokedAt) {
        await prisma.refreshToken.update({
          where: { id: tokenRow.id },
          data: { revokedAt: new Date() }
        });
      }

      // The workspace comes off the session row, which is the only place it
      // could survive a rotation: this handler is called on any 401 and on tab
      // focus, and before the row carried it a background refresh would silently
      // reset the caller to their oldest membership.
      //
      // Re-validated rather than trusted. If the membership has gone the session
      // falls back to one that has not — and says so, so the console can tell
      // the user they were removed instead of showing them a different
      // workspace's hosts without explanation.
      const active = resolveActiveMembership(tokenRow.user.memberships, tokenRow.organizationId);
      const user = await addAuthMethods(
        toPublicUser(tokenRow.user, active.membership?.organizationId ?? null),
        tokenRow.user
      );
      const tokens = await issueTokens(reply, config, user, request);
      if (!active.fellBack) return tokens;

      return {
        ...tokens,
        activeOrganizationChanged: await describeOrganizationChange(
          tokenRow.organizationId as string,
          await prisma.organization.findUnique({ where: { id: user.organizationId } })
        )
      };
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });

  app.post("/auth/password/forgot", authRateLimit(6), async (request, reply) => {
    try {
      const body = forgotPasswordSchema.parse(request.body);
      if (await turnstileBlocked("passwordReset", request, reply, config)) return reply;

      const genericResponse = {
        ok: true,
        message: "If that email is registered, a reset code has been sent."
      };

      const prismaUser = await prisma.user.findUnique({ where: { email: body.email } });
      if (!prismaUser?.passwordHash) return genericResponse;

      const otp = generateEmailOtp();
      await prisma.$transaction([
        prisma.passwordResetToken.deleteMany({
          where: { userId: prismaUser.id, usedAt: null }
        }),
        prisma.passwordResetToken.create({
          data: {
            userId: prismaUser.id,
            tokenHash: hashToken(otp),
            expiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_MS)
          }
        })
      ]);

      const message = passwordResetEmail({
        code: otp,
        expiresInMinutes: PASSWORD_RESET_TTL_MS / 60_000,
        siteUrl: config.siteUrl
      });
      const sent = await sendTransactionalEmail({
        masterEncryptionKey: config.masterEncryptionKey,
        recipient: prismaUser.email,
        subject: message.subject,
        text: message.text,
        html: message.html,
        kind: "password_reset",
        logger: app.log
      });
      if (!sent) {
        app.log.info({ userId: prismaUser.id }, "Password reset OTP created but email was not sent (SMTP disabled or failed)");
      }

      return genericResponse;
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });

  app.post("/auth/password/reset", authRateLimit(10), async (request, reply) => {
    try {
      const body = resetPasswordSchema.parse(request.body);
      const passwordCheck = validatePassword(body.newPassword);
      if (!passwordCheck.valid) {
        return reply.code(400).send({ error: "password_policy_violation", errors: passwordCheck.errors });
      }

      const prismaUser = await prisma.user.findUnique({
        where: { email: body.email },
        include: { memberships: membershipOrder }
      });
      if (!prismaUser) return reply.code(401).send({ error: "invalid_reset_code" });

      const resetToken = await prisma.passwordResetToken.findFirst({
        where: {
          userId: prismaUser.id,
          tokenHash: hashToken(body.otp),
          usedAt: null,
          expiresAt: { gt: new Date() }
        }
      });
      if (!resetToken) return reply.code(401).send({ error: "invalid_reset_code" });

      const passwordHash = await bcrypt.hash(body.newPassword, 12);
      await prisma.$transaction([
        prisma.passwordResetToken.update({
          where: { id: resetToken.id },
          data: { usedAt: new Date() }
        }),
        prisma.user.update({
          where: { id: prismaUser.id },
          data: { passwordHash }
        }),
        revokeRefreshTokens({ userId: prismaUser.id })
      ]);

      // Only used to attribute the audit row, so the workspace they were last
      // in is the right one to file it under.
      const publicUser = toPublicUser(prismaUser, prismaUser.lastActiveOrganizationId);
      if (publicUser.organizationId) {
        await createAudit({
          organizationId: publicUser.organizationId,
          actorId: publicUser.id,
          action: "auth.password.reset",
          targetType: "user",
          targetId: publicUser.id,
          ipAddress: request.ip
        });
      }

      return { ok: true };
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });

  app.post("/auth/password/change", authRateLimit(10), async (request, reply) => {
    try {
      const user = await getAuthenticatedUser(request, config);
      if (!user) return reply.code(401).send({ error: "unauthorized" });

      const body = changePasswordSchema.parse(request.body);

      const prismaUser = await prisma.user.findUnique({ where: { id: user.id } });
      if (!prismaUser?.passwordHash) {
        // Google-only accounts have no password to verify against.
        return reply.code(400).send({ error: "password_not_set" });
      }

      const currentValid = await bcrypt.compare(body.currentPassword, prismaUser.passwordHash);
      if (!currentValid) {
        await createAudit({
          organizationId: user.organizationId,
          actorId: user.id,
          action: "auth.password.change.failed",
          targetType: "user",
          targetId: user.id,
          ipAddress: request.ip,
          metadata: { reason: "invalid_current_password" }
        });
        return reply.code(401).send({ error: "invalid_current_password" });
      }

      const passwordCheck = validatePassword(body.newPassword);
      if (!passwordCheck.valid) {
        return reply.code(400).send({ error: "password_policy_violation", errors: passwordCheck.errors });
      }

      const sameAsOld = await bcrypt.compare(body.newPassword, prismaUser.passwordHash);
      if (sameAsOld) {
        return reply.code(400).send({ error: "password_reuse" });
      }

      const passwordHash = await bcrypt.hash(body.newPassword, 12);
      await prisma.$transaction([
        prisma.user.update({
          where: { id: prismaUser.id },
          data: { passwordHash }
        }),
        // Revoke every refresh token so other devices are signed out. A fresh
        // pair is issued below so the current session stays valid.
        revokeRefreshTokens({ userId: prismaUser.id })
      ]);

      await createAudit({
        organizationId: user.organizationId,
        actorId: user.id,
        action: "auth.password.change",
        targetType: "user",
        targetId: user.id,
        ipAddress: request.ip
      });

      return issueTokens(reply, config, user, request);
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });

  app.post("/auth/logout", async (request, reply) => {
    const refreshToken = request.cookies?.refresh_token;
    if (refreshToken) {
      const tokenHash = hashToken(refreshToken);
      // Resolved before revoking so the logout can be attributed to an account
      // without trusting an access token that may already have expired.
      const tokenRow = await prisma.refreshToken.findFirst({
        where: { tokenHash },
        select: { user: { select: { id: true, email: true } } }
      });

      await revokeRefreshTokens({ tokenHash });

      if (tokenRow) {
        await recordAuthEvent(request, {
          email: tokenRow.user.email,
          userId: tokenRow.user.id,
          event: "LOGOUT",
          method: "SESSION",
          success: true
        });
      }
    }

    clearAuthCookies(reply, config);
    return { ok: true };
  });
}

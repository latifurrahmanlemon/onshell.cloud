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
import { getAuthenticatedUser } from "../../lib/current-user.js";
import { sendTransactionalEmail, isSmtpEnabled } from "../../lib/email.js";
import { encryptSecret, decryptSecret } from "../../lib/encryption.js";
import { clearLoginFailures, getLoginLock, recordLoginFailure } from "../../lib/login-throttle.js";
import { prisma } from "../../lib/prisma.js";
import { isRefreshTokenUsable } from "../../lib/refresh-token-policy.js";
import { revokeRefreshTokens } from "../../lib/refresh-tokens.js";
import { toPublicUser, type UserWithMembership } from "../../lib/prisma-mappers.js";
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
const emailField = z
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
async function recordAuthEvent(
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

  await prisma.refreshToken.create({
    data: {
      userId: user.id,
      tokenHash: hashToken(refreshToken),
      expiresAt
    }
  });

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

  return sendTransactionalEmail({
    masterEncryptionKey: config.masterEncryptionKey,
    recipient,
    subject: "Your Onshell.cloud sign-in code",
    text: `Your Onshell.cloud sign-in code is ${otp}. It expires in 10 minutes.`,
    html: `<p>Your Onshell.cloud sign-in code is <strong>${otp}</strong>. It expires in 10 minutes.</p>`,
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

  const action = purpose === "enable" ? "enable" : "turn off";
  const sent = await sendTransactionalEmail({
    masterEncryptionKey: config.masterEncryptionKey,
    recipient,
    subject: "Your Onshell.cloud verification code",
    text: `Use code ${otp} to ${action} email two-factor authentication on Onshell.cloud. It expires in 10 minutes.`,
    html: `<p>Use code <strong>${otp}</strong> to ${action} email two-factor authentication on Onshell.cloud. It expires in 10 minutes.</p>`,
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
        include: { memberships: true }
      }
    }
  });

  if (existingAccount) return existingAccount.user;

  const existingByEmail = await prisma.user.findUnique({
    where: { email: profile.email },
    include: { memberships: true }
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
      include: { memberships: true }
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
      include: { memberships: true }
    });

    return user;
  });
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

      const prismaUser = await prisma.$transaction(async (tx) => {
        const organization = await tx.organization.create({
          data: {
            name: body.organizationName,
            slug
          }
        });

        return tx.user.create({
          data: {
            name: body.name,
            email: body.email,
            passwordHash,
            referralCode,
            referredById,
            memberships: {
              create: {
                organizationId: organization.id,
                role: Role.OWNER
              }
            }
          },
          include: { memberships: true }
        });
      });

      const user = await addAuthMethods(toPublicUser(prismaUser), prismaUser);
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
        include: { memberships: true }
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
      const publicUser = toPublicUser(prismaUser);
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
        include: { memberships: true }
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
      const user = await addAuthMethods(toPublicUser(prismaUser), prismaUser);
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
      const user = await addAuthMethods(toPublicUser(prismaUser), prismaUser);
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
    const user = await getAuthenticatedUser(request, config);
    if (!user) return reply.code(401).send({ error: "unauthorized" });

    const organization = await prisma.organization.findUnique({ where: { id: user.organizationId } });
    return { user, organization };
  });

  app.post("/auth/refresh", async (request, reply) => {
    try {
      const refreshToken = request.cookies?.refresh_token;
      if (!refreshToken) return reply.code(401).send({ error: "missing_refresh_token" });

      const tokenRow = await prisma.refreshToken.findFirst({
        where: { tokenHash: hashToken(refreshToken) },
        include: {
          user: {
            include: { memberships: true }
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

      const user = await addAuthMethods(toPublicUser(tokenRow.user), tokenRow.user);
      return issueTokens(reply, config, user, request);
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

      const sent = await sendTransactionalEmail({
        masterEncryptionKey: config.masterEncryptionKey,
        recipient: prismaUser.email,
        subject: "Your Onshell.cloud password reset code",
        text: `Your Onshell.cloud password reset code is ${otp}. It expires in 15 minutes. If you did not request this, you can ignore this email.`,
        html: `<p>Your Onshell.cloud password reset code is <strong>${otp}</strong>. It expires in 15 minutes.</p><p>If you did not request this, you can ignore this email.</p>`,
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
        include: { memberships: true }
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

      const publicUser = toPublicUser(prismaUser);
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

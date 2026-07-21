import { randomInt, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { RuntimeConfig } from "@onshell/config";
import { normalizeSlug, validatePassword } from "@onshell/shared";
import type { User as PublicUser } from "@onshell/shared";
import prismaPkg, { type Prisma } from "@prisma/client";
const { AuthProvider, Role } = prismaPkg;
import bcrypt from "bcryptjs";
import { generateSecret, generateURI, verify } from "otplib";
import QRCode from "qrcode";
import { z } from "zod";
import { getAuthenticatedUser } from "../../lib/current-user.js";
import { sendTransactionalEmail, isSmtpEnabled } from "../../lib/email.js";
import { encryptSecret, decryptSecret } from "../../lib/encryption.js";
import { prisma } from "../../lib/prisma.js";
import { toPublicUser, type UserWithMembership } from "../../lib/prisma-mappers.js";
import { handleRouteError } from "../../lib/reply.js";
import { store } from "../../lib/store.js";
import { createRefreshToken, hashToken, signAccessToken } from "../../lib/token.js";

const EMAIL_OTP_TTL_MS = 10 * 60 * 1000;
const PASSWORD_RESET_TTL_MS = 15 * 60 * 1000;
const CHALLENGE_RESEND_INTERVAL_MS = 30 * 1000;
const MAX_CHALLENGE_ATTEMPTS = 5;

const registerSchema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  password: z.string().min(1),
  organizationName: z.string().min(2).default("Onshell.cloud")
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  totpCode: z.string().optional()
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
  email: z.string().email()
});

const resetPasswordSchema = z.object({
  email: z.string().email(),
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

export async function issueTokens(reply: FastifyReply, config: RuntimeConfig, user: PublicUser) {
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
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  await prisma.refreshToken.create({
    data: {
      userId: user.id,
      tokenHash: hashToken(refreshToken),
      expiresAt
    }
  });

  const secure = config.nodeEnv === "production";
  reply.setCookie("access_token", accessToken, {
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    maxAge: 12 * 60 * 60
  });
  reply.setCookie("refresh_token", refreshToken, {
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    maxAge: 30 * 24 * 60 * 60
  });

  return {
    user,
    accessToken,
    refreshToken
  };
}

function createTwoFactorChallenge(userId: string, method: "totp" | "email" = "totp") {
  const challengeId = `mfa_${randomUUID()}`;
  store.pendingTwoFactorChallenges[challengeId] = {
    userId,
    createdAt: new Date().toISOString(),
    method
  };

  return challengeId;
}

function generateEmailOtp() {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

const pendingEmailTwoFactorSetups: Record<string, { otpHash: string; expiresAt: string }> = {};

async function sendChallengeEmailOtp(
  app: FastifyInstance,
  config: RuntimeConfig,
  challengeId: string,
  recipient: string
) {
  const challenge = store.pendingTwoFactorChallenges[challengeId];
  if (!challenge) return false;

  const otp = generateEmailOtp();
  challenge.emailOtpHash = hashToken(otp);
  challenge.emailOtpExpiresAt = new Date(Date.now() + EMAIL_OTP_TTL_MS).toISOString();
  challenge.lastEmailSentAt = new Date().toISOString();

  return sendTransactionalEmail({
    masterEncryptionKey: config.masterEncryptionKey,
    recipient,
    subject: "Your Onshell.cloud sign-in code",
    text: `Your Onshell.cloud sign-in code is ${otp}. It expires in 10 minutes.`,
    html: `<p>Your Onshell.cloud sign-in code is <strong>${otp}</strong>. It expires in 10 minutes.</p>`,
    logger: app.log
  });
}

function verifyEmailOtp(code: string, otpHash?: string, expiresAt?: string) {
  if (!otpHash || !expiresAt) return false;
  if (new Date(expiresAt).getTime() < Date.now()) return false;
  return hashToken(code) === otpHash;
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
  store.googleOAuthStates[state] = {
    createdAt: new Date().toISOString(),
    returnTo
  };

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

async function upsertGoogleUser(profile: GoogleProfile) {
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
  app.post("/auth/register", async (request, reply) => {
    try {
      const body = registerSchema.parse(request.body);
      const passwordCheck = validatePassword(body.password);
      if (!passwordCheck.valid) {
        return reply.code(400).send({ error: "password_policy_violation", errors: passwordCheck.errors });
      }

      const existing = await prisma.user.findUnique({ where: { email: body.email } });
      if (existing) return reply.code(409).send({ error: "email_already_registered" });

      const slug = await uniqueOrganizationSlug(body.organizationName);
      const passwordHash = await bcrypt.hash(body.password, 12);
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
      await createAudit({
        organizationId: user.organizationId,
        actorId: user.id,
        action: "auth.register",
        targetType: "user",
        targetId: user.id,
        ipAddress: request.ip
      });

      return reply.code(201).send(await issueTokens(reply, config, user));
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });

  app.post("/auth/login", async (request, reply) => {
    try {
      const body = loginSchema.parse(request.body);
      const prismaUser = await prisma.user.findUnique({
        where: { email: body.email },
        include: { memberships: true }
      });
      if (!prismaUser?.passwordHash) return reply.code(401).send({ error: "invalid_credentials" });

      const passwordValid = await bcrypt.compare(body.password, prismaUser.passwordHash);
      const publicUser = toPublicUser(prismaUser);
      if (!passwordValid) {
        await createAudit({
          organizationId: publicUser.organizationId,
          actorId: publicUser.id,
          action: "auth.login.failed",
          targetType: "user",
          targetId: publicUser.id,
          ipAddress: request.ip,
          metadata: { reason: "invalid_password" }
        });
        return reply.code(401).send({ error: "invalid_credentials" });
      }

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

      return issueTokens(reply, config, user);
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });

  app.post("/auth/2fa/complete", async (request, reply) => {
    try {
      const body = completeTwoFactorSchema.parse(request.body);
      const code = body.code ?? body.totpCode;
      if (!code) return reply.code(400).send({ error: "two_factor_code_required" });

      const challenge = store.pendingTwoFactorChallenges[body.challengeId];
      if (!challenge) return reply.code(404).send({ error: "two_factor_challenge_not_found" });

      challenge.attempts = (challenge.attempts ?? 0) + 1;
      if (challenge.attempts > MAX_CHALLENGE_ATTEMPTS) {
        delete store.pendingTwoFactorChallenges[body.challengeId];
        return reply.code(429).send({ error: "too_many_attempts" });
      }

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
        return reply.code(401).send({ error: "invalid_two_factor_code" });
      }

      delete store.pendingTwoFactorChallenges[body.challengeId];
      const user = await addAuthMethods(toPublicUser(prismaUser), prismaUser);
      await createAudit({
        organizationId: user.organizationId,
        actorId: user.id,
        action: "auth.2fa.complete",
        targetType: "user",
        targetId: user.id,
        ipAddress: request.ip
      });

      return issueTokens(reply, config, user);
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });

  app.post("/auth/2fa/challenge/resend", async (request, reply) => {
    try {
      const body = resendChallengeSchema.parse(request.body);
      const challenge = store.pendingTwoFactorChallenges[body.challengeId];
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
    store.pendingTwoFactorSetups[user.id] = secret;

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
      const pendingSecret = store.pendingTwoFactorSetups[user.id];
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

      delete store.pendingTwoFactorSetups[user.id];
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

  app.post("/auth/2fa/email/enable", async (request, reply) => {
    try {
      const user = await getAuthenticatedUser(request, config);
      if (!user) return reply.code(401).send({ error: "unauthorized" });

      if (!(await isSmtpEnabled())) {
        return reply.code(503).send({
          error: "smtp_not_configured",
          message: "Email delivery is not configured. Ask a platform admin to enable SMTP."
        });
      }

      const otp = generateEmailOtp();
      pendingEmailTwoFactorSetups[user.id] = {
        otpHash: hashToken(otp),
        expiresAt: new Date(Date.now() + EMAIL_OTP_TTL_MS).toISOString()
      };

      const sent = await sendTransactionalEmail({
        masterEncryptionKey: config.masterEncryptionKey,
        recipient: user.email,
        subject: "Your Onshell.cloud verification code",
        text: `Your Onshell.cloud verification code is ${otp}. It expires in 10 minutes.`,
        html: `<p>Your Onshell.cloud verification code is <strong>${otp}</strong>. It expires in 10 minutes.</p>`,
        logger: app.log
      });
      if (!sent) {
        delete pendingEmailTwoFactorSetups[user.id];
        return reply.code(502).send({ error: "email_delivery_failed" });
      }

      return { sent: true, expiresInSeconds: EMAIL_OTP_TTL_MS / 1000 };
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });

  app.post("/auth/2fa/email/verify", async (request, reply) => {
    try {
      const user = await getAuthenticatedUser(request, config);
      if (!user) return reply.code(401).send({ error: "unauthorized" });

      const body = emailTwoFactorVerifySchema.parse(request.body);
      const pending = pendingEmailTwoFactorSetups[user.id];
      if (!pending) return reply.code(404).send({ error: "two_factor_email_setup_not_started" });
      if (!verifyEmailOtp(body.code, pending.otpHash, pending.expiresAt)) {
        return reply.code(401).send({ error: "invalid_two_factor_code" });
      }

      delete pendingEmailTwoFactorSetups[user.id];
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

  app.post("/auth/2fa/disable", async (request, reply) => {
    try {
      const user = await getAuthenticatedUser(request, config);
      if (!user) return reply.code(401).send({ error: "unauthorized" });

      const body = verifyTwoFactorSchema.parse(request.body);
      const method = await getTwoFactorMethod(user.id, user.twoFactorEnabled);
      const codeValid =
        method === "email"
          ? verifyEmailOtp(
              body.totpCode,
              pendingEmailTwoFactorSetups[user.id]?.otpHash,
              pendingEmailTwoFactorSetups[user.id]?.expiresAt
            )
          : await verifyTotp(config, user.id, body.totpCode);
      if (!codeValid) {
        return reply.code(401).send({ error: "invalid_two_factor_code" });
      }

      delete pendingEmailTwoFactorSetups[user.id];

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
      const state = store.googleOAuthStates[query.state];
      if (!state) return reply.redirect(`${config.publicBaseUrl}/login?error=invalid-google-state`);

      delete store.googleOAuthStates[query.state];
      const googleProfile = await getGoogleProfile(config, query.code);
      const prismaUser = await upsertGoogleUser(googleProfile);
      const user = await addAuthMethods(toPublicUser(prismaUser), prismaUser);

      await createAudit({
        organizationId: user.organizationId,
        actorId: user.id,
        action: "auth.google.login",
        targetType: "user",
        targetId: user.id,
        ipAddress: request.ip,
        metadata: { emailVerified: Boolean(googleProfile.email_verified) }
      });

      if (prismaUser.twoFactorEnabled) {
        const method = (await getTwoFactorMethod(prismaUser.id, true)) ?? "totp";
        const challengeId = createTwoFactorChallenge(prismaUser.id, method);
        if (method === "email") {
          await sendChallengeEmailOtp(app, config, challengeId, prismaUser.email);
        }
        return reply.redirect(`${config.publicBaseUrl}/login?challengeId=${challengeId}&method=${method}`);
      }

      await issueTokens(reply, config, user);
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
      if (!tokenRow || tokenRow.revokedAt || tokenRow.expiresAt.getTime() <= Date.now()) {
        reply.clearCookie("access_token", { path: "/" });
        reply.clearCookie("refresh_token", { path: "/" });
        return reply.code(401).send({ error: "invalid_refresh_token" });
      }

      await prisma.refreshToken.update({
        where: { id: tokenRow.id },
        data: { revokedAt: new Date() }
      });

      const user = await addAuthMethods(toPublicUser(tokenRow.user), tokenRow.user);
      return issueTokens(reply, config, user);
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });

  app.post("/auth/password/forgot", async (request, reply) => {
    try {
      const body = forgotPasswordSchema.parse(request.body);
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

  app.post("/auth/password/reset", async (request, reply) => {
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
        prisma.refreshToken.updateMany({
          where: { userId: prismaUser.id, revokedAt: null },
          data: { revokedAt: new Date() }
        })
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

  app.post("/auth/password/change", async (request, reply) => {
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
        prisma.refreshToken.updateMany({
          where: { userId: prismaUser.id, revokedAt: null },
          data: { revokedAt: new Date() }
        })
      ]);

      await createAudit({
        organizationId: user.organizationId,
        actorId: user.id,
        action: "auth.password.change",
        targetType: "user",
        targetId: user.id,
        ipAddress: request.ip
      });

      return issueTokens(reply, config, user);
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });

  app.post("/auth/logout", async (request, reply) => {
    const refreshToken = request.cookies?.refresh_token;
    if (refreshToken) {
      await prisma.refreshToken.updateMany({
        where: { tokenHash: hashToken(refreshToken), revokedAt: null },
        data: { revokedAt: new Date() }
      });
    }

    reply.clearCookie("access_token", { path: "/" });
    reply.clearCookie("refresh_token", { path: "/" });
    return { ok: true };
  });
}

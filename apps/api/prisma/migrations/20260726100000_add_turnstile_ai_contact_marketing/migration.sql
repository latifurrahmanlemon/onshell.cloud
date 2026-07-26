-- AlterTable: referral programme + growth attribution on User
ALTER TABLE `User` ADD COLUMN `referralCode` VARCHAR(191) NULL,
    ADD COLUMN `referredById` VARCHAR(191) NULL;

CREATE UNIQUE INDEX `User_referralCode_key` ON `User`(`referralCode`);
CREATE INDEX `User_referredById_idx` ON `User`(`referredById`);

ALTER TABLE `User` ADD CONSTRAINT `User_referredById_fkey`
    FOREIGN KEY (`referredById`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterTable: freemium + marketing metadata on Plan
ALTER TABLE `Plan` ADD COLUMN `isFree` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `isFeatured` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `badge` VARCHAR(191) NULL,
    ADD COLUMN `tagline` VARCHAR(191) NULL,
    ADD COLUMN `trialDays` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `monthlyAiMessages` INTEGER NULL;

-- AlterTable: refresh-token lookups are by hash on every refresh; make them
-- indexed and unique so a replayed hash cannot match two rows.
DELETE `a` FROM `RefreshToken` `a`
    INNER JOIN `RefreshToken` `b`
    ON `a`.`tokenHash` = `b`.`tokenHash` AND `a`.`createdAt` < `b`.`createdAt`;

CREATE UNIQUE INDEX `RefreshToken_tokenHash_key` ON `RefreshToken`(`tokenHash`);
CREATE INDEX `RefreshToken_userId_revokedAt_idx` ON `RefreshToken`(`userId`, `revokedAt`);
CREATE INDEX `PasswordResetToken_userId_tokenHash_idx` ON `PasswordResetToken`(`userId`, `tokenHash`);

-- CreateTable
CREATE TABLE `TurnstileSetting` (
    `id` VARCHAR(191) NOT NULL DEFAULT 'global',
    `siteKey` VARCHAR(191) NULL,
    `encryptedSecretKey` TEXT NULL,
    `secretKeyNonce` VARCHAR(191) NULL,
    `secretKeyAuthTag` VARCHAR(191) NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT false,
    `protectSignup` BOOLEAN NOT NULL DEFAULT true,
    `protectLogin` BOOLEAN NOT NULL DEFAULT true,
    `protectPasswordReset` BOOLEAN NOT NULL DEFAULT true,
    `protectContact` BOOLEAN NOT NULL DEFAULT true,
    `protectCheckout` BOOLEAN NOT NULL DEFAULT true,
    `protectNewsletter` BOOLEAN NOT NULL DEFAULT true,
    `updatedById` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AiSetting` (
    `id` VARCHAR(191) NOT NULL DEFAULT 'global',
    `provider` VARCHAR(191) NOT NULL DEFAULT 'openai',
    `model` VARCHAR(191) NOT NULL DEFAULT 'gpt-4o-mini',
    `encryptedApiKey` TEXT NULL,
    `apiKeyNonce` VARCHAR(191) NULL,
    `apiKeyAuthTag` VARCHAR(191) NULL,
    `baseUrl` VARCHAR(191) NULL,
    `systemPrompt` TEXT NOT NULL,
    `temperature` INTEGER NOT NULL DEFAULT 20,
    `maxOutputTokens` INTEGER NOT NULL DEFAULT 900,
    `monthlyMessageCap` INTEGER NOT NULL DEFAULT 100,
    `enabled` BOOLEAN NOT NULL DEFAULT false,
    `updatedById` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AiThread` (
    `id` VARCHAR(191) NOT NULL,
    `organizationId` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `title` VARCHAR(191) NOT NULL,
    `archivedAt` DATETIME(3) NULL,
    `lastMessageAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `messageCount` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `AiThread_organizationId_lastMessageAt_idx`(`organizationId`, `lastMessageAt`),
    INDEX `AiThread_userId_lastMessageAt_idx`(`userId`, `lastMessageAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AiMessage` (
    `id` VARCHAR(191) NOT NULL,
    `threadId` VARCHAR(191) NOT NULL,
    `role` ENUM('USER', 'ASSISTANT', 'SYSTEM') NOT NULL,
    `content` TEXT NOT NULL,
    `model` VARCHAR(191) NULL,
    `promptTokens` INTEGER NULL,
    `outputTokens` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `AiMessage_threadId_createdAt_idx`(`threadId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ContactMessage` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `email` VARCHAR(191) NOT NULL,
    `company` VARCHAR(191) NULL,
    `topic` VARCHAR(191) NOT NULL DEFAULT 'general',
    `message` TEXT NOT NULL,
    `status` ENUM('NEW', 'OPEN', 'RESOLVED', 'SPAM') NOT NULL DEFAULT 'NEW',
    `adminNotes` TEXT NULL,
    `ipAddress` VARCHAR(191) NULL,
    `userAgent` TEXT NULL,
    `submittedById` VARCHAR(191) NULL,
    `handledById` VARCHAR(191) NULL,
    `handledAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ContactMessage_status_createdAt_idx`(`status`, `createdAt`),
    INDEX `ContactMessage_email_idx`(`email`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `NewsletterSubscriber` (
    `id` VARCHAR(191) NOT NULL,
    `email` VARCHAR(191) NOT NULL,
    `source` VARCHAR(191) NOT NULL DEFAULT 'footer',
    `confirmedAt` DATETIME(3) NULL,
    `unsubscribedAt` DATETIME(3) NULL,
    `ipAddress` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `NewsletterSubscriber_email_key`(`email`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `AiThread` ADD CONSTRAINT `AiThread_organizationId_fkey`
    FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `AiThread` ADD CONSTRAINT `AiThread_userId_fkey`
    FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `AiMessage` ADD CONSTRAINT `AiMessage_threadId_fkey`
    FOREIGN KEY (`threadId`) REFERENCES `AiThread`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `ContactMessage` ADD CONSTRAINT `ContactMessage_handledById_fkey`
    FOREIGN KEY (`handledById`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

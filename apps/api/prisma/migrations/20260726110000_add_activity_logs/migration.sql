-- CreateTable
CREATE TABLE `VisitorLog` (
    `id` VARCHAR(191) NOT NULL,
    `path` VARCHAR(191) NOT NULL,
    `referrer` TEXT NULL,
    `userId` VARCHAR(191) NULL,
    `ipAddress` VARCHAR(191) NULL,
    `userAgent` TEXT NULL,
    `country` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `VisitorLog_createdAt_idx`(`createdAt`),
    INDEX `VisitorLog_path_createdAt_idx`(`path`, `createdAt`),
    INDEX `VisitorLog_userId_createdAt_idx`(`userId`, `createdAt`),
    INDEX `VisitorLog_country_createdAt_idx`(`country`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AuthEventLog` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NULL,
    `email` VARCHAR(191) NOT NULL,
    `event` ENUM('LOGIN', 'LOGOUT', 'LOGIN_FAILED', 'TWO_FACTOR_COMPLETED') NOT NULL,
    `method` ENUM('PASSWORD', 'GOOGLE', 'TWO_FACTOR', 'SESSION') NOT NULL,
    `success` BOOLEAN NOT NULL,
    `reason` VARCHAR(191) NULL,
    `ipAddress` VARCHAR(191) NULL,
    `userAgent` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `AuthEventLog_createdAt_idx`(`createdAt`),
    INDEX `AuthEventLog_userId_createdAt_idx`(`userId`, `createdAt`),
    INDEX `AuthEventLog_event_createdAt_idx`(`event`, `createdAt`),
    INDEX `AuthEventLog_email_createdAt_idx`(`email`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `EmailLog` (
    `id` VARCHAR(191) NOT NULL,
    `recipient` VARCHAR(191) NOT NULL,
    `subject` VARCHAR(191) NOT NULL,
    `kind` VARCHAR(191) NOT NULL DEFAULT 'transactional',
    `status` ENUM('SENT', 'FAILED', 'SKIPPED') NOT NULL,
    `providerMessageId` VARCHAR(191) NULL,
    `error` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `EmailLog_createdAt_idx`(`createdAt`),
    INDEX `EmailLog_status_createdAt_idx`(`status`, `createdAt`),
    INDEX `EmailLog_recipient_createdAt_idx`(`recipient`, `createdAt`),
    INDEX `EmailLog_kind_createdAt_idx`(`kind`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `VisitorLog` ADD CONSTRAINT `VisitorLog_userId_fkey`
    FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `AuthEventLog` ADD CONSTRAINT `AuthEventLog_userId_fkey`
    FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

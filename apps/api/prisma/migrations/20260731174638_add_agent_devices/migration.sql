-- AlterTable
ALTER TABLE `host` ADD COLUMN `isAgent` BOOLEAN NOT NULL DEFAULT false,
    MODIFY `type` ENUM('SSH', 'RDP', 'VNC', 'AGENT') NOT NULL;

-- CreateTable
CREATE TABLE `AgentDevice` (
    `id` VARCHAR(191) NOT NULL,
    `organizationId` VARCHAR(191) NOT NULL,
    `hostId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `fingerprint` VARCHAR(191) NOT NULL,
    `platform` VARCHAR(191) NOT NULL,
    `arch` VARCHAR(191) NOT NULL,
    `osVersion` VARCHAR(191) NULL,
    `agentVersion` VARCHAR(191) NULL,
    `hostname` VARCHAR(191) NULL,
    `tokenHash` VARCHAR(191) NOT NULL,
    `lastSeenAt` DATETIME(3) NULL,
    `enrolledById` VARCHAR(191) NOT NULL,
    `revokedAt` DATETIME(3) NULL,
    `allowShell` BOOLEAN NOT NULL DEFAULT true,
    `allowFiles` BOOLEAN NOT NULL DEFAULT true,
    `requireApproval` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `AgentDevice_hostId_key`(`hostId`),
    UNIQUE INDEX `AgentDevice_tokenHash_key`(`tokenHash`),
    INDEX `AgentDevice_organizationId_idx`(`organizationId`),
    INDEX `AgentDevice_enrolledById_idx`(`enrolledById`),
    UNIQUE INDEX `AgentDevice_organizationId_fingerprint_key`(`organizationId`, `fingerprint`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AgentPairingCode` (
    `id` VARCHAR(191) NOT NULL,
    `organizationId` VARCHAR(191) NOT NULL,
    `createdById` VARCHAR(191) NOT NULL,
    `codeHash` VARCHAR(191) NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `consumedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `AgentPairingCode_codeHash_key`(`codeHash`),
    INDEX `AgentPairingCode_organizationId_idx`(`organizationId`),
    INDEX `AgentPairingCode_createdById_idx`(`createdById`),
    INDEX `AgentPairingCode_expiresAt_idx`(`expiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `AgentDevice` ADD CONSTRAINT `AgentDevice_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AgentDevice` ADD CONSTRAINT `AgentDevice_hostId_fkey` FOREIGN KEY (`hostId`) REFERENCES `Host`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AgentDevice` ADD CONSTRAINT `AgentDevice_enrolledById_fkey` FOREIGN KEY (`enrolledById`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AgentPairingCode` ADD CONSTRAINT `AgentPairingCode_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AgentPairingCode` ADD CONSTRAINT `AgentPairingCode_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

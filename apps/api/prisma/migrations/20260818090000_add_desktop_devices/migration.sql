-- Desktop devices and the workspace switch that governs direct connections.
--
-- A desktop device is not an agent. An agent serves its machine's shell to the
-- workspace and therefore owns a Host row; this is the opposite direction — a
-- copy of the app someone uses the workspace *from*. It exists as a row because
-- direct connections hand decrypted credential material to that machine, and
-- "which machines have been handed material, and can I cut one off" has to be
-- answerable after the fact.
CREATE TABLE `DesktopDevice` (
    `id` VARCHAR(191) NOT NULL,
    `organizationId` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    -- Spoofable by design: it recognises a reinstall so the list does not grow a
    -- row per launch. Never trusted for authentication.
    `fingerprint` VARCHAR(191) NOT NULL,
    `platform` VARCHAR(191) NOT NULL,
    `appVersion` VARCHAR(191) NULL,
    -- SHA-256 of the enrolment secret. The secret itself is returned once and
    -- lives in the machine's keychain.
    `secretHash` VARCHAR(191) NOT NULL,
    `lastSeenAt` DATETIME(3) NULL,
    -- Revoked devices keep their row so the audit trail still names the machine.
    `revokedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `DesktopDevice_secretHash_key`(`secretHash`),
    -- One row per machine per person: two accounts on one laptop are two
    -- devices, because revoking one must not cut off the other.
    UNIQUE INDEX `DesktopDevice_userId_fingerprint_key`(`userId`, `fingerprint`),
    INDEX `DesktopDevice_organizationId_idx`(`organizationId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `DesktopDevice` ADD CONSTRAINT `DesktopDevice_organizationId_fkey`
    FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `DesktopDevice` ADD CONSTRAINT `DesktopDevice_userId_fkey`
    FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- Direct connections are on by default: they are the more private path, because
-- the bytes go from the member's machine to their host without passing through
-- the gateway at all. A workspace that needs every byte through a relay it can
-- inspect turns this off, and every existing workspace keeps today's behaviour
-- either way — before this migration there was no direct path to disable.
ALTER TABLE `Organization` ADD COLUMN `allowDirectConnect` BOOLEAN NOT NULL DEFAULT true;

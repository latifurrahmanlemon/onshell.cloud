-- CreateTable: per-host access control for organization members.
--
-- `scopeKey` mirrors the grant target (`hostId`, or '*' for the org-wide row)
-- purely so the unique index below can be enforced: MySQL treats NULLs as
-- distinct, so a unique index over `hostId` would let one member accumulate
-- several "all hosts" rows.
CREATE TABLE `HostAccessGrant` (
    `id` VARCHAR(191) NOT NULL,
    `organizationId` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `hostId` VARCHAR(191) NULL,
    `allHosts` BOOLEAN NOT NULL DEFAULT false,
    `scopeKey` VARCHAR(191) NOT NULL,
    `grantedById` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `HostAccessGrant_organizationId_userId_scopeKey_key`(`organizationId`, `userId`, `scopeKey`),
    INDEX `HostAccessGrant_organizationId_userId_idx`(`organizationId`, `userId`),
    INDEX `HostAccessGrant_hostId_idx`(`hostId`),
    INDEX `HostAccessGrant_grantedById_idx`(`grantedById`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `HostAccessGrant` ADD CONSTRAINT `HostAccessGrant_organizationId_fkey`
    FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `HostAccessGrant` ADD CONSTRAINT `HostAccessGrant_userId_fkey`
    FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `HostAccessGrant` ADD CONSTRAINT `HostAccessGrant_hostId_fkey`
    FOREIGN KEY (`hostId`) REFERENCES `Host`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `HostAccessGrant` ADD CONSTRAINT `HostAccessGrant_grantedById_fkey`
    FOREIGN KEY (`grantedById`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- Existing members keep the access they had before this feature shipped, so the
-- upgrade does not silently cut anyone off from their hosts. Owners and admins
-- are skipped because they bypass this table entirely.
INSERT INTO `HostAccessGrant` (`id`, `organizationId`, `userId`, `hostId`, `allHosts`, `scopeKey`, `grantedById`, `createdAt`)
SELECT UUID(), `organizationId`, `userId`, NULL, true, '*', NULL, CURRENT_TIMESTAMP(3)
FROM `OrganizationMember`
WHERE `role` NOT IN ('OWNER', 'ADMIN');

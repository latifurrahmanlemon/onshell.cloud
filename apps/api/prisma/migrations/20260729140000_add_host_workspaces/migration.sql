-- CreateTable: named sets of hosts that open as several terminals at once.
--
-- Scoped to the organization, not to a user: the sets worth saving ("prod web
-- tier") describe the estate, so every member should be able to reuse one. What
-- a member actually sees inside a workspace is still narrowed by
-- `HostAccessGrant` at read time — see lib/host-access.ts.
--
-- `createdById` is nullable so the row survives the account that made it; a
-- shared workspace disappearing because its author left would be a surprise.
CREATE TABLE `HostWorkspace` (
    `id` VARCHAR(191) NOT NULL,
    `organizationId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `description` TEXT NULL,
    `createdById` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    -- Two workspaces with the same name are indistinguishable in the picker, and
    -- the collision is usually a double-submit rather than an intent.
    UNIQUE INDEX `HostWorkspace_organizationId_name_key`(`organizationId`, `name`),
    INDEX `HostWorkspace_createdById_idx`(`createdById`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable: workspace-to-host membership.
--
-- An explicit join table rather than Prisma's implicit many-to-many so that
-- `position` has somewhere to live: the order the terminals open in is part of
-- what the operator saved ("canary first"), and it has to survive a reload.
CREATE TABLE `HostWorkspaceHost` (
    `id` VARCHAR(191) NOT NULL,
    `workspaceId` VARCHAR(191) NOT NULL,
    `hostId` VARCHAR(191) NOT NULL,
    `position` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    -- The same host twice would open a duplicate terminal for no reason.
    UNIQUE INDEX `HostWorkspaceHost_workspaceId_hostId_key`(`workspaceId`, `hostId`),
    -- Lets a host delete cascade through an index instead of scanning every
    -- workspace membership in the install.
    INDEX `HostWorkspaceHost_hostId_idx`(`hostId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `HostWorkspace` ADD CONSTRAINT `HostWorkspace_organizationId_fkey`
    FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `HostWorkspace` ADD CONSTRAINT `HostWorkspace_createdById_fkey`
    FOREIGN KEY (`createdById`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- Membership rows are meaningless without their workspace, and a removed host
-- should simply drop out of every workspace that listed it — hence CASCADE on
-- both sides rather than a nullable reference.
ALTER TABLE `HostWorkspaceHost` ADD CONSTRAINT `HostWorkspaceHost_workspaceId_fkey`
    FOREIGN KEY (`workspaceId`) REFERENCES `HostWorkspace`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `HostWorkspaceHost` ADD CONSTRAINT `HostWorkspaceHost_hostId_fkey`
    FOREIGN KEY (`hostId`) REFERENCES `Host`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

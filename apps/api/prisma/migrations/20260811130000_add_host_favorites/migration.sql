-- CreateTable: one operator's pinned hosts.
--
-- Personal rather than organization-wide: a favourite records how one person
-- works, so two members can pin different halves of the same fleet. It never
-- widens access — routes still read hosts through `accessibleHostFilter`, so a
-- pin on a host whose grant is revoked simply stops coming back.
--
-- Both sides CASCADE: a pin is meaningless without the person or the host.
CREATE TABLE `HostFavorite` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `hostId` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    -- Pinning twice is the same as pinning once.
    UNIQUE INDEX `HostFavorite_userId_hostId_key`(`userId`, `hostId`),
    -- Lets a host delete cascade through an index rather than a table scan.
    INDEX `HostFavorite_hostId_idx`(`hostId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `HostFavorite` ADD CONSTRAINT `HostFavorite_userId_fkey`
    FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `HostFavorite` ADD CONSTRAINT `HostFavorite_hostId_fkey`
    FOREIGN KEY (`hostId`) REFERENCES `Host`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE `Note` (
  `id` VARCHAR(191) NOT NULL,
  `organizationId` VARCHAR(191) NOT NULL,
  `ownerId` VARCHAR(191) NOT NULL,
  `title` VARCHAR(200) NOT NULL,
  `body` TEXT NOT NULL,
  `color` VARCHAR(20) NOT NULL DEFAULT 'default',
  `pinned` BOOLEAN NOT NULL DEFAULT false,
  `archived` BOOLEAN NOT NULL DEFAULT false,
  `trashedAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  INDEX `Note_organizationId_ownerId_updatedAt_idx` (`organizationId`, `ownerId`, `updatedAt`),
  CONSTRAINT `Note_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `Note_ownerId_fkey` FOREIGN KEY (`ownerId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `NoteRevision` (
  `id` VARCHAR(191) NOT NULL,
  `noteId` VARCHAR(191) NOT NULL,
  `actorId` VARCHAR(191) NOT NULL,
  `action` VARCHAR(32) NOT NULL,
  `title` VARCHAR(200) NOT NULL,
  `body` TEXT NOT NULL,
  `color` VARCHAR(20) NOT NULL,
  `pinned` BOOLEAN NOT NULL,
  `archived` BOOLEAN NOT NULL,
  `trashed` BOOLEAN NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  INDEX `NoteRevision_noteId_createdAt_idx` (`noteId`, `createdAt`),
  INDEX `NoteRevision_actorId_createdAt_idx` (`actorId`, `createdAt`),
  CONSTRAINT `NoteRevision_noteId_fkey` FOREIGN KEY (`noteId`) REFERENCES `Note`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `NoteRevision_actorId_fkey` FOREIGN KEY (`actorId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

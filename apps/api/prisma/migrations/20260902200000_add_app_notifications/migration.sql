CREATE TABLE `AppNotification` (
  `id` VARCHAR(191) NOT NULL,
  `title` VARCHAR(191) NOT NULL,
  `message` TEXT NOT NULL,
  `actionUrl` VARCHAR(191) NULL,
  `publishedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `expiresAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  INDEX `AppNotification_publishedAt_idx` (`publishedAt`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `NotificationRead` (
  `notificationId` VARCHAR(191) NOT NULL,
  `userId` VARCHAR(191) NOT NULL,
  `readAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`notificationId`, `userId`),
  INDEX `NotificationRead_userId_readAt_idx` (`userId`, `readAt`),
  CONSTRAINT `NotificationRead_notificationId_fkey` FOREIGN KEY (`notificationId`) REFERENCES `AppNotification`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `NotificationRead_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

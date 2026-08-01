-- DropForeignKey
ALTER TABLE `agentdevice` DROP FOREIGN KEY `AgentDevice_enrolledById_fkey`;

-- DropForeignKey
ALTER TABLE `agentpairingcode` DROP FOREIGN KEY `AgentPairingCode_createdById_fkey`;

-- AlterTable
ALTER TABLE `agentdevice` MODIFY `enrolledById` VARCHAR(191) NULL;

-- AddForeignKey
ALTER TABLE `AgentDevice` ADD CONSTRAINT `AgentDevice_enrolledById_fkey` FOREIGN KEY (`enrolledById`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AgentPairingCode` ADD CONSTRAINT `AgentPairingCode_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

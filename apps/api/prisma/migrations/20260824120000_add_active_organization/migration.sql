-- The active workspace, for people who belong to more than one.
--
-- Before this, the answer was `user.memberships[0]`, which looked arbitrary and
-- was not: the load resolves through `OrganizationMember_userId_fkey` in
-- (userId, PK) order and the PK is a time-prefixed cuid, so it was always the
-- *oldest* membership. Anyone who accepted an invitation to a second workspace
-- was therefore pinned to their first one for good — invited, granted a host,
-- and unable to see it.
--
-- Two columns, because "which workspace" has to survive two different gaps.
-- `RefreshToken.organizationId` carries it across a token rotation: the clients
-- refresh on any 401 and on tab focus, so a choice held only in the access JWT
-- would be silently reset by a background refresh. `User.lastActiveOrganizationId`
-- carries it across a sign-out, so signing in again lands where the person was.
--
-- Both are nullable so this applies to every existing row: sessions minted
-- before today name no workspace, and the code falls back to the oldest
-- membership for them exactly as it did before.

-- AlterTable
ALTER TABLE `RefreshToken` ADD COLUMN `organizationId` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `User` ADD COLUMN `lastActiveOrganizationId` VARCHAR(191) NULL;

-- CreateIndex
CREATE INDEX `RefreshToken_organizationId_idx` ON `RefreshToken`(`organizationId`);

-- CreateIndex
CREATE INDEX `User_lastActiveOrganizationId_idx` ON `User`(`lastActiveOrganizationId`);

-- AddForeignKey
--
-- SET NULL rather than CASCADE on both: deleting a workspace must not delete the
-- sessions of people who are also in another one, and must not delete the
-- accounts of people whose last-active workspace it happened to be. Losing the
-- preference is the correct outcome — the fallback then applies.
ALTER TABLE `RefreshToken` ADD CONSTRAINT `RefreshToken_organizationId_fkey`
    FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `User` ADD CONSTRAINT `User_lastActiveOrganizationId_fkey`
    FOREIGN KEY (`lastActiveOrganizationId`) REFERENCES `Organization`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- Existing sessions keep working and keep the workspace they are already in:
-- the JWT they hold still names it, and the first refresh writes it back onto
-- the row. Backfilling from `memberships[0]` here would instead have written the
-- very wrong answer this migration exists to stop producing.

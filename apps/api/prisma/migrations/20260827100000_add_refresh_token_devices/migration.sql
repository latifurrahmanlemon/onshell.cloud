-- "Your signed-in devices", and the ability to sign one of them out.
--
-- A refresh token is replaced on every use, so the rows in this table are a
-- chain rather than a list of sessions: one browser left open for a fortnight
-- can be twenty rows, each of which looks — from `createdAt` alone — like a
-- brand-new sign-in that happened minutes ago. That is why the account settings
-- had nothing to show and nothing to revoke.
--
-- `familyId` names the chain and is carried across every rotation, so one
-- sign-in is one row in the console and one target for the revoke button.
-- `startedAt` is carried with it, because `createdAt` can only ever answer "when
-- was this token minted", which is the wrong question. The remaining three are
-- refreshed on every rotation so the list stays current: an IP that moves
-- between home and office should move in the list too.
--
-- All nullable, because every column here is being added to rows that already
-- exist. There is no backfill and there deliberately is not one: nothing was
-- recorded about those sessions, so any value invented here would be a guess
-- shown to the user as a fact — under a feature whose whole purpose is telling
-- them which machines are signed in. They are listed as one unnamed session
-- each, which is true, and each of them can still be revoked. They also age out
-- on their own, since the next refresh mints a row that does have a family.

-- AlterTable
ALTER TABLE `RefreshToken`
    ADD COLUMN `familyId` VARCHAR(191) NULL,
    ADD COLUMN `startedAt` DATETIME(3) NULL,
    ADD COLUMN `lastUsedAt` DATETIME(3) NULL,
    ADD COLUMN `userAgent` TEXT NULL,
    ADD COLUMN `ipAddress` VARCHAR(191) NULL;

-- CreateIndex
--
-- (userId, familyId): the session list reads every live row for one account and
-- groups by family, and revoking reads one family for one account. Never a bare
-- familyId lookup — a family id from a request must not be able to reach another
-- account's rows, so the user id is always half of the query.
CREATE INDEX `RefreshToken_userId_familyId_idx` ON `RefreshToken`(`userId`, `familyId`);

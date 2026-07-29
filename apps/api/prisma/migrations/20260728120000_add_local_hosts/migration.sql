-- AlterTable: marks the built-in "this machine" host.
--
-- A local host runs its shell and file listing on the gateway process itself, so
-- it needs no credential and opens no network connection. Existing rows are all
-- remote, hence the false default.
ALTER TABLE `Host` ADD COLUMN `isLocal` BOOLEAN NOT NULL DEFAULT false;

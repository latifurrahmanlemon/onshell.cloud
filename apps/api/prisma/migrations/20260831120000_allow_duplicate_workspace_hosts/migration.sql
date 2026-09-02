-- A workspace entry represents a terminal pane, so the same host may appear
-- more than once. Ordering remains unique within each workspace.
DROP INDEX `HostWorkspaceHost_workspaceId_hostId_key` ON `HostWorkspaceHost`;
CREATE UNIQUE INDEX `HostWorkspaceHost_workspaceId_position_key`
  ON `HostWorkspaceHost`(`workspaceId`, `position`);

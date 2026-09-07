-- Concurrent sessions are unlimited for all existing and future plans.
UPDATE `Plan` SET `maxConcurrentSessions` = NULL;

ALTER TABLE `monitors`
  DROP CONSTRAINT `monitors_interval_check`;

ALTER TABLE `monitors`
  ADD CONSTRAINT `monitors_interval_check`
  CHECK (`interval_sec` BETWEEN 5 AND 86400);

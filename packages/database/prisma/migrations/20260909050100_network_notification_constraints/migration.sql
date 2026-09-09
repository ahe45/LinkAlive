-- Preserve event invariants while allowing host-level connectivity summaries.
ALTER TABLE `notification_outbox`
  DROP CONSTRAINT `notification_outbox_sequence_check`,
  DROP CONSTRAINT `notification_outbox_incident_check`,
  ADD CONSTRAINT `notification_outbox_sequence_check` CHECK (
    (`event_type` IN ('DOWN', 'TEST', 'NETWORK_RECOVERY') AND `sequence` = 1)
    OR (`event_type` IN ('RECOVERY', 'RESOLVED_SUMMARY') AND `sequence` = 2)
  ),
  ADD CONSTRAINT `notification_outbox_incident_check` CHECK (
    (`event_type` IN ('TEST', 'NETWORK_RECOVERY') AND `incident_id` IS NULL)
    OR (`event_type` IN ('DOWN', 'RECOVERY', 'RESOLVED_SUMMARY') AND `incident_id` IS NOT NULL)
  ),
  ADD CONSTRAINT `notification_outbox_monitor_check` CHECK (
    (`event_type` = 'NETWORK_RECOVERY' AND `monitor_id` IS NULL)
    OR (`event_type` <> 'NETWORK_RECOVERY' AND `monitor_id` IS NOT NULL)
  );

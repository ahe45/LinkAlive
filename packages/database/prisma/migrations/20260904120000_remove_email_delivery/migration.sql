-- Preserve historical channel labels as plain strings while retiring the email feature.
ALTER TABLE `notification_channels`
  MODIFY `type` VARCHAR(32) NOT NULL;

ALTER TABLE `notification_outbox`
  MODIFY `channel_type_snapshot` VARCHAR(32) NOT NULL;

UPDATE `notification_deliveries` AS delivery
INNER JOIN `notification_outbox` AS outbox ON outbox.`id` = delivery.`outbox_id`
SET
  delivery.`status` = 'UNKNOWN',
  delivery.`error_safe` = '이메일 알림 기능 제거로 발송 추적이 종료되었습니다.',
  delivery.`finished_at` = NOW(3)
WHERE
  outbox.`channel_type_snapshot` = 'EMAIL'
  AND delivery.`status` = 'ATTEMPTING';

UPDATE `notification_outbox`
SET
  `status` = 'CANCELED',
  `canceled_at` = COALESCE(`canceled_at`, NOW(3)),
  `lease_owner` = NULL,
  `lease_until` = NULL,
  `last_error_safe` = '이메일 알림 기능이 제거되어 발송이 취소되었습니다.',
  `encrypted_config_snapshot` = X'00'
WHERE
  `channel_type_snapshot` = 'EMAIL'
  AND `status` IN ('PENDING', 'ENQUEUED', 'PROCESSING', 'RETRY');

UPDATE `notification_outbox`
SET `encrypted_config_snapshot` = X'00'
WHERE `channel_type_snapshot` = 'EMAIL';

DELETE binding
FROM `monitor_channels` AS binding
INNER JOIN `notification_channels` AS channel ON channel.`id` = binding.`channel_id`
WHERE channel.`type` = 'EMAIL';

UPDATE `notification_channels`
SET
  `enabled` = FALSE,
  `encrypted_config` = X'00',
  `deleted_at` = COALESCE(`deleted_at`, NOW(3))
WHERE `type` = 'EMAIL';

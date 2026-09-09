import { Icon } from '@/components/Icon';

export interface SelectableTelegramChannel {
  id: string;
  displayName: string;
  chatId?: string | null;
}

export function TelegramChannelSelect({
  channels,
  selectedIds,
  onChange,
}: {
  channels: SelectableTelegramChannel[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
}) {
  if (!channels.length)
    return (
      <div className="channel-empty-note">
        <Icon name="bell" size={20} />
        <div>
          <strong>등록된 알림 채널이 없습니다</strong>
          <p>관리자가 알림 채널을 등록하고 활성화하면 여기에서 선택할 수 있습니다.</p>
        </div>
      </div>
    );

  return (
    <div className="channel-select-grid">
      {channels.map((channel) => {
        const checked = selectedIds.includes(channel.id);
        return (
          <label
            className={`channel-choice${checked ? ' channel-choice-selected' : ''}`}
            key={channel.id}
          >
            <input
              type="checkbox"
              checked={checked}
              onChange={(event) =>
                onChange(
                  event.target.checked
                    ? [...selectedIds, channel.id]
                    : selectedIds.filter((id) => id !== channel.id),
                )
              }
            />
            <span className="channel-icon channel-telegram">
              <Icon name="telegram" size={19} />
            </span>
            <span>
              <strong>{channel.displayName}</strong>
              <small>
                {channel.chatId ? `Telegram · ${channel.chatId}` : 'Telegram 알림 채널'}
              </small>
            </span>
            <span className="choice-check">
              <Icon name="check" size={14} />
            </span>
          </label>
        );
      })}
    </div>
  );
}

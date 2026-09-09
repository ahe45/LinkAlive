import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { TelegramChannelSelect } from './TelegramChannelSelect';

describe('Telegram recipient selection', () => {
  it('shows separate channel cards, destination IDs and the saved selection', () => {
    const html = renderToStaticMarkup(
      <TelegramChannelSelect
        channels={[
          { id: 'first', displayName: '운영팀', chatId: '-10012345' },
          { id: 'second', displayName: '개발팀', chatId: '-10067890' },
        ]}
        selectedIds={['second']}
        onChange={() => undefined}
      />,
    );
    expect(html.match(/type="checkbox"/g)).toHaveLength(2);
    expect(html.match(/checked=""/g)).toHaveLength(1);
    expect(html).toContain('channel-choice-selected');
    expect(html).toContain('Telegram · -10012345');
    expect(html).toContain('Telegram · -10067890');
  });
});

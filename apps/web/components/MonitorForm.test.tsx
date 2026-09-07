import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MonitorForm } from './MonitorForm';

describe('MonitorForm', () => {
  it('shows the basic fields and hides notification channels for a regular user', () => {
    const markup = renderToStaticMarkup(
      <MonitorForm mode="create" showNotificationChannels={false} onSubmit={async () => {}} />,
    );

    expect(markup).toContain('모니터 이름');
    expect(markup).toContain('검사 URL');
    expect(markup).not.toContain('알림 채널');
  });

  it('shows notification channels for an administrator', () => {
    const markup = renderToStaticMarkup(
      <MonitorForm mode="create" showNotificationChannels onSubmit={async () => {}} />,
    );

    expect(markup).toContain('모니터 이름');
    expect(markup).toContain('검사 URL');
    expect(markup).toContain('알림 채널');
  });
});

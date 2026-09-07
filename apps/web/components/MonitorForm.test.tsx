import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MonitorForm } from './MonitorForm';

describe('MonitorForm', () => {
  it('can hide notification channels when explicitly requested', () => {
    const markup = renderToStaticMarkup(
      <MonitorForm mode="create" showNotificationChannels={false} onSubmit={async () => {}} />,
    );

    expect(markup).toContain('모니터 이름');
    expect(markup).toContain('검사 URL');
    expect(markup).not.toContain('알림 채널');
  });

  it('shows notification channels by default', () => {
    const markup = renderToStaticMarkup(
      <MonitorForm mode="create" showNotificationChannels onSubmit={async () => {}} />,
    );

    expect(markup).toContain('모니터 이름');
    expect(markup).toContain('검사 URL');
    expect(markup).toContain('알림 채널');
  });
});

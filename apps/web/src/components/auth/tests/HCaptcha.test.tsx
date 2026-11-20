import { render, screen, fireEvent, act } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { HCaptcha } from '../HCaptcha';

type Params = Record<string, (...args: unknown[]) => void> & { sitekey: string };

let lastParams: Params | undefined;
const hcaptcha = {
  render: vi.fn((_el: HTMLElement, params: Params) => {
    lastParams = params;
    return 'widget-1';
  }),
  reset: vi.fn(),
  remove: vi.fn(),
};

describe('HCaptcha recovery states (#917)', () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_HCAPTCHA_SITE_KEY = 'site-key';
    process.env.NEXT_PUBLIC_HCAPTCHA_ENABLED = 'true';
    (window as unknown as { hcaptcha: typeof hcaptcha }).hcaptcha = hcaptcha;
    hcaptcha.render.mockClear();
    hcaptcha.reset.mockClear();
    lastParams = undefined;
  });

  afterEach(() => {
    delete (window as unknown as { hcaptcha?: unknown }).hcaptcha;
    document.querySelectorAll('script[src*="hcaptcha.com"]').forEach((s) => s.remove());
  });

  it('forwards the verified token to the parent', () => {
    const onVerify = vi.fn();
    render(<HCaptcha onVerify={onVerify} />);
    act(() => lastParams?.callback?.('token-abc'));
    expect(onVerify).toHaveBeenCalledWith('token-abc');
  });

  it('shows an announced error with a keyboard-reachable retry that resets the challenge', () => {
    const onExpire = vi.fn();
    render(<HCaptcha onVerify={vi.fn()} onExpire={onExpire} />);

    act(() => lastParams?.['error-callback']?.('network-error'));

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toMatch(/failed/i);
    expect(onExpire).toHaveBeenCalled();

    const retry = screen.getByRole('button', { name: /try again/i });
    fireEvent.click(retry);
    expect(hcaptcha.reset).toHaveBeenCalledWith('widget-1');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows a load-failure message and retries by re-adding the provider script', () => {
    // Without window.hcaptcha the component takes the script-loading path.
    delete (window as unknown as { hcaptcha?: unknown }).hcaptcha;
    const { unmount } = render(<HCaptcha onVerify={vi.fn()} />);

    const script = document.querySelector<HTMLScriptElement>('script[src*="hcaptcha.com/1/api.js"]');
    expect(script).not.toBeNull();
    act(() => script?.onerror?.(new Event('error')));

    expect(screen.getByRole('alert').textContent).toMatch(/could not load/i);
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(document.querySelectorAll('script[src*="hcaptcha.com/1/api.js"]').length).toBe(1);
    unmount();
  });

  it('resets the widget when resetKey changes so a used token is never reused', () => {
    const { rerender } = render(<HCaptcha onVerify={vi.fn()} resetKey={0} />);
    rerender(<HCaptcha onVerify={vi.fn()} resetKey={1} />);
    expect(hcaptcha.reset).toHaveBeenCalledWith('widget-1');
  });
});

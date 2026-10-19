import { render, screen } from '@testing-library/react';
import { vi } from 'vitest';
import { LoginForm } from '../LoginForm';
import { RegisterForm } from '../RegisterForm';

// Social login is deferred (#738, docs/social-login-roadmap.md). Until a provider
// is implemented end to end, no visible control may promise one.
const SOCIAL_PROVIDER = /google|github|apple|facebook|continue with|coming soon/i;

function promisedProviderControls(): string[] {
  const controls = [...screen.queryAllByRole('button'), ...screen.queryAllByRole('link')];
  return controls.map((el) => el.textContent ?? '').filter((text) => SOCIAL_PROVIDER.test(text));
}

describe('LoginForm social login controls', () => {
  it('renders no button or link for a social provider', () => {
    render(<LoginForm onSubmit={vi.fn()} />);

    expect(promisedProviderControls()).toEqual([]);
  });

  it('shows no provider or coming-soon copy anywhere in the form', () => {
    const { container } = render(<LoginForm onSubmit={vi.fn()} />);

    expect(container.textContent ?? '').not.toMatch(SOCIAL_PROVIDER);
  });
});

describe('RegisterForm social login controls', () => {
  it('renders no button or link for a social provider', () => {
    render(<RegisterForm onSubmit={vi.fn()} />);

    expect(promisedProviderControls()).toEqual([]);
  });

  it('shows no provider or coming-soon copy anywhere in the form', () => {
    const { container } = render(<RegisterForm onSubmit={vi.fn()} />);

    expect(container.textContent ?? '').not.toMatch(SOCIAL_PROVIDER);
  });
});

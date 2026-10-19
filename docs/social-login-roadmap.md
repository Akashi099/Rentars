# Social Login Implementation Roadmap

## Current Status: Deferred

Social login (OAuth via Google, GitHub, etc.) is currently **deferred** to allow the platform to focus on core wallet-based authentication and Stellar blockchain integration.

Tracked in issue #738. The login and register screens render no social provider controls, and the backend exposes no OAuth routes. The deferral is enforced by `apps/web/src/components/auth/tests/SocialLoginDeferred.test.tsx`, which fails if either form shows a button or link naming a provider, or any "coming soon" copy. Re-enabling social login means removing that guard for the provider being added, in the same change that implements the flow end to end (see [Requirements before re-enabling](#requirements-before-re-enabling)).

## Decision Rationale

- **Complexity:** Social login requires OAuth provider configuration, state management, nonce/CSRF token handling, and account linking logic
- **Blockchain Focus:** Rentars is a Stellar dApp with wallet-first authentication (Freighter, etc.)
- **User Experience:** Email/password and wallet auth provide sufficient entry points; social login can be added later without disrupting existing workflows
- **Account Linking:** Deferred social login avoids ambiguous account linking behavior (which email/wallet should be primary?)

## Why Controls Were Removed

The login and register pages previously displayed "Continue with Google" and "Continue with GitHub" buttons that only showed "coming soon" toasts. This created ambiguous user expectations:

- Users might attempt social login and get confused by "coming soon" message
- Dead buttons suggest incomplete implementation
- Misleading UI worsens user perception of product maturity

**Solution:** Remove all social login UI until feature is production-ready.

## Implementation Plan (Future)

When social login is prioritized, follow this pattern:

### 1. Backend Setup

```typescript
// apps/backend/src/services/oauth.service.ts
export class OAuthService {
  async handleGoogleCallback(code: string, state: string): Promise<User> {
    // 1. Verify state token (CSRF protection)
    const storedState = await redis.get(`oauth:state:${state}`);
    if (storedState !== code) throw new Error('Invalid state');

    // 2. Exchange code for Google tokens
    const tokens = await google.exchangeCodeForTokens(code);
    
    // 3. Fetch user info
    const googleUser = await google.getUserInfo(tokens.access_token);
    
    // 4. Check if user exists by email
    let user = await db.users.findByEmail(googleUser.email);
    
    if (!user) {
      // 5. Create new user if first-time social login
      user = await db.users.create({
        email: googleUser.email,
        name: googleUser.name,
        avatar_url: googleUser.picture,
        auth_method: 'google', // Track auth method
        oauth_provider_id: googleUser.id,
      });
    } else {
      // 6. Link OAuth if user already exists
      await db.userOAuthLinks.upsert({
        user_id: user.id,
        provider: 'google',
        provider_id: googleUser.id,
      });
    }

    // 7. Return JWT for session
    return user;
  }
}
```

### 2. Frontend Implementation

```typescript
// apps/web/src/components/auth/SocialLoginButton.tsx
export function SocialLoginButton({ provider }: SocialLoginButtonProps) {
  const handleClick = async () => {
    // 1. Generate nonce for CSRF protection
    const state = crypto.randomUUID();
    await sessionStorage.setItem(`oauth:state:${state}`, 'pending');

    // 2. Redirect to OAuth provider
    const authUrl = getOAuthAuthorizationUrl(provider, {
      state,
      redirect_uri: `${window.location.origin}/auth/callback`,
      scope: ['email', 'profile'],
    });
    
    window.location.href = authUrl;
  };

  return (
    <button onClick={handleClick}>
      Continue with {provider}
    </button>
  );
}

// apps/web/src/app/auth/callback/page.tsx
export default function OAuthCallbackPage() {
  useEffect(() => {
    const handleCallback = async () => {
      const { code, state } = getQueryParams();
      
      // 1. Verify state
      const storedState = sessionStorage.getItem(`oauth:state:${state}`);
      if (!storedState) throw new Error('Invalid OAuth state');
      
      // 2. Call backend to exchange code for tokens
      const response = await fetch('/api/auth/oauth/callback', {
        method: 'POST',
        body: JSON.stringify({ code, state, provider: 'google' }),
      });
      
      // 3. Redirect to dashboard or account linking page
      router.push('/dashboard');
    };

    handleCallback();
  }, []);

  return <LoadingSpinner text="Signing in..." />;
}
```

### 3. Database Schema

```sql
-- New tables for OAuth support
CREATE TABLE user_oauth_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('google', 'github')),
  provider_id TEXT NOT NULL,
  provider_email TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  linked_at TIMESTAMP,
  UNIQUE(provider, provider_id),
  UNIQUE(user_id, provider)
);

-- Track OAuth state tokens for CSRF protection
CREATE TABLE oauth_state_tokens (
  state TEXT PRIMARY KEY,
  user_id UUID,
  provider TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMP NOT NULL,
  used_at TIMESTAMP
);

-- Index for cleanup of expired tokens
CREATE INDEX idx_oauth_state_expires ON oauth_state_tokens(expires_at);
```

### 4. Account Linking Rules

- **Single Provider Per User:** User can link one account per provider (1:1 mapping)
- **Email Uniqueness:** If social login email differs from existing user email, require explicit linking approval
- **Primary Auth Method:** User can designate which auth method is primary (email/password vs. social)
- **Cancellation Handling:** If user cancels OAuth flow, show helpful error message and return to login

### 5. Tests Required

```typescript
// apps/backend/tests/oauth.test.ts
describe('OAuth Service', () => {
  it('exchanges authorization code for tokens', async () => {
    const tokens = await oauthService.handleGoogleCallback(code, state);
    expect(tokens.access_token).toBeDefined();
  });

  it('creates new user on first social login', async () => {
    const user = await oauthService.handleGoogleCallback(code, state);
    expect(user.auth_method).toBe('google');
  });

  it('links existing user on repeat social login', async () => {
    const user1 = await oauthService.handleGoogleCallback(code, state);
    const user2 = await oauthService.handleGoogleCallback(newCode, newState);
    expect(user1.id).toBe(user2.id);
  });

  it('rejects invalid state token', async () => {
    expect(() => oauthService.handleGoogleCallback(code, invalidState))
      .toThrow('Invalid state');
  });

  it('handles duplicate email from different provider', async () => {
    // Create user via Google
    const googleUser = await oauthService.handleGoogleCallback(googleCode, state);
    
    // Try GitHub signup with same email
    const githubUser = await oauthService.handleGithubCallback(githubCode, state);
    
    // Should link to existing user with confirmation
    expect(googleUser.id).toBe(githubUser.id);
  });
});

// apps/web/tests/oauth-callback.test.tsx
describe('OAuth Callback Page', () => {
  it('exchanges code for session token', async () => {
    const { getByText } = render(<OAuthCallbackPage />);
    await waitFor(() => expect(getByText('Signing in...')).toBeInTheDocument());
  });

  it('rejects invalid state token', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Invalid state'));
    render(<OAuthCallbackPage />);
    await waitFor(() => expect(mockRouter.push).toHaveBeenCalledWith('/login?error=invalid_state'));
  });
});
```

### 6. Provider Configuration

**Google OAuth:**
```env
GOOGLE_OAUTH_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_OAUTH_CLIENT_SECRET=your-secret
GOOGLE_OAUTH_REDIRECT_URI=https://rentars.app/auth/callback
```

**GitHub OAuth:**
```env
GITHUB_OAUTH_CLIENT_ID=your-client-id
GITHUB_OAUTH_CLIENT_SECRET=your-secret
GITHUB_OAUTH_REDIRECT_URI=https://rentars.app/auth/callback
```

### 7. Security Checklist

- ✅ Implement PKCE (Proof Key for Code Exchange) for mobile/SPA security
- ✅ Validate state token on callback (CSRF protection)
- ✅ Never expose client secrets in frontend bundles
- ✅ Use HTTPS only for all OAuth redirects
- ✅ Validate nonce on token response (if using OpenID Connect)
- ✅ Clear sensitive data from URL after callback (use history.replaceState)
- ✅ Implement rate limiting on OAuth callback endpoint
- ✅ Log all OAuth attempts for audit trail
- ✅ Require email verification on first social login

## Acceptance Criteria for Social Login Implementation

When this feature is re-prioritized:

1. Backend OAuth callback endpoint handles Google and GitHub
2. State/nonce validation prevents CSRF attacks
3. Account linking works for existing users (same email)
4. New users created with correct auth_method tracking
5. Cancellation and error cases handled gracefully
6. All secrets never reach client bundles or logs
7. Unit tests cover all OAuth flows
8. Integration tests verify account linking edge cases
9. RLS policies updated to include oauth_links table
10. Product docs explain which auth method is "primary"

## Recommended Timeline

- **Phase 1 (Q1 2024):** Stable wallet-first auth, core platform features
- **Phase 2 (Q2 2024):** Backend OAuth service, provider configuration
- **Phase 3 (Q3 2024):** Frontend OAuth flows, account linking UI
- **Phase 4 (Q4 2024):** Testing, security audit, launch

## See Also

- [CONTRIBUTING.md](../CONTRIBUTING.md) — Testing and development setup
- [DEPLOYMENT.md](../DEPLOYMENT.md) — Environment variable management
- [OAuth 2.0 RFC 6749](https://tools.ietf.org/html/rfc6749) — Authorization code flow
- [PKCE RFC 7636](https://tools.ietf.org/html/rfc7636) — Proof Key for Code Exchange

## Requirements before re-enabling

A provider control may appear on the login or register screen only when all of these are in place for that provider:

1. **Provider configuration** lives on the server. Client IDs are public, but client secrets are never sent to the browser, bundled into the web app, or written to logs.
2. **State and nonce validation** on the callback. A missing, expired, or mismatched `state` is rejected before any token exchange.
3. **Account linking** that handles a duplicate email safely. A provider identity is linked to an existing account only when the account owner proves control of it, and never silently merged by email alone.
4. **Cancellation tests**: a user who cancels at the provider, or returns with an error, lands back on the form with no account created and no half-linked identity.
5. **The guard test is updated** in the same change, so the provider's control is covered by the regression suite rather than bypassing it.

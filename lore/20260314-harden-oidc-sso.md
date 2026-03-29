# Harden: OIDC SSO Implementation

Post-implementation security and quality review of OIDC SSO (Pantheon as IdP, OpenWork as RP).

## Effort/Impact Table

| # | Opportunity | Effort | Impact | Action |
|---|-------------|--------|--------|--------|
| 1 | Fix: client_secret validation breaks public clients (empty string fails) | Quick | High | Auto-fix |
| 2 | Fix: timing attack on client_secret comparison — use hmac.compare_digest | Quick | High | Auto-fix |
| 3 | Fix: state param null check — both code AND state required on callback | Quick | High | Auto-fix |
| 4 | Fix: nonce not stored in sessionStorage, never validated after exchange | Quick | Medium | Auto-fix |
| 5 | Fix: add scope validation (require "openid") on authorize endpoint | Quick | Low | Auto-fix |
| 6 | Fix: add input length limits on state/nonce params | Quick | Low | Auto-fix |
| 7 | Refactor: exchangeCode() to use consistent error handling | Easy | Medium | Auto-fix |
| 8 | Fix: guard against empty PANTHEON_BASE_URL before redirect | Easy | Medium | Auto-fix |
| 9 | Fix: race condition — add abort guard to prevent duplicate async login | Easy | Medium | Auto-fix |
| 10 | Fix: atomic RSA key file write (temp file + os.replace) | Easy | Medium | Auto-fix |
| 11 | Add: PKCE (code_challenge/code_verifier) for public client security | Moderate | High | Ask first |
| 12 | Cache JWKS response in OIDCProvider (compute once) | Quick | Low | Auto-fix |
| 13 | Add: OIDC test coverage (auth module + routes) | Moderate | High | Ask first |
| 14 | Config: generate random oidc_client_secret default instead of "change-me" | Quick | Low | Auto-fix |

## Opportunity Details

### 1. client_secret validation breaks token exchange
- **What**: Token endpoint requires `client_secret: str = Form(...)` but OpenWork sends empty string as public client. `exchange_code()` compares `"" != "change-me"` → always rejects. Make client_secret optional with `Form(default="")`, skip secret check when empty (public client pattern).
- **Where**: `pantheon/api/routes/oidc.py:117`, `pantheon/auth/oidc.py:119-137`
- **Why**: Entire OIDC flow is broken without this fix.

### 2. Timing attack on client_secret
- **What**: Replace `!=` with `hmac.compare_digest()` in `validate_client()` and `exchange_code()`.
- **Where**: `pantheon/auth/oidc.py:95-96,135`

### 3. State param null check on callback
- **What**: Require both `code` AND `returnedState` before processing callback. Prevents edge case where both savedState and returnedState are null → comparison passes.
- **Where**: `packages/app/src/app/context/pantheon-sdk.tsx:61`

### 4. Nonce not stored or validated
- **What**: Store nonce in sessionStorage alongside state. After code exchange, decode id_token payload (base64, no crypto verification needed) and check nonce matches.
- **Where**: `packages/app/src/app/context/pantheon-sdk.tsx:90-101,70-73`

### 5. Scope validation
- **What**: Validate "openid" is in scope param on authorize endpoint.
- **Where**: `pantheon/api/routes/oidc.py:67`

### 6. Input length limits
- **What**: Reject state/nonce > 500 chars on authorize endpoint.
- **Where**: `pantheon/api/routes/oidc.py:68-69`

### 7. exchangeCode consistency
- **What**: Add proper error handling to exchangeCode() matching client pattern (clear token on 401/403, parse error text).
- **Where**: `packages/app/src/app/lib/pantheon-client.ts:158-184`

### 8. Empty PANTHEON_BASE_URL guard
- **What**: Before redirecting to authorize, check PANTHEON_BASE_URL is non-empty. Show error if missing.
- **Where**: `packages/app/src/app/context/pantheon-sdk.tsx:104`

### 9. Race condition abort guard
- **What**: Track in-flight async with a boolean flag. If effect re-fires while async is running, skip. Prevents duplicate API calls on retry button.
- **Where**: `packages/app/src/app/context/pantheon-sdk.tsx:51-120`

### 10. Atomic RSA key write
- **What**: Write to NamedTemporaryFile then `os.replace()` for crash safety.
- **Where**: `pantheon/auth/oidc.py:48-54`

### 11. PKCE support
- **What**: Full PKCE (RFC 7636): OpenWork generates code_verifier + SHA256 code_challenge, Pantheon validates on token exchange.
- **Where**: Both repos — `auth/oidc.py`, `api/routes/oidc.py`, `pantheon-client.ts`, `pantheon-sdk.tsx`
- **Trade-offs**: More code complexity across both repos. Required by OIDC spec for public clients (browser apps).

### 12. Cache JWKS
- **What**: Compute JWKS dict once in `__init__`, store as `self._jwks`. Return cached dict from `get_jwks()`.
- **Where**: `pantheon/auth/oidc.py:57-82`

### 13. OIDC test coverage
- **What**: Unit tests for OIDCProvider (key gen/load, auth code lifecycle, ID token signing/claims, client validation, JWKS format). Integration tests for routes.
- **Where**: New file `pantheon/tests/test_oidc.py`

### 14. Random default client_secret
- **What**: Change default from `"change-me"` to `Field(default_factory=lambda: secrets.token_urlsafe(32))`.
- **Where**: `pantheon/config.py:100`

## Execution Protocol
**DO NOT implement any changes without user approval.**
For EACH opportunity, use `AskUserQuestion`.
Options: "Implement" / "Skip (add to TODO.md)" / "Do not implement"
Ask all questions before beginning any implementation work
(do NOT do alternating ask then implement, ask then implement, etc.)
After all items resolved, run: `poetry run pytest`

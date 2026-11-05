# Provider verification

Fixed finish-plan step2. This records actual provider proof separately from code tests.

## Google

Actual basic-profile authorization and authenticated session succeeded on api.arcex.dev. Existing provider scopes remain openid/email/profile; no Gmail, Drive or offline access.

## GitHub

Same-site origin selection is prepared in main71a7b02 and passed the existing31tests, typecheck/build and isolated local smoke. api.arcex.dev uses its own exact callback; workers.dev keeps the existing Collector callback and credentials. No second app or session-token bridge.

The existing app's form is prepared with https://api.arcex.dev/auth/github/callback alongside the existing workers.dev callback and its /mcp callback. It has not been saved. The Windows computer-use confirmation policy requires action-time approval for this cloud-access edit. Production activation and real sign-in verification remain pending.

## X

X remains unconfigured under the zero-spend constraint. Current account inspection opened developer onboarding and did not establish an existing free app. No account/credential creation, terms acceptance, card, credit purchase or auto-recharge was performed.

Official current [pricing](https://docs.x.com/x-api/getting-started/pricing) charges API user reads. Its [free credit incentives](https://docs.x.com/x-api/getting-started/free-credits) require an eligible payment card and first credit purchase; these do not establish a zero-spend sign-in option for this account. The current OAuth2 implementation needs the user-profile API. Do not enable it or fund the API without a later explicit budget decision. This is a provider/budget constraint, not a claim that X authentication itself moves money.

## Stripe

The deployed protected readiness route independently reports dedicated sandbox mode, active1200USD-cent monthly test price, enabled12-event webhook endpoint and configured customer portal. This fixture does not set launch pricing. The Stripe connector currently needs reauthentication; existing protected Worker configuration and the prepared browser session are used instead.

One synthetic app user sandbox:arcex-checkout-20261105 was provisioned for the hosted sandbox test. The real authenticated checkout route created a cs_test session. Its temporary authenticated session was generated for this synthetic user, never a real customer, and only its hash is stored in D1. No raw session token is persisted or printed. The browser must use only Stripe's public fake test values, never a real card.

Hosted sandbox checkout completed once on November 5, 2026 with Stripe's public fake card and fictional identity. The browser observed the sandbox Checkout success redirect. Independent D1 reads then verified active subscription sub_1UYWFhE9BaJEv4JpjDe35fpV, expected sandbox price price_1UXbLrE9BaJEv4Jp3vd7VVlO and period end 2026-12-05T19:23:11.000Z. Three actual webhook receipts were persisted at 19:23:15Z:

- evt_1UYWFiE9BaJEv4JpJtDQIZRk
- evt_1UYWFiE9BaJEv4JplbOwFPzw
- evt_1UYWFiE9BaJEv4JpE6e9N3Cb

At 19:26:27.986Z a fresh authenticated request through the normal /api/v1/billing/status route returned insider:true with that active subscription. Its five-minute synthetic session was deleted immediately after verification. The normal billing portal route also returned the expected Stripe-hosted portal. No real money, customer identity or live-mode account was used.

Cleanup remains incomplete: Computer Use stopped before cancellation because it could not determine the current browser URL confidently enough to enforce its policy, and instructed the setup worker to stop. No cancellation click, provider cancellation timing or cancellation webhook was observed. Do not retry the blocked browser action or report cleanup complete. The fixture remains clearly labelled and separate from actual customers. The Stripe connector requires reauthentication, and no local Stripe key is available; do not add an administrative credential proxy just for cleanup.

The private sandbox Checkout/portal URLs stay only in an ignored local state file. They are not part of the repository or this proof. The subscription and receipt identifiers above are provider references, not credentials.

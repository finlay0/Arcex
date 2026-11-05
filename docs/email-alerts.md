# Product alert delivery

Resend's existing team was verified as Transactional Free: 3,000/month and100/day, no payment method, transactional pay-as-you-go off. The dedicated arcex.dev sending domain is verified. Its sending-only API key is scoped to that domain and stored in the Worker's encrypted configuration. Do not upgrade, enable overages or use another app's credentials.

Backend delivery is disabled by default. Configure encrypted `RESEND_API_KEY`, then set `RESEND_SENDER_VERIFIED=true` only after actual DNS verification. Set `EMAIL_ALERTS_ENABLED=true` only when the provider path and notification content are ready. The sender is `Arcex <alerts@arcex.dev>`; no mailbox is needed for this sending identity. No receiving/MX configuration is requested here.

Production delivery is enabled after the deployed Worker sent a fixed Resend simulator message and Terra independently verified its Delivered receipt in Resend. This proves the provider path, not a real customer's inbox. No accounts were opted in and no products or changes were published at activation. Research collection and both daily research schedules remain paused independently.

Each invocation processes at most one opted-in Insider digest, with at most20 approved, published changes to products that user still watches. Private or retracted evidence never enters an eligible digest. The outbox retains the exact provider request and stable idempotency key. Provider acceptance advances the change cursor in the same database transaction as the receipt. `sent` means the provider accepted the request, not proof of inbox delivery.

Atomic database counters stop at50 send-attempt reservations per UTC day and1,500 per month, below provider Free allowances. Each retry debits the period when that attempt starts, regardless of the outbox creation date. Counters have no recipient foreign key, so deleting an account does not reopen capacity. Attempts remain charged after failures/cancellations; there is no paid fallback. At that launch capacity, some eligible recipients wait for a later day. This does not promise daily email to10,000 users. One active digest per user prevents duplicate queues across dates, and a delivered digest prevents another that day; up to20 changes are grouped into it. The oldest unserved users are considered first.

Network errors and provider429/5xx responses retry the immutable request up to three times within23h of its first attempt, inside Resend's24h idempotency window. An unattempted job can wait for allowance without being mislabeled as unknown delivery. Older unknown deliveries block new digests for that user until explicit operator resolution; the next day does not silently recreate them with a new key. `POST /api/v1/admin/alerts/:id/resolve` records a reviewed accepted/not_accepted outcome and reason, without refunding allowance. Every retry rechecks subscription/risk holds, current recipient address, opt-in, watches and publication/evidence status. Error records contain codes rather than recipient/provider payloads.

The List-Unsubscribe header supplies a signed POST capability. GET has no side effect, so link previews do not silently change preferences. An interactive user can also disable alerts after losing Insider access.

The existing ten-minute timer refreshes metrics and expires old auth state. Source enqueueing and delivery alternate when both are enabled, keeping each invocation below D1 Free's50-statement budget. Research remains independently paused. No new cron slot or paid job service is needed.

Operational endpoints: `GET /api/v1/admin/alerts/status` and `POST /api/v1/admin/alerts/deliver`. Status contains aggregate reservations/readiness, no recipient data. Normal users see actual delivery readiness alongside their saved preference.

Provider references: [Send email](https://resend.com/docs/api-reference/emails/send-email), [24h idempotency](https://resend.com/docs/dashboard/emails/idempotency-keys), [provider simulator addresses](https://resend.com/changelog/sending-test-emails). A simulator acceptance/delivery event must be distinguished from a real customer's inbox receipt.

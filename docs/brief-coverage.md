# Brief implementation coverage

Backend scope only. This distinguishes working code, provider setup and observed content. Updated November 3, 2026.

| Brief requirement | Implemented / verified | Remaining |
| --- | --- | --- |
| Radar discovery, categories, monetization filters | Deployed API, draft/public separation, search and filters | Reviewed real product cohort; frontend excluded |
| Meta ad monitoring | Dedicated watches/jobs, Library IDs/creative/destination/state and per-ad observed days; three actual Work searches stored with captures | Initial searches found no attributable product ads; ad-first discovery underway; no historical continuity manufactured |
| YouTube/X creator distribution | Watches/jobs, video/post links, matching destinations and disclosures; actual Work YouTube search; bounded optional official Data API collector | Initial search found no verified product mention; server API key is unconfigured, so Work browser is current path |
| Google Ads Transparency | Dedicated watches/jobs, advertiser/creative IDs, format, country and source-reported last-shown dates | Initial real Google browser checks; no keyword-bid or spend inference |
| Short-form hooks | Validated Shorts/TikTok/Reels/X clip records, hook quote/style, source/hash/time and visible counters | Actual clips and source review; no causal virality inferred |
| Launch/engagement velocity | Numeric source snapshots, counter deltas and per-hour change from actual timestamps, approved-only public summaries | Real observations over time; one snapshot yields no rate |
| SponsorBlock timestamps | Cached per-video adapter, bounded requests, attribution and sponsor-identity uncertainty | Disabled by default pending permission for commercial use under the database/API license |
| Acquisition evidence | Source URLs, observation hashes/timestamps, structured distribution records and private captures | Real ads/sponsor records need collection and review |
| Post-signup funnel and activation | Ordered evidence-backed steps, capture references, stage annotations, draft imports | Real authenticated full-funnel teardowns; landing pages alone do not fulfill this |
| Paywall and credits | Validated state machines, transitions, credit rules and evidence checks | Observed credit exhaustion/upgrade triggers from real products |
| Copyable blueprints | Immutable spec versions, signed-in export, evidence gates and partner disclosures | Reviewed deep blueprints for the initial cohort |
| Inspector | Public metadata, optional automatic navigation/click captures, observed client stack signatures, Terra extraction and draft importer; isolated-browser capture test passed | Real authenticated flows; automatic publication remains gated by review |
| Cloud research | Actual Work cloud computer/browser with Terra Medium; protected OAuth collector; real candidate writes and image uploads | Complete upfront research and qualification; daily schedule remains paused |
| Arena | Model/prompt/repo/demo/benchmark CRUD, publication and voting | Real experiments, playable builds and observed ratings; frontend excluded |
| Ship | Submissions, ownership, moderation, voting and prioritized stream queue | Real community submissions and frontend excluded |
| GitHub sign-in | Dedicated app/secrets, state/PKCE/session code; collector owner OAuth verified | Full customer sign-in with future same-site frontend |
| X sign-in | Provider/session code and account handling | Dedicated X developer app/secrets and provider test |
| Free signed-in actions | Blueprint export, saves, own submissions and voting | Customer-facing UI excluded |
| Insider tier | Entitlement checks, API keys, collections, badge data and review priority | Launch price/currency approval and real customer launch |
| Stripe | Dedicated sandbox, test price, Portal, 12 webhooks; provider readiness and fixture tests | Hosted test checkout and actual signed webhook delivery; live billing/tax activation |
| Affiliate/native sponsors | Disclosed partner records and blueprint associations | Actual partner relationships/codes and commercial agreements |
| Public/Insider stdio MCP | Installable GitHub release tarball; fresh packed install, real stdio handshake and live public read passed | npm registry publication is separate; original scoped name belongs to another publisher |
| Private Work collector MCP | Deployed OAuth, owner checks, real Work reads/writes and private image storage | Ongoing observed research, no publish/billing tools |
| Database and storage | D1 relational records; existing Supabase project renamed Arcex; private bucket, 50 MB app quota, real upload/read/delete verification | No paid upgrades or R2 activation; service may stop at free limits |
| Media/content flywheel | Data primitives for source-backed content and Arena/Ship links | Videos, posts, livestreams, outreach and sponsor pitches have not been produced or sent |

Meta's official API covers global political/issue ads and commercial ads delivered to the UK/EU during its documented period. Public Ad Library browser checks cover a different scope. [Meta API documentation](https://www.facebook.com/ads/library/api/). This project has not obtained or claimed unrestricted Meta API access, activated a paid scraping provider, or bypassed access challenges.

The daily Work 09:00 America/Halifax schedule and superseded local Codex automation are paused. The Worker cron is configured but `COLLECTION_ENABLED=false` prevents automatic enqueueing. Manual upfront research continues.

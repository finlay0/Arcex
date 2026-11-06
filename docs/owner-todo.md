# Finlay's later to-do list

Things only Finlay can do (accounts, keys, payments). Agents never create accounts or handle credentials. Each item says what it unlocks.

1. **YouTube Data API key** (Google Cloud project on the second account, free quota). Add as Worker secret `YOUTUBE_API_KEY` (`wrangler secret put YOUTUBE_API_KEY --env production`). Unlocks creator/review videos and their view history.
2. **Meta Ad Library API access**: a Facebook developer app with identity verification, then an access token as Worker secret `META_AD_LIBRARY_TOKEN`. Unlocks code-only Meta ad tracking with no login walls (the API covers ads shown in the EU/UK plus political ads).
3. **Chrome UX Report API key** (same free Google Cloud project, CrUX API enabled). Optional; sharpens the traffic tier for sites that are not in the Tranco list.
4. **Dedicated research account for signed-in screens**: a separate Google account for the persistent Grok Bot browser, credentials entered by Finlay only. Unlocks post-sign-up onboarding and in-app paywall screens.
5. **Stripe sandbox**: create the ArcX Pro prices ($11.99 CAD for Canada, $11.99 USD elsewhere) and cancel the old synthetic sandbox subscription.

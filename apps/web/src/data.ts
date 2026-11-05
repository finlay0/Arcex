// Prototype fixtures. Every product, number and screen here is invented sample data.
export type Stage = "acquisition" | "landing" | "signup" | "onboarding" | "activation" | "paywall" | "retention";
export const STAGES: Stage[] = ["landing", "signup", "onboarding", "activation", "paywall", "retention"];
export const STAGE_LABEL: Record<Stage, string> = {
  acquisition: "Acquisition", landing: "Landing", signup: "Signup", onboarding: "Onboarding",
  activation: "Activation", paywall: "Paywall", retention: "Retention",
};

export type Category = "video" | "coding" | "sales" | "consumer" | "image" | "writing" | "audio" | "marketing";
export const CATEGORY_LABEL: Record<Category, string> = { video: "Video", coding: "Dev", sales: "Sales", consumer: "Consumer", image: "Image", writing: "Writing", audio: "Audio", marketing: "Marketing" };

export type Model = "credit" | "hard" | "watermark" | "usage" | "free" | "subscription";
export const MODEL_LABEL: Record<Model, string> = {
  credit: "Credit gate", hard: "Hard trial", watermark: "Watermark", usage: "Usage", free: "Free viral", subscription: "Subscription",
};

export type ScreenKind = "landing" | "signup" | "quiz" | "loading" | "aha" | "paywall" | "retention";
export type Pin = { x: number; y: number; note: string };
export type Step = {
  stage: Stage; title: string; screen?: ScreenKind; quiz?: { q: string; options: string[]; n: number; of: number };
  why: string; cost: string; pricing: string; logic: string[]; pins: Pin[]; capturedAt: string;
};
export type Ad = { id: string; network: "Meta" | "Google"; hook: string; format: string; start: number; end: number; active: boolean; hue: number };
export type CreatorItem = { channel: string; title: string; views: string; date: string; kind: "Sponsored" | "Mention" | "Affiliate" };
export type Theme = { accent: string; bg: string; fg: string; muted: string; surface: string; line: string; radius: number };
/** "full" has captured screens and a blueprint. "signals" has public distribution data only. */
export type Coverage = "full" | "signals";
export type Product = {
  coverage: Coverage;
  slug: string; name: string; domain: string; tagline: string; category: Category; model: Model; what: string; adsDelta: number; creatorsDelta: number; mechanic: string; lastSeen: number;
  activeAds: number; longestAd: number; creators: number;
  /** Estimated monthly revenue in $k. An inference, never an observation. */
  revenue: [number, number]; confidence: 1 | 2 | 3 | 4;
  /** 4-week change in observed distribution activity, in percent. Not business growth. */
  growth: number; spark: number[];
  /** Days since Arcex first saw the product. */
  firstSeen: number;
  stack: string[]; price: { week?: string; month: string; year?: string; credits?: string }; product: { verb: string; noun: string };
  theme: Theme; ads: Ad[]; creatorItems: CreatorItem[]; steps: Step[];
};

const WHEN = "Nov 2";

type ModelInfo = {
  title: string; why: string; cost: string; pricing: string; logic: string[]; states: string[]; pins: Pin[];
  transitions: [string, string, string][]; rules: [string, string][];
};
const MODEL: Record<Model, ModelInfo> = {
  credit: {
    title: "Credits run out mid-project",
    why: "The wall appears right after a user has seen their own output and wants one more. Motivation is at its peak and the price feels like continuing, not starting.",
    cost: "Every generation spends a credit before the model is called, so free usage has a hard ceiling on API spend from day one.",
    pricing: "Credit packs sit beside the subscription. The pack makes the subscription look like the better deal.",
    logic: ["on generate → credits_remaining > 0 ?", "yes → reserve credit → run model", "no → open <UpgradeModal trigger=\"credits_zero\" />", "on payment → grant credits → resume job"],
    states: ["Free credits", "Low balance", "Out of credits", "Subscribed"],
    transitions: [["Free credits", "2 left", "Low balance"], ["Low balance", "0 left", "Out of credits"], ["Out of credits", "pays", "Subscribed"]],
    rules: [["Free credits", "10 on signup"], ["Cost per generation", "1 credit"], ["Refill", "Monthly on paid plans"]],
    pins: [{ x: 82, y: 20, note: "Headline names what they just lost access to, not the plan." }, { x: 34, y: 56, note: "Monthly plan is highlighted by default." }, { x: 66, y: 56, note: "Credit pack exists mostly to anchor the subscription." }],
  },
  hard: {
    title: "Paywall straight after the quiz",
    why: "The user answers several personal questions before seeing a price. Having put in the effort, they treat the plan as the last step of something they already started.",
    cost: "There is no free generation at all, so nothing is spent on people who never intended to pay.",
    pricing: "Weekly price is shown first because it looks small. Annual is presented as a large saving against that weekly number.",
    logic: ["on quiz_complete → save profile", "subscription_status != active ?", "yes → render <HardPaywall /> and block /app", "close button appears after 3s"],
    states: ["Quiz", "Paywall", "Trial", "Subscribed"],
    transitions: [["Quiz", "completes", "Paywall"], ["Paywall", "starts trial", "Trial"], ["Trial", "day 3", "Subscribed"]],
    rules: [["Free generations", "None"], ["Trial", "3 days, card required"], ["Close button delay", "3 seconds"]],
    pins: [{ x: 82, y: 20, note: "Copy reflects their quiz answers back to them." }, { x: 34, y: 56, note: "Weekly price anchors everything as cheap." }, { x: 94, y: 7, note: "Close button is delayed by 3 seconds." }],
  },
  watermark: {
    title: "Free to make, pay to export",
    why: "Users get the full product and a finished result. Paying removes the one thing stopping them from using it publicly, so the value is obvious.",
    cost: "Free exports render at low resolution with a watermark, which keeps compute cheap while the free videos advertise the product.",
    pricing: "Priced per month with export minutes as the limit, so heavier users move up on their own.",
    logic: ["on export_click → plan == free ?", "yes → open <ExportModal /> with preview", "continue free → render 720p + watermark", "upgrade → render 4K, no watermark"],
    states: ["Editing", "Export choice", "Watermarked", "Pro export"],
    transitions: [["Editing", "export", "Export choice"], ["Export choice", "stays free", "Watermarked"], ["Watermarked", "upgrades", "Pro export"]],
    rules: [["Free exports", "Unlimited, 720p"], ["Watermark", "Bottom right, always"], ["Pro export limit", "120 min a month"]],
    pins: [{ x: 82, y: 20, note: "The ask is tied to the export they're doing right now." }, { x: 34, y: 56, note: "Free option stays available, which builds trust." }, { x: 66, y: 56, note: "Upgrade removes the watermark from this exact video." }],
  },
  usage: {
    title: "Usage meter turns into an upgrade",
    why: "A live meter is visible long before the limit, so the upgrade isn't a surprise. Teams hit it when the product is already part of their work.",
    cost: "Each action is metered against a monthly allowance, so revenue rises in line with model spend.",
    pricing: "A low base price plus overage. Plans are named by volume, which makes it easy to pick one.",
    logic: ["on action → usage + 1", "usage / limit >= 0.8 → show meter warning", "usage >= limit → pause queue", "on upgrade → raise limit → resume queue"],
    states: ["Free", "80% used", "Paused", "Scale plan"],
    transitions: [["Free", "80 of 100", "80% used"], ["80% used", "100 of 100", "Paused"], ["Paused", "upgrades", "Scale plan"]],
    rules: [["Free allowance", "100 actions a month"], ["Warning", "At 80%"], ["Overage", "$0.04 an action"]],
    pins: [{ x: 82, y: 20, note: "Shows queued work that is waiting on them." }, { x: 34, y: 56, note: "Plans are sized by number of actions." }, { x: 66, y: 56, note: "Recommended plan is calculated from their usage." }],
  },
  free: {
    title: "Free tool, paid power features",
    why: "The core action needs no account. Sharing results brings in the next users, and the paid plan is for the small group using it constantly.",
    cost: "Anonymous users get a small daily limit per device and a cheaper model, so viral spikes stay affordable.",
    pricing: "A single low monthly plan. No trial, no tiers and nothing to compare.",
    logic: ["on use → anonymous_count < 3 ?", "yes → run on small model", "no → prompt sign-in for 10 more", "power user → offer <ProPrompt />"],
    states: ["Anonymous", "Signed in", "Daily limit", "Pro"],
    transitions: [["Anonymous", "3 uses", "Signed in"], ["Signed in", "10 uses", "Daily limit"], ["Daily limit", "pays", "Pro"]],
    rules: [["Anonymous uses", "3 a day"], ["Signed-in uses", "10 a day"], ["Pro price", "One flat plan"]],
    pins: [{ x: 82, y: 20, note: "Only asks after several free uses." }, { x: 34, y: 56, note: "One plan removes the need to compare." }, { x: 66, y: 56, note: "A share link is offered as a free way to continue." }],
  },
  subscription: {
    title: "Second-project plan limit",
    why: "The free plan is genuinely useful for one project. The limit appears when a user starts a second, which is a strong sign they're serious.",
    cost: "Free projects use a cheaper model and a monthly message limit, keeping the cost of each free user predictable.",
    pricing: "Plans are shown with annual selected by default, and the recommended plan is highlighted.",
    logic: ["on create_project → count >= 1 && plan == free ?", "yes → open <PlanModal trigger=\"second_project\" />", "annual toggle default = true", "on checkout → unlock projects"],
    states: ["Free", "Limit reached", "Pro trial", "Pro"],
    transitions: [["Free", "2nd project", "Limit reached"], ["Limit reached", "starts trial", "Pro trial"], ["Pro trial", "day 7", "Pro"]],
    rules: [["Free projects", "1"], ["Messages", "50 a month"], ["Trial", "7 days"]],
    pins: [{ x: 82, y: 20, note: "Triggered by a clear sign of intent." }, { x: 34, y: 56, note: "Annual price is what people see first." }, { x: 66, y: 56, note: "Recommended plan is highlighted." }],
  },
};
export const modelInfo = (m: Model) => MODEL[m];

type Metrics = Pick<Product, "revenue" | "confidence" | "growth" | "spark" | "firstSeen">;
type Seed = Omit<Product, "coverage" | "steps" | "ads" | "creatorItems" | keyof Metrics> & { coverage?: Coverage; quiz: { q: string; options: string[] }[]; hooks: string[]; channels: string[] };

function makeAds(seed: Seed): Ad[] {
  const count = Math.min(6, seed.hooks.length);
  return seed.hooks.slice(0, count).map((hook, i) => {
    const active = i < Math.ceil(count / 2);
    const len = i === 0 ? seed.longestAd : Math.max(4, Math.round(seed.longestAd * (0.72 - i * 0.12)));
    const end = active ? 90 : Math.max(len + 2, 78 - i * 13);
    return {
      id: `${seed.slug}-ad-${i}`, network: i % 3 === 2 ? "Google" : "Meta", hook,
      format: ["Vertical video", "UGC video", "Static image"][i % 3], start: Math.max(0, end - len), end, active, hue: (i * 47 + 180) % 360,
    };
  });
}

function build(seed: Seed & Metrics): Product {
  const m = MODEL[seed.model];
  const coverage = seed.coverage ?? "full";
  const { verb, noun } = seed.product;
  const quizSteps: Step[] = seed.quiz.map((q, i) => ({
    stage: "onboarding", title: i === 0 ? "Personalization quiz" : `Quiz, question ${i + 1}`, screen: "quiz",
    quiz: { q: q.q, options: q.options, n: i + 1, of: seed.quiz.length },
    why: i === 0 ? "One easy question gets a user moving, and each answer makes the result feel made for them." : "Each answer adds to the effort already invested and gives the sales copy something specific to reflect back.",
    cost: "No model calls yet. Answers are saved to the profile and used to pick defaults later.",
    pricing: i === 0 ? "Nothing about price yet, on purpose." : "Answers can decide which plan is recommended later.",
    logic: [`save onboarding.step_${i + 1}`, "progress bar advances", i === seed.quiz.length - 1 ? "on finish → continue" : "on answer → next question"],
    pins: [{ x: 50, y: 11, note: "Progress bar makes the end feel close." }, { x: 50, y: 56, note: "Large single-tap answers. No typing." }], capturedAt: WHEN,
  }));
  const isHard = seed.model === "hard";
  const steps: Step[] = [
    {
      stage: "landing", title: "The promise", screen: "landing",
      why: "The headline sells the result, not the tool. Visitors see what they'd get before reading anything about how it works.",
      cost: "A pre-made demo plays on the page, so curious visitors cost nothing.",
      pricing: "No price above the fold. The only ask is to try it.",
      logic: ["utm_source saved to cookie", "primary CTA → /signup"],
      pins: [{ x: 48, y: 30, note: "Outcome headline in under ten words." }, { x: 35, y: 59, note: "One button, with no pricing link next to it." }, { x: 73, y: 50, note: "Demo shows the finished result straight away." }], capturedAt: WHEN,
    },
    {
      stage: "signup", title: "One-click sign in", screen: "signup",
      why: "Only social sign-in is offered, which removes passwords and captures a verified email before the user can leave.",
      cost: "Requiring an account limits free-tier abuse before any model is called.",
      pricing: "\"No card required\" removes the main worry at this moment.",
      logic: ["on auth_success → create profile", "grant starting allowance", "redirect → /onboarding"],
      pins: [{ x: 75, y: 50, note: "Google is first and largest." }, { x: 75, y: 72, note: "Reassurance sits right under the buttons." }], capturedAt: WHEN,
    },
    ...quizSteps,
    {
      stage: "activation", title: isHard ? "Personalized loading screen" : `First ${noun}`, screen: isHard ? "loading" : "aha",
      why: isHard ? "A personalized loading screen builds anticipation, and it runs just before the price appears." : `The user gets a real ${noun} within a minute of signing up. This is the moment the product proves itself.`,
      cost: isHard ? "Nothing is generated yet. The progress is decorative until payment." : "The first result uses the cheapest model that still looks good.",
      pricing: "Sets up the paywall that follows by building perceived value first.",
      logic: isHard ? ["progress animates 0 → 100 over 6s", "copy cycles through quiz answers", "on done → open paywall"] : [`on ${verb} → run job`, "stream result into the page", "allowance - 1"],
      pins: [{ x: 50, y: 42, note: isHard ? "Loading copy repeats their quiz answers." : "The result fills the screen." }, { x: 50, y: 82, note: "Clear next action right below." }], capturedAt: WHEN,
    },
    { stage: "paywall", title: m.title, screen: "paywall", why: m.why, cost: m.cost, pricing: m.pricing, logic: m.logic, pins: m.pins, capturedAt: WHEN },
    {
      stage: "retention", title: "Saving the cancel", screen: "retention",
      why: "Cancelling routes through an offer screen, so a user who only wanted a lower price doesn't leave.",
      cost: "Downgrades keep lower-cost users instead of losing them.",
      pricing: "Offers a discount or a pause before confirming the cancellation.",
      logic: ["on cancel_click → ask reason", "reason == price → offer 50% off", "reason == not_using → offer pause"],
      pins: [{ x: 79, y: 40, note: "Reason picker decides the offer." }, { x: 79, y: 74, note: "Offer button is larger than cancel." }], capturedAt: WHEN,
    },
  ];
  const kinds: CreatorItem["kind"][] = ["Sponsored", "Mention", "Sponsored", "Affiliate"];
  const { quiz: _quiz, hooks: _hooks, channels, ...rest } = seed;
  return {
    ...rest, coverage, ads: makeAds(seed), steps: coverage === "full" ? steps : [],
    creatorItems: channels.map((channel, i) => ({
      channel, kind: kinds[i % 4],
      title: `${["I tried", "Why everyone uses", "The truth about", "How I use"][i % 4]} ${seed.name}${i % 2 ? "" : " for 30 days"}`,
      views: ["412K", "87K", "1.2M", "36K"][i % 4], date: ["Oct 28", "Oct 12", "Sep 30", "Sep 9"][i % 4],
    })),
  };
}

const t = (accent: string, light = false): Theme => light
  ? { accent, bg: "#ffffff", fg: "#111318", muted: "#667085", surface: "#f4f5f7", line: "#e4e6ea", radius: 12 }
  : { accent, bg: "#0c0d12", fg: "#f6f6f8", muted: "#9398a6", surface: "#191b23", line: "#2a2d38", radius: 14 };

const QUIZ_CREATOR = [
  { q: "What do you want to make?", options: ["Faceless Shorts", "Podcast clips", "Product demos", "Ads"] },
  { q: "How often do you post?", options: ["Every day", "A few times a week", "Once a week", "Just starting"] },
  { q: "What's your main goal?", options: ["Grow an audience", "Sell a product", "Earn from views", "Save time"] },
];
const QUIZ_BUSINESS = [
  { q: "What's your role?", options: ["Founder", "Sales", "Marketing", "Agency"] },
  { q: "How big is your team?", options: ["Just me", "2-10", "11-50", "50+"] },
];
const QUIZ_CONSUMER = [
  { q: "What brings you here?", options: ["Study", "Work", "Personal projects", "Just curious"] },
  { q: "How much time would you like to save?", options: ["A little", "A few hours a week", "A lot", "All of it"] },
  { q: "How do you like to learn?", options: ["Summaries", "Flashcards", "Practice tests", "Audio"] },
  { q: "Pick your starting level", options: ["Beginner", "Comfortable", "Advanced", "Expert"] },
];

const seeds: Seed[] = [
  { slug: "reelkite", what: "Faceless Shorts maker.", adsDelta: 3, creatorsDelta: 2, mechanic: "Free Credits → Packs", lastSeen: 3, name: "Reelkite", domain: "reelkite.example", tagline: "Turn any idea into a faceless Short", category: "video", model: "credit", activeAds: 14, longestAd: 74, creators: 19, stack: ["Next.js", "Clerk", "Stripe", "PostHog"], price: { month: "$29", year: "$19", credits: "$9" }, product: { verb: "generate", noun: "video" }, theme: t("#ff4d8d"), quiz: QUIZ_CREATOR, hooks: ["\"I made $4k from a faceless channel\"", "Split-screen: prompt to finished Short", "Stop filming yourself", "3 videos in 5 minutes", "POV: your channel runs itself", "Before and after edit"], channels: ["Creator Lab", "Faceless Empire", "Tiny Studio", "AI Hustle Daily"] },
  { slug: "shipgrid", what: "Prompt-to-app builder.", adsDelta: 0, creatorsDelta: 6, mechanic: "Project Limit → Pro", lastSeen: 8, name: "Shipgrid", domain: "shipgrid.example", tagline: "Describe an app and get it deployed", category: "coding", model: "subscription", activeAds: 6, longestAd: 42, creators: 44, stack: ["Next.js", "Supabase", "Stripe", "Vercel"], price: { month: "$25", year: "$20" }, product: { verb: "build", noun: "app" }, theme: t("#7c5cff"), quiz: QUIZ_BUSINESS, hooks: ["Build a SaaS before lunch", "Watch: full app from one prompt", "No code, real database", "Your idea, deployed in 60s"], channels: ["Code With Maya", "Vibe Shipping", "The Build Log", "Solo Stack"] },
  { slug: "clipmoth", what: "Turns long videos into clips.", adsDelta: 1, creatorsDelta: 4, mechanic: "Watermark → Export", lastSeen: 6, name: "Clipmoth", domain: "clipmoth.example", tagline: "Find the viral moments in long videos", category: "video", model: "watermark", activeAds: 9, longestAd: 51, creators: 31, stack: ["Remix", "Auth0", "Paddle", "Mixpanel"], price: { month: "$19", year: "$12" }, product: { verb: "clip", noun: "clip" }, theme: t("#e88a00", true), quiz: QUIZ_CREATOR.slice(0, 2), hooks: ["One podcast, 20 Shorts", "This AI found my best moment", "Editors hate this", "Clips with captions in a click", "From 2 hours to 60 seconds"], channels: ["Podcast Growth", "Edit Less", "Short Form School", "Creator Lab"] },
  { slug: "leadlark", what: "AI SDR that books meetings.", adsDelta: 0, creatorsDelta: 0, mechanic: "Usage Meter → Scale", lastSeen: 21, name: "Leadlark", domain: "leadlark.example", tagline: "An AI SDR that books your meetings", category: "sales", model: "usage", activeAds: 4, longestAd: 38, creators: 8, stack: ["Next.js", "Supabase", "Stripe", "Segment"], price: { month: "$49", year: "$39" }, product: { verb: "send", noun: "campaign" }, theme: t("#16a34a", true), quiz: QUIZ_BUSINESS, hooks: ["Fire your SDR agency", "12 meetings in 2 weeks", "Cold email that sounds human", "Replies while you sleep"], channels: ["B2B Growth Show", "Outbound Weekly"] },
  { slug: "quillhare", what: "AI exam study plans.", adsDelta: 4, creatorsDelta: 1, mechanic: "4-Step Quiz → Wall", lastSeen: 12, name: "Quillhare", domain: "quillhare.example", tagline: "Pass any exam with AI study plans", category: "consumer", model: "hard", activeAds: 22, longestAd: 96, creators: 12, stack: ["Next.js", "Firebase", "Stripe", "Amplitude"], price: { week: "$6.99", month: "$19", year: "$59" }, product: { verb: "study", noun: "study plan" }, theme: t("#2f6bff", true), quiz: QUIZ_CONSUMER, hooks: ["Failing? Try this tonight", "I went from a C to an A", "Your personal AI tutor", "POV: finals in 3 days", "Study less, score higher", "This app knows your exam"], channels: ["Study With Lena", "Gen Z Money", "College Hacks", "Campus Tech"] },
  { slug: "voicelark", what: "One-minute voice cloning.", adsDelta: 2, creatorsDelta: 3, mechanic: "Credit Packs", lastSeen: 14, name: "Voicelark", domain: "voicelark.example", tagline: "Clone a voice from one minute of audio", category: "video", model: "credit", activeAds: 5, longestAd: 33, creators: 11, stack: ["SvelteKit", "Supabase", "Polar", "PostHog"], price: { month: "$15", credits: "$5" }, product: { verb: "narrate", noun: "voiceover" }, theme: t("#00c2a8"), quiz: QUIZ_CREATOR.slice(0, 2), hooks: ["This isn't my real voice", "Narrate a whole video in seconds", "Dub into 20 languages"], channels: ["Tiny Studio", "Voice Nerds", "Creator Lab"] },
  { slug: "sheetowl", what: "Chat with your spreadsheets.", adsDelta: 0, creatorsDelta: 3, mechanic: "Free Tool → Pro", lastSeen: 17, name: "Sheetowl", domain: "sheetowl.example", tagline: "Ask your spreadsheets anything", category: "consumer", model: "free", activeAds: 0, longestAd: 0, creators: 16, stack: ["Astro", "Clerk", "Lemon Squeezy"], price: { month: "$8" }, product: { verb: "ask", noun: "answer" }, theme: t("#d6358a", true), quiz: QUIZ_CONSUMER.slice(0, 1), hooks: [], channels: ["Excel Unboxed", "AI Tools Weekly", "The Build Log"] },
  { slug: "promptyard", what: "AI pull request reviews.", adsDelta: -1, creatorsDelta: 1, mechanic: "Usage Credits", lastSeen: 24, name: "Promptyard", domain: "promptyard.example", tagline: "Review every pull request with AI", category: "coding", model: "usage", activeAds: 3, longestAd: 27, creators: 23, stack: ["Next.js", "WorkOS", "Stripe", "PostHog"], price: { month: "$19", year: "$15" }, product: { verb: "review", noun: "review" }, theme: t("#ff6b35"), quiz: QUIZ_BUSINESS, hooks: ["Your AI code needs a reviewer", "Caught this bug in 8 seconds", "Ship faster, break less"], channels: ["Code With Maya", "Solo Stack", "Vibe Shipping"] },
];

// Everything below is generated sample data, so the UI can be judged at realistic scale.
const rand = (i: number, salt: number) => {
  const x = Math.sin(i * 127.1 + salt * 311.7) * 43758.5453;
  return x - Math.floor(x);
};
const pick = <T,>(list: readonly T[], i: number, salt: number) => list[Math.floor(rand(i, salt) * list.length)];

const TEMPLATES = [
  { category: "video", what: "AI video editor.", tagline: "Edit videos by describing the changes", verb: "generate", noun: "video", quiz: QUIZ_CREATOR },
  { category: "coding", what: "AI coding assistant.", tagline: "Ship features from plain English", verb: "build", noun: "app", quiz: QUIZ_BUSINESS },
  { category: "sales", what: "AI outbound tool.", tagline: "Fill your calendar with qualified calls", verb: "send", noun: "campaign", quiz: QUIZ_BUSINESS },
  { category: "consumer", what: "AI personal coach.", tagline: "Build better habits with daily guidance", verb: "plan", noun: "plan", quiz: QUIZ_CONSUMER },
  { category: "image", what: "AI image generator.", tagline: "Create on-brand images in seconds", verb: "create", noun: "image", quiz: QUIZ_CREATOR },
  { category: "writing", what: "AI writing assistant.", tagline: "Draft anything in your own voice", verb: "write", noun: "draft", quiz: QUIZ_BUSINESS },
  { category: "audio", what: "AI voice tool.", tagline: "Turn text into natural speech", verb: "narrate", noun: "voiceover", quiz: QUIZ_CREATOR },
  { category: "marketing", what: "AI ad creative tool.", tagline: "Make ad creatives that convert", verb: "launch", noun: "campaign", quiz: QUIZ_BUSINESS },
] as const;
const MECHANIC: Record<Model, string> = { credit: "Free Credits → Packs", hard: "Quiz → Hard Wall", watermark: "Watermark → Export", usage: "Usage Meter → Scale", free: "Free Tool → Pro", subscription: "Project Limit → Pro" };
const PREFIX = ["Frame", "Loop", "Draft", "Pixel", "Quill", "Spark", "Tally", "Nimbus", "Orbit", "Relay", "Fable", "Cinder", "Harbor", "Lumen", "Mosaic", "Prism", "Rivet", "Sable", "Thread", "Vector"];
const SUFFIX = ["ly", "kit", "pilot", "forge", "flow", "base", "hive", "stack", "mint", "wave", "dock", "lab", "sense", "grid", "cast"];
const ACCENTS = ["#ff4d8d", "#7c5cff", "#e88a00", "#16a34a", "#2f6bff", "#00c2a8", "#d6358a", "#ff6b35", "#0ea5e9", "#a855f7", "#ef4444", "#14b8a6"];
const STACKS = [["Next.js", "Clerk", "Stripe", "PostHog"], ["Next.js", "Supabase", "Stripe", "Vercel"], ["Remix", "Auth0", "Paddle", "Mixpanel"], ["SvelteKit", "Supabase", "Polar", "PostHog"], ["Astro", "Clerk", "Lemon Squeezy"]];
const HOOKS = ["\"I can't believe this is AI\"", "Watch: done in one prompt", "Stop doing this by hand", "Before and after", "10x faster than last year", "POV: it just works"];
const CHANNELS = ["Creator Lab", "AI Tools Weekly", "The Build Log", "Solo Stack", "Tiny Studio", "Growth Notes"];
const MODELS = Object.keys(MECHANIC) as Model[];

const generated: Seed[] = PREFIX.flatMap((pre, a) => SUFFIX.map((suf, b) => {
  const i = a * SUFFIX.length + b + 100;
  const tpl = pick(TEMPLATES, i, 1);
  const model = pick(MODELS, i, 2);
  const name = pre + suf;
  const hasAds = rand(i, 3) > 0.22;
  const activeAds = hasAds ? 1 + Math.floor(rand(i, 4) ** 2 * 42) : 0;
  const month = 9 + Math.floor(rand(i, 7) * 40);
  return {
    coverage: rand(i, 40) < 0.3 ? "full" : "signals", slug: name.toLowerCase(), name, domain: name.toLowerCase() + ".example", what: tpl.what, tagline: tpl.tagline, category: tpl.category, model,
    adsDelta: hasAds ? Math.floor(rand(i, 5) * 9) - 2 : 0, creatorsDelta: Math.floor(rand(i, 6) * 8) - 1,
    mechanic: MECHANIC[model], lastSeen: 2 + Math.floor(rand(i, 8) * 1400),
    activeAds, longestAd: hasAds ? 4 + Math.floor(rand(i, 9) * 110) : 0, creators: Math.floor(rand(i, 10) ** 2 * 60),
    stack: [...pick(STACKS, i, 11)],
    price: { week: `$${(month / 3).toFixed(2)}`, month: `$${month}`, year: `$${Math.round(month * 0.75)}`, credits: `$${5 + Math.floor(month / 5)}` },
    product: { verb: tpl.verb, noun: tpl.noun }, theme: t(pick(ACCENTS, i, 12), rand(i, 13) > 0.5),
    quiz: tpl.quiz.map((q) => ({ q: q.q, options: [...q.options] })), hooks: hasAds ? HOOKS.slice(0, 2 + Math.floor(rand(i, 14) * 5)) : [], channels: CHANNELS.slice(0, 1 + Math.floor(rand(i, 15) * 4)),
  };
}));

const KNOWN: Record<string, Pick<Metrics, "revenue" | "confidence" | "growth" | "firstSeen">> = {
  reelkite: { revenue: [40, 70], confidence: 3, growth: 38, firstSeen: 142 },
  shipgrid: { revenue: [120, 200], confidence: 4, growth: 64, firstSeen: 236 },
  clipmoth: { revenue: [25, 45], confidence: 3, growth: 22, firstSeen: 310 },
  leadlark: { revenue: [60, 110], confidence: 2, growth: 4, firstSeen: 388 },
  quillhare: { revenue: [80, 150], confidence: 3, growth: 71, firstSeen: 95 },
  voicelark: { revenue: [15, 30], confidence: 2, growth: 118, firstSeen: 24 },
  sheetowl: { revenue: [5, 12], confidence: 1, growth: 87, firstSeen: 12 },
  promptyard: { revenue: [30, 55], confidence: 3, growth: -6, firstSeen: 201 },
};
function metrics(seed: Seed, i: number): Metrics {
  const known = KNOWN[seed.slug];
  const low = 2 + Math.floor(rand(i, 20) ** 3 * 320);
  const growth = known?.growth ?? Math.round(rand(i, 21) ** 2 * 190 - 35);
  const first = known?.firstSeen ?? 1 + Math.floor(rand(i, 22) * 420);
  return {
    revenue: known?.revenue ?? [low, Math.round(low * 1.7)],
    confidence: known?.confidence ?? (1 + Math.floor(rand(i, 23) * 4)) as Metrics["confidence"],
    growth, firstSeen: first,
    spark: Array.from({ length: 12 }, (_, k) => Math.max(1, 20 + (growth / 100) * k * 2.5 + (rand(i, 30 + k) - 0.5) * 9)),
  };
}

export const products: Product[] = [...seeds, ...generated].map((seed, i) => build({ ...seed, ...metrics(seed, i) }));
const BY_SLUG = new Map(products.map((p) => [p.slug, p]));
export const bySlug = (slug?: string) => (slug ? BY_SLUG.get(slug) : undefined);
export const formatRevenue = (r: [number, number]) => `$${r[0]}–${r[1]}k`;
export const postLoginCount = (p: Product) => p.steps.filter((x) => x.stage !== "acquisition" && x.stage !== "landing" && x.stage !== "signup").length;
/** The one product anyone can open in full without signing in. */
export const SAMPLE_SLUG = "quillhare";

/** One line of observed evidence for why a product is worth opening. */
export function verdict(p: Product) {
  if (!p.activeAds) return `No active ads, seen in ${p.creators} YouTube videos.`;
  if (p.longestAd >= 50) return `Longest ad seen across ${p.longestAd} days.`;
  if (p.growth >= 60) return `Ads and creators up ${p.growth}% in 4 weeks.`;
  if (p.creators >= 30) return `${p.creators} YouTube sponsors.`;
  if (p.adsDelta > 0) return `Added ${p.adsDelta} ads this week.`;
  return `${p.activeAds} active ads, longest ${p.longestAd} days.`;
}

export type ChangeKind = "ads" | "creators" | "paywall" | "flow";
export type Change = { id: string; slug: string; kind: ChangeKind; text: string; daysAgo: number };
export const CHANGE_LABEL: Record<ChangeKind, string> = { ads: "Ads", creators: "Creators", paywall: "Paywall & pricing", flow: "Onboarding" };
export const CHANGES: Change[] = [
  { id: "c1", slug: "quillhare", kind: "ads", text: "Launched 4 new ad creatives", daysAgo: 0 },
  { id: "c2", slug: "reelkite", kind: "paywall", text: "Paywall now appears after the first video instead of the third", daysAgo: 0 },
  { id: "c3", slug: "shipgrid", kind: "creators", text: "6 new YouTube sponsors this week", daysAgo: 1 },
  { id: "c4", slug: "clipmoth", kind: "paywall", text: "Pro plan dropped from $24 to $19 a month", daysAgo: 1 },
  { id: "c5", slug: "voicelark", kind: "flow", text: "Onboarding shortened from 3 steps to 2", daysAgo: 2 },
  { id: "c6", slug: "reelkite", kind: "ads", text: "Longest ad passed 70 days and is still running", daysAgo: 3 },
  { id: "c7", slug: "promptyard", kind: "ads", text: "Paused 1 ad", daysAgo: 5 },
  { id: "c8", slug: "sheetowl", kind: "creators", text: "Seen in 3 new YouTube videos", daysAgo: 6 },
];
export const hasBlueprint = (p: Product) => p.coverage === "full" && p.model !== "free";

export function blueprint(p: Product) {
  const m = MODEL[p.model];
  return `## Commercial pattern: ${m.title} (from ${p.name})

Build an original version of this pattern in my project. Adapt names, copy and visuals to my product.

### 1. Data
- \`onboarding_profiles\`: user_id, answers (json), completed_at
- \`entitlements\`: user_id, plan, credits_remaining, period_end

### 2. Rules
${m.rules.map(([a, b]) => `- ${a}: ${b}`).join("\n")}

### 3. Logic
${m.logic.map((l) => `- ${l}`).join("\n")}

### 4. States
${m.transitions.map(([a, e, b]) => `- ${a} --${e}--> ${b}`).join("\n")}

### 5. UI
- Onboarding: ${p.steps.filter((s) => s.stage === "onboarding").length} steps with a progress bar
- Upgrade modal with ${p.price.year ? "annual selected by default" : "one recommended plan"}
- Server-side checks before every model call`;
}

# DEPLOY.md — Content Rater ($0 version), click by click

No coding needed. You will click through 4 websites (all free): Supabase,
Google Cloud, Google AI Studio, Groq — then put the code on GitHub and Vercel.
Budget ~45 minutes. Keep this page open while you work.

**You will end up with 5 secret values.** Paste them only into Vercel's
environment-variable boxes (Part 6). Never post them anywhere else.

---

## Part 1 — Supabase: database + login (free)

1. Go to **supabase.com** and click **Start your project**.
2. Sign up with your GitHub account (click **Continue with GitHub**, then **Authorize**).
3. On the dashboard, click **New project**.
4. Pick any **Organization** (create one if asked — name it anything).
5. **Name** the project `content-rater`, set a **Database Password** (write it down somewhere safe), pick the region closest to you, click **Create new project**.
6. Wait ~2 minutes while it spins up. ☕
7. In the left sidebar, click **SQL Editor**, then click **New query**.
8. Open the `schema.sql` file from the zip I sent you, copy ALL of it, paste it into the query box, and click **Run** (bottom right). You should see "Success. No rows returned".
9. In the left sidebar, click the **gear icon (Project Settings)** at the bottom, then click **API**.
10. Copy these three values into a notes file — you'll need them in Part 6:
    - **Project URL** (looks like `https://xyzcompany.supabase.co`)
    - **anon public** key (long string)
    - **service_role** key (long string — click **Reveal** to see it). **This one is secret.**

## Part 2 — Google Cloud: let users "Sign in with Google" (free)

Supabase handles the login, but Google needs to know about your app first.

1. Go to **console.cloud.google.com** and sign in with your Google account.
2. At the top bar, click the **project dropdown** (it may say "Select a project"), then click **New Project**.
3. Name it `content-rater`, click **Create**, then select it in the dropdown.
4. In the left menu (☰), go to **APIs & Services → OAuth consent screen**.
5. Click **Get started**, enter:
   - **App name:** `Content Rater`
   - **User support email:** your email
   - **Developer contact:** your email
   then click through **Next / Save** until you reach the dashboard.
6. In the left menu, go to **APIs & Services → Credentials**.
7. Click **+ Create Credentials → OAuth client ID**.
8. **Application type:** Web application. **Name:** `content-rater-web`.
9. Under **Authorized redirect URIs**, click **Add URI** and paste:
   `https://YOUR-PROJECT-REF.supabase.co/auth/v1/callback`
   (replace `YOUR-PROJECT-REF` with the first part of your Supabase Project URL from Part 1, step 10 — e.g. if the URL is `https://abc123.supabase.co`, the ref is `abc123`).
10. Click **Create**. A popup shows your **Client ID** and **Client secret** — copy both into your notes file.
11. Back in **Supabase**: left sidebar → **Authentication** → **Providers** → find **Google** and click it.
12. Toggle it **Enabled**, paste the **Client ID** and **Client secret**, click **Save**.

## Part 3 — Gemini key: the free AI grader (free, no credit card)

1. Go to **aistudio.google.com** and sign in.
2. Click **Get API key** (top area / left menu).
3. Click **Create API key**, choose any project, click **Create**.
4. Copy the key (starts with `AIza…`) into your notes file. **Secret.**

## Part 4 — Groq key: free backup AI (free, no credit card)

1. Go to **console.groq.com** and sign up (Google sign-in works).
2. Left menu → **API Keys** → **Create API Key**.
3. Name it `content-rater`, click **Submit**, copy the key (starts with `gsk_…`) into your notes file. **Secret.**

## Part 5 — GitHub: put the code online (free)

1. Unzip the `content-rater-v2.zip` file I sent you (double-click it).
2. Go to **github.com**, sign in, click the **+** (top right) → **New repository**.
3. **Repository name:** `content-rater`, leave it **Public**, click **Create repository**.
4. On the new repo page, click the **"uploading an existing file"** link.
5. Drag in ALL the unzipped files (`index.html`, `styles.css`, `app.js`, the `api` folder, `vercel.json`, `.env.example`, `schema.sql`, `README.md`, `DEPLOY.md`). **Do NOT upload any file with real keys in it** (there isn't one — `.env.example` has fakes).
6. Click **Commit changes**.

## Part 6 — Vercel: launch the website (free)

1. Go to **vercel.com**, click **Sign Up**, choose **Continue with GitHub**, **Authorize**.
2. Click **Add New… → Project**, find `content-rater` in the list, click **Import**.
3. Open **Environment Variables** (expand the section). Add these 5, one by one
   (paste the values from your notes file):
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `GEMINI_API_KEY`
   - `GROQ_API_KEY`
4. Click **Deploy**. Wait ~1 minute.
5. Vercel shows you your live URL (like `content-rater.vercel.app`). Open it. 🎉

## Part 7 — Test it

1. Click **Sign in with Google**, pick your account, allow.
2. You should see **"3 of 3 free grades left today"** at the top.
3. Fill the Creative Brief (goal → platforms → viewer), continue, upload a short video.
4. Wait ~30–60 seconds. You get the report card: Creative quality + Goal alignment,
   breakdown, fixes, hook rewrites. **That's the first real AI test — tell Bennett how it goes.**

## If something breaks

- **"Server not configured yet"** on the page → an env var is missing/typo'd in Vercel → Settings → Environment Variables → fix → redeploy (Deployments → ⋯ → Redeploy).
- **Google sign-in error / redirect mismatch** → recheck Part 2 step 9: the redirect URI must match your Supabase project ref exactly.
- **"Daily limit reached" on first try** → the quota row got stuck; in Supabase → Table Editor → `usage` → delete the row, try again.
- **Grading fails / spins forever** → check the keys (Part 3–4) are pasted correctly with no extra spaces; free-tier rate limits reset every minute/day.

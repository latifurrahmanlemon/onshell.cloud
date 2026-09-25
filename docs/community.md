# Community publishing

The public editorial community lives at `/community`. It includes searchable,
topic-filtered guides, individual articles, reading times, an RSS feed, social
images, related guides and a contact link for topic suggestions. Posts are
versioned content, not user-submitted forum threads or an admin CMS.

## The first campaign

Twenty original English guides are stored in
`apps/web/src/content/community/posts.json`. By default the first publishes on
**26 September 2026 at 09:00 Bangladesh time (03:00 UTC)**. One further guide
publishes every 24 hours, ending **15 October 2026 at 09:00 Bangladesh time**.

| Day | Publication date (09:00 Bangladesh) | Guide |
| --- | --- | --- |
| 1 | 2026-09-26 | Getting started with Onshell: your first saved SSH host |
| 2 | 2026-09-27 | Browser SSH or desktop SSH: which connection should you use? |
| 3 | 2026-09-28 | Prepare Onshell Desktop for offline SSH before an outage |
| 4 | 2026-09-29 | How local-first sync works in Onshell Desktop |
| 5 | 2026-09-30 | Organize hosts with names, tags and favorites |
| 6 | 2026-10-01 | Use the credential vault without mixing up host access |
| 7 | 2026-10-02 | An SSH connection failed: work through the reason |
| 8 | 2026-10-03 | Copy terminal output without interrupting commands |
| 9 | 2026-10-04 | Build a snippet library your team can actually use |
| 10 | 2026-10-05 | Use SFTP alongside your local files in Onshell |
| 11 | 2026-10-06 | Use Onshell Tasks as a checklist for server work |
| 12 | 2026-10-07 | Open repeatable host groups with Onshell Workspaces |
| 13 | 2026-10-08 | Plan team roles and host access in Onshell |
| 14 | 2026-10-09 | Rotate SSH credentials when desktop clients can work offline |
| 15 | 2026-10-10 | Read session history and audit without confusing the two |
| 16 | 2026-10-11 | What to check after Onshell Desktop reconnects |
| 17 | 2026-10-12 | A practical update checklist for a self-hosted Onshell portal |
| 18 | 2026-10-13 | Use a local shell beside remote SSH in Onshell Desktop |
| 19 | 2026-10-14 | Give your workspace a recognizable organization identity |
| 20 | 2026-10-15 | Your first week with Onshell: a practical team rollout |

## How scheduling works

The Next.js server checks its clock on each request. The article, metadata,
image, RSS and sitemap routes use the same publication gate. A future article
returns 404; its title/body is absent from public index, related links, feed and
sitemap. Publication needs no cron, database migration or daily rebuild. The web
server must be running, with an accurate system clock. An already open page
shows new publications on refresh; RSS readers fetch on their own schedule.

This is an availability schedule, not an email or social-media posting service.
Repository contributors can read the prepared files; publication gating is not
intended to make content in the public source repository confidential.

If deploying after the initial date, guides whose dates have passed become
available immediately. To start a fresh campaign, set a fixed server-side
`COMMUNITY_START_AT` **before the first production launch**, for example:

```dotenv
COMMUNITY_START_AT=2026-09-26T09:00:00+06:00
```

Keep that timestamp stable across restarts, deployments and web instances.
Changing it shifts every publication date. Do not set it to the current date
on every deploy. Pass the value to the Next.js service environment, not only the
API; reload the web process after changing it. It is not a NEXT_PUBLIC variable.
The default works without adding any environment variable.

Do not cache `/community`, `/community/*` or `/sitemap.xml` at a reverse proxy/CDN.
Respect Next.js dynamic/no-store response headers, including 404s. Otherwise a
cached empty index or early 404 can hide a newly published post. Purge existing
cache rules for these paths when enabling the feature. Never use static export
for these routes.

## Editing and adding guides

Edit the JSON file, validate with `yarn test apps/web/src/lib/community.test.ts`,
then build and deploy web. Each entry has a unique lowercase slug, title,
description, topic, short answer, sections, a three-item checklist and a relevant
product link. React escapes all prose; no arbitrary HTML or script is accepted.

Keep the initial 20 entries in their current order: array position determines
the daily publication date. Append additional guides to continue the daily
schedule. If appending after their calculated dates have passed, those entries
publish immediately. Update the campaign-size assertion in the content test when
intentionally expanding the campaign. Keep published slugs stable so links remain
valid. For meaningful revisions to published articles, extend the content model
with an explicit modification timestamp instead of inventing a new date on
request. Currently dateModified equals the initial publication date.

## Search and AI discovery

The full text is server-rendered and publicly readable without signing in.
Each article has its own canonical URL, description, Open Graph/Twitter image,
BlogPosting and breadcrumb structured data. The sitemap and RSS contain only
published guides and use their publication dates. Search/filter result pages are
noindex/follow with a canonical link to the main community page. Public nav,
footer and llms.txt link to the community.

The content uses clear headings, direct answers and factual product descriptions.
There is no special AI-ranking schema or promise of search ranking/citations.
Google's guidance applies ordinary SEO and helpful content to AI search:
https://developers.google.com/search/docs/appearance/ai-features
Article markup guidance:
https://developers.google.com/search/docs/appearance/structured-data/article

After production deployment, submit `/sitemap.xml` in the site's Search Console,
inspect the first published URL, and check its markup with Google's Rich Results
Test. Indexing and external feed refreshes are controlled by those services.

## Deployment and verification

Follow the normal update sequence in [deployment.md](deployment.md). This feature
changes web only and adds no Prisma migration or desktop release requirement.
After rebuilding, restart/reload the web process with its production environment.
Check `/community`, `/community/feed.xml`, `/sitemap.xml` and a published article
(including its `/image` URL). Before the campaign begins the empty index and
empty feed are expected, and all article URLs should return 404.

For local preview of all twenty guides, run the production web server with an
isolated `COMMUNITY_START_AT` at least 20 days in the past. Do not copy that
preview override into production.

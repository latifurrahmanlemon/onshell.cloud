# Community administration

Manage content in **Admin > Community** using a platform administrator account.
Organization administrators and regular members cannot read drafts or change
community content. All create, update and delete actions are audit-logged.

## Editor

- Create, edit, preview and permanently delete posts.
- Search by title, slug or summary; filter by status and category; page through results.
- Set title, stable URL slug, summary, short answer, author and category. Type a
  new category or choose an existing one. Categories are labels on posts; rename
  or remove a label by editing the affected posts.
- Add, remove and reorder sections; separate paragraphs with a blank line.
- Edit the next-steps checklist and internal product link.
- Upload a PNG/JPEG/WebP cover (up to 5 MB before resizing) and its accessible
  description. Images are resized to 1200 pixels, stored in the database and
  included in normal database backups. The encoded image must remain under 300 KB.
- Set an optional SEO title and description. Otherwise the article title and
  summary are used. Canonicals, BlogPosting/breadcrumb data and social images
  are generated automatically.

Save as **Draft** to keep a post private. Select **Published** to publish now, or
**Scheduled** to choose a future date. The editor's schedule is explicitly in
Bangladesh time (UTC+06:00); the list displays dates in your browser timezone.
Past dates publish immediately after saving. Editing an already published post
keeps its publication date unless you change it. Select Draft and save to unpublish.

The preview is private inside the admin editor and includes unsaved changes.
Save explicitly; leaving an edited post asks before discarding changes. If
another administrator saves first, your save is rejected as a conflict and your
text is retained. Copy your changes, reload the post and merge them.

Changing a published slug changes its URL; automatic redirects are not created.
Prefer keeping published slugs stable. Deletion is permanent after confirmation.

## Existing twenty guides and deployment

Migration `20260926090000_community_cms` creates the content table and imports all
20 English guides once. Their initial schedule remains **26 September–15 October
2026, one per day at 09:00 Bangladesh time**. Already-due posts are immediately
public after deployment. They can all be edited, unpublished, rescheduled or
deleted in Admin > Community. Later deploys never overwrite edits or restore deletions.

The old `COMMUNITY_START_AT` environment variable is no longer used: each post
has its own database publication time. If a custom campaign start was previously
configured, adjust the imported dates in Admin before making the upgraded web
service public. The original readable content is archived in
`docs/community-starter-posts.json` for reference, not used at runtime.

Deploy **API and web together**. From the production checkout, using the same
user that runs PM2, back up the database, then:

```bash
cd /home/onshell/htdocs/onshell.cloud
set -a && source .env && set +a
git pull --ff-only origin master &&
yarn install --immutable &&
yarn db:generate &&
yarn db:deploy &&
yarn build &&
pm2 reload ecosystem.config.cjs --update-env
```

No seed command, cron job or desktop release is needed. Follow
[deployment.md](deployment.md) for backup, process checks and rollback practices.

The Next.js server reads the API on each request with no-store. It uses
`NEXT_PUBLIC_API_BASE_URL` by default. If the server needs an internal address,
set **`COMMUNITY_API_URL=http://127.0.0.1:5017`** in the web service environment
(use your actual API port/base path). This is server-only and optional.

Do not proxy-cache `/community`, `/community/*`, `/sitemap.xml` or
`/api/public/community*`, including 404 responses. Purge any existing cached
community pages when deploying this upgrade. Open pages show changes on refresh.
If the API is unavailable, the page shows an error; it never resurrects deleted
or unpublished posts from bundled files.

## Verification

1. Open Admin > Community and confirm the twenty migrated posts and dates.
2. Save a draft and preview it; its public URL must return 404.
3. Schedule a test post, confirm it stays hidden, then verify it appears after
   the timestamp without restarting or rebuilding any service.
4. Edit the title/SEO fields and verify the page, RSS and sitemap on refresh.
5. Unpublish and delete a test post; verify it disappears from all public surfaces.
6. Verify another admin's stale edit is rejected instead of overwriting changes.

Public article bodies remain server-rendered. Submit `/sitemap.xml` to Search
Console and inspect a published URL after deployment. This supports ordinary
search and AI discovery; rankings and citations are not guaranteed.

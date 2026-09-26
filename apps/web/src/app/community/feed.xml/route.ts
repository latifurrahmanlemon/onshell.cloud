import { publishedPosts, xmlEscape } from "../../../lib/community";
import { absoluteUrl } from "../../../lib/site";
export const dynamic = "force-dynamic";
export async function GET() {
  const posts = await publishedPosts();
  const feed = absoluteUrl("/community/feed.xml");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel>
<title>Onshell Community</title><link>${xmlEscape(absoluteUrl("/community"))}</link>
<description>Practical Onshell guides for SSH, offline desktop access and team server workflows.</description>
<language>en</language><atom:link href="${xmlEscape(feed)}" rel="self" type="application/rss+xml"/>
${posts[0] ? `<lastBuildDate>${new Date(Math.max(...posts.map((post) => Date.parse(post.modifiedAt)))).toUTCString()}</lastBuildDate>` : ""}
${posts
  .map((post) => {
    const url = xmlEscape(absoluteUrl(`/community/${post.slug}`));
    return `<item><title>${xmlEscape(post.title)}</title><link>${url}</link><guid isPermaLink="true">${url}</guid><description>${xmlEscape(post.description)}</description><category>${xmlEscape(post.category)}</category><pubDate>${new Date(post.publishedAt).toUTCString()}</pubDate></item>`;
  })
  .join("\n")}
</channel></rss>`;
  return new Response(xml, {
    headers: {
      "Content-Type": "application/rss+xml; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

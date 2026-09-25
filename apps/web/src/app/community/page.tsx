import type { Metadata } from "next";
import Link from "next/link";
import { ArrowUpRight, BookOpen, Rss, Terminal } from "lucide-react";
import { PublicShell } from "../../components/public-shell";
import {
  articleDate,
  communityCategories,
  communitySchedule,
  publishedPosts,
  safeJsonLd,
} from "../../lib/community";
import { absoluteUrl } from "../../lib/site";
import "../home.css";
import "./community.css";

export const dynamic = "force-dynamic";
const title = "Onshell Community — SSH guides and practical server workflows";
const description =
  "Practical Onshell guides for browser SSH, desktop offline access, SFTP, snippets and team server workflows. Read, learn and suggest the next topic.";
export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; category?: string }>;
}): Promise<Metadata> {
  const query = await searchParams;
  return {
    title,
    description,
    alternates: {
      canonical: "/community",
      types: { "application/rss+xml": "/community/feed.xml" },
    },
    ...(query.q || query.category
      ? { robots: { index: false, follow: true } }
      : {}),
    openGraph: {
      title,
      description,
      url: absoluteUrl("/community"),
      type: "website",
    },
    twitter: { card: "summary_large_image", title, description },
  };
}
export default async function Community({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; category?: string }>;
}) {
  const params = await searchParams;
  const q = typeof params.q === "string" ? params.q.slice(0, 120).trim() : "";
  const category = typeof params.category === "string" ? params.category : "";
  const posts = publishedPosts();
  const filtered = posts.filter(
    (p) =>
      (!category || p.category === category) &&
      (!q ||
        `${p.title} ${p.description} ${p.category}`
          .toLowerCase()
          .includes(q.toLowerCase())),
  );
  const featured = !q && !category ? filtered[0] : undefined;
  const cards = featured ? filtered.slice(1) : filtered;
  return (
    <PublicShell>
      <div className="community">
        <header className="community-hero">
          <div>
            <span className="community-kicker">
              <span /> THE ONSHELL COMMUNITY
            </span>
            <h1>
              Better days
              <br />
              at the terminal.
            </h1>
            <p>
              Practical guides, clear answers and everyday workflows for the
              people looking after servers.
            </p>
            <div className="community-actions">
              <a className="community-button" href="#guides">
                Explore the guides <ArrowUpRight size={17} />
              </a>
              <a href="/community/feed.xml">
                <Rss size={16} /> Follow via RSS
              </a>
            </div>
          </div>
          <aside className="community-note">
            <Terminal size={26} />
            <span>LEARN. CONNECT. BUILD.</span>
            <h2>
              A little more clarity.
              <br />
              One guide at a time.
            </h2>
            <p>
              From your first SSH connection to a workspace ready for an outage.
              Written around the tools you actually use in Onshell.
            </p>
            <a href="/contact">
              Suggest a topic <ArrowUpRight size={16} />
            </a>
          </aside>
        </header>
        <section
          id="guides"
          className="community-library"
          aria-labelledby="guides-title"
        >
          <div className="community-section-head">
            <div>
              <span className="community-kicker">THE FIELD GUIDE</span>
              <h2 id="guides-title">Learn something useful.</h2>
            </div>
            <span>
              {posts.length} published {posts.length === 1 ? "guide" : "guides"}
            </span>
          </div>
          <form action="/community" className="community-filters" role="search">
            <label>
              Search guides
              <input
                type="search"
                name="q"
                placeholder="Offline SSH, snippets, team access…"
                defaultValue={q}
                maxLength={120}
              />
            </label>
            <label>
              Topic
              <select aria-label="Topic" name="category" defaultValue={category}>
                <option value="">All topics</option>
                {communityCategories.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </label>
            <button className="community-button" type="submit">
              Find guides
            </button>
            {(q || category) && <Link href="/community">Clear filters</Link>}
          </form>
          {featured && (
            <Link
              href={`/community/${featured.slug}`}
              className="community-featured"
            >
              <div className="community-feature-art" aria-hidden="true">
                <BookOpen size={54} />
                <span>
                  ONSHELL
                  <br />
                  FIELD NOTES
                </span>
                <small>{featured.category.toUpperCase()}</small>
              </div>
              <div>
                <span className="community-tag">
                  LATEST GUIDE · {featured.category}
                </span>
                <h2>{featured.title}</h2>
                <p>{featured.description}</p>
                <div className="community-meta">
                  <time dateTime={featured.publishedAt}>
                    {articleDate(featured.publishedAt)}
                  </time>
                  <span>{featured.readingMinutes} min read</span>
                </div>
                <strong>
                  Read the guide <ArrowUpRight size={17} />
                </strong>
              </div>
            </Link>
          )}
          <div className="community-grid">
            {cards.map((post) => (
              <article key={post.slug} className="community-card">
                <span className="community-tag">{post.category}</span>
                <h3>
                  <Link href={`/community/${post.slug}`}>{post.title}</Link>
                </h3>
                <p>{post.description}</p>
                <div className="community-meta">
                  <time dateTime={post.publishedAt}>
                    {articleDate(post.publishedAt)}
                  </time>
                  <span>{post.readingMinutes} min read</span>
                </div>
              </article>
            ))}
          </div>
          {!filtered.length && (
            <div className="community-empty">
              <BookOpen size={28} />
              <h3>
                {posts.length
                  ? "No guides match those filters."
                  : "The first field note is on its way."}
              </h3>
              <p>
                {posts.length
                  ? "Try a different topic or search term."
                  : `Our first guide arrives ${articleDate(communitySchedule()[0].publishedAt)}. Follow the RSS feed to keep up.`}
              </p>
              <Link href={posts.length ? "/community" : "/community/feed.xml"}>
                {posts.length ? "Show all guides" : "Follow the feed"}{" "}
                <ArrowUpRight size={16} />
              </Link>
            </div>
          )}
        </section>
        <section className="community-invite">
          <div>
            <span className="community-kicker">MAKE IT A CONVERSATION</span>
            <h2>What should we explore next?</h2>
            <p>
              Share a workflow, ask a product question, or tell us where you got
              stuck. Your feedback helps shape the next guide.
            </p>
          </div>
          <Link className="community-button" href="/contact">
            Send your idea <ArrowUpRight size={17} />
          </Link>
        </section>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: safeJsonLd({
              "@context": "https://schema.org",
              "@type": "CollectionPage",
              name: "Onshell Community",
              url: absoluteUrl("/community"),
              description,
              mainEntity: {
                "@type": "ItemList",
                itemListElement: filtered.map((post, index) => ({
                  "@type": "ListItem",
                  position: index + 1,
                  url: absoluteUrl(`/community/${post.slug}`),
                  name: post.title,
                })),
              },
            }),
          }}
        />
      </div>
    </PublicShell>
  );
}

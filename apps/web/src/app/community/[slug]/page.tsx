import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ArrowUpRight, Check } from "lucide-react";
import { PublicShell } from "../../../components/public-shell";
import {
  articleDate,
  publishedPost,
  publishedPosts,
  safeJsonLd,
} from "../../../lib/community";
import { absoluteUrl } from "../../../lib/site";
import "../../home.css";
import "../community.css";

export const dynamic = "force-dynamic";
type Props = { params: Promise<{ slug: string }> };
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const post = await publishedPost((await params).slug);
  if (!post) notFound();
  const url = absoluteUrl(`/community/${post.slug}`);
  const images = [
    { url: `${url}/image`, width: 1200, height: 630, alt: post.title },
  ];
  return {
    title: { absolute: `${post.seoTitle || post.title} | Onshell Community` },
    description: post.seoDescription || post.description,
    alternates: {
      canonical: url,
      types: { "application/rss+xml": "/community/feed.xml" },
    },
    openGraph: {
      type: "article",
      title: post.title,
      description: post.seoDescription || post.description,
      url,
      publishedTime: post.publishedAt,
      authors: [post.authorName],
      section: post.category,
      images,
    },
    twitter: {
      card: "summary_large_image",
      title: post.title,
      description: post.seoDescription || post.description,
      images: [`${url}/image`],
    },
  };
}
export default async function CommunityArticle({ params }: Props) {
  const post = await publishedPost((await params).slug);
  if (!post) notFound();
  const others = (await publishedPosts()).filter((p) => p.slug !== post.slug);
  const related = [
    ...others.filter((p) => p.category === post.category),
    ...others.filter((p) => p.category !== post.category),
  ].slice(0, 3);
  const url = absoluteUrl(`/community/${post.slug}`);
  const schema = [
    {
      "@context": "https://schema.org",
      "@type": "BlogPosting",
      headline: post.title,
      description: post.seoDescription || post.description,
      datePublished: post.publishedAt,
      dateModified: post.modifiedAt,
      mainEntityOfPage: url,
      url,
      image: `${url}/image`,
      inLanguage: "en",
      articleSection: post.category,
      author: {
        "@type": "Organization",
        name: post.authorName,
        url: absoluteUrl("/community"),
      },
      publisher: {
        "@type": "Organization",
        name: "Onshell",
        url: absoluteUrl("/"),
      },
    },
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        {
          "@type": "ListItem",
          position: 1,
          name: "Home",
          item: absoluteUrl("/"),
        },
        {
          "@type": "ListItem",
          position: 2,
          name: "Community",
          item: absoluteUrl("/community"),
        },
        { "@type": "ListItem", position: 3, name: post.title, item: url },
      ],
    },
  ];
  return (
    <PublicShell>
      <div className="community community-article">
        <Link className="community-back" href="/community">
          <ArrowLeft size={16} /> All guides
        </Link>
        <header className="community-article-header">
          <Link
            className="community-tag"
            href={`/community?category=${encodeURIComponent(post.category)}`}
          >
            {post.category}
          </Link>
          <h1>{post.title}</h1>
          <p>{post.description}</p>
          <div className="community-meta">
            <span>By {post.authorName}</span>
            <time dateTime={post.publishedAt}>
              {articleDate(post.publishedAt)}
            </time>
            <span>{post.readingMinutes} min read</span>
          </div>
        </header>
        {post.coverImage && (
          <img
            className="community-cover"
            src={post.coverImage}
            alt={post.coverAlt}
          />
        )}
        <div className="community-reading-layout">
          <article className="community-prose">
            <aside className="community-answer">
              <span className="community-kicker">THE SHORT ANSWER</span>
              <p>{post.answer}</p>
            </aside>
            {post.sections.map((section, index) => (
              <section id={`section-${index + 1}`} key={section.heading}>
                <h2>{section.heading}</h2>
                {section.paragraphs.map((paragraph, i) => (
                  <p key={i}>{paragraph}</p>
                ))}
              </section>
            ))}
            <section id="checklist" className="community-checklist">
              <h2>Your next steps</h2>
              <ul>
                {post.checklist.map((item) => (
                  <li key={item}>
                    <Check size={18} aria-hidden="true" />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </section>
            <div className="community-article-cta">
              <h2>Put it into practice.</h2>
              <p>
                Explore the tools behind this guide, or send us a question about
                your workflow.
              </p>
              <div className="community-actions">
                <Link className="community-button" href={post.productLink}>
                  Explore Onshell <ArrowUpRight size={16} />
                </Link>
                <Link href="/contact">Ask a question</Link>
              </div>
            </div>
          </article>
          <aside className="community-toc">
            <nav aria-label="On this page">
              <span className="community-kicker">ON THIS PAGE</span>
              {post.sections.map((section, index) => (
                <a key={section.heading} href={`#section-${index + 1}`}>
                  {section.heading}
                </a>
              ))}
              <a href="#checklist">Your next steps</a>
            </nav>
            <a className="community-feed-link" href="/community/feed.xml">
              Follow new guides via RSS <ArrowUpRight size={15} />
            </a>
          </aside>
        </div>
        {!!related.length && (
          <section
            className="community-related"
            aria-labelledby="related-title"
          >
            <span className="community-kicker">KEEP EXPLORING</span>
            <h2 id="related-title">A good next read.</h2>
            <div className="community-grid">
              {related.map((p) => (
                <article className="community-card" key={p.slug}>
                  <span className="community-tag">{p.category}</span>
                  <h3>
                    <Link href={`/community/${p.slug}`}>{p.title}</Link>
                  </h3>
                  <p>{p.description}</p>
                  <span className="community-meta">
                    {p.readingMinutes} min read
                  </span>
                </article>
              ))}
            </div>
          </section>
        )}
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: safeJsonLd(schema) }}
        />
      </div>
    </PublicShell>
  );
}

import type { MetadataRoute } from "next";
import { siteUrl } from "../lib/site";

/** Authenticated surfaces — nothing to index, and no value in crawling them. */
const privatePaths = ["/console", "/admin", "/login", "/signup", "/invite"];

/**
 * AI crawlers, allowed explicitly.
 *
 * Being cited by an assistant is a real acquisition channel for a developer
 * tool, so these are deliberate opt-ins rather than accidental omissions:
 * GPTBot / OAI-SearchBot (OpenAI), ClaudeBot (Anthropic), PerplexityBot,
 * Google-Extended (Gemini grounding), Applebot-Extended, CCBot (Common Crawl),
 * and the rest. Each gets the public pages and nothing more.
 */
const aiCrawlers = [
  "GPTBot",
  "OAI-SearchBot",
  "ChatGPT-User",
  "ClaudeBot",
  "Claude-User",
  "Claude-SearchBot",
  "anthropic-ai",
  "PerplexityBot",
  "Perplexity-User",
  "Google-Extended",
  "Applebot-Extended",
  "CCBot",
  "Amazonbot",
  "meta-externalagent",
  "cohere-ai",
  "YouBot",
  "DuckAssistBot"
];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: privatePaths
      },
      ...aiCrawlers.map((userAgent) => ({
        userAgent,
        allow: "/",
        disallow: privatePaths
      }))
    ],
    sitemap: `${siteUrl}/sitemap.xml`,
    host: siteUrl
  };
}

"use client";

import { useEffect, useState, type ChangeEvent, type FormEvent } from "react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  BookOpen,
  Eye,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  X,
} from "lucide-react";
import { apiGet, apiSend, errorText, formatDateTime } from "./lib";
import "./community-admin.css";

type Post = {
  id?: string;
  version?: number;
  slug: string;
  title: string;
  category: string;
  description: string;
  answer: string;
  sections: { heading: string; paragraphs: string[] }[];
  checklist: string[];
  productLink: string;
  authorName: string;
  seoTitle: string;
  seoDescription: string;
  coverImage: string | null;
  coverAlt: string;
  status: "DRAFT" | "PUBLISHED";
  publishedAt: string | null;
  updatedAt?: string;
};
type Row = Pick<
  Post,
  | "id"
  | "version"
  | "slug"
  | "title"
  | "category"
  | "authorName"
  | "status"
  | "publishedAt"
  | "updatedAt"
>;
type Listing = { posts: Row[]; total: number; categories: string[] };
const blank = (): Post => ({
  slug: "",
  title: "",
  category: "Getting started",
  description: "",
  answer: "",
  sections: [],
  checklist: [],
  productLink: "/desktop",
  authorName: "Onshell",
  seoTitle: "",
  seoDescription: "",
  coverImage: null,
  coverAlt: "",
  status: "DRAFT",
  publishedAt: null,
});
function publication(post: Pick<Post, "status" | "publishedAt">) {
  return post.status === "DRAFT"
    ? "draft"
    : post.publishedAt && Date.parse(post.publishedAt) > Date.now()
      ? "scheduled"
      : "published";
}
function bangladeshDate(value: string | null) {
  return value
    ? new Date(Date.parse(value) + 6 * 3600000).toISOString().slice(0, 16)
    : "";
}
async function readCover(file: File) {
  if (
    !["image/png", "image/jpeg", "image/webp"].includes(file.type) ||
    file.size > 5 * 1024 * 1024
  )
    throw new Error("Choose a PNG, JPEG or WebP file under 5 MB.");
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, 1200 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const data = canvas.toDataURL("image/jpeg", 0.8);
    if (data.length > 400000)
      throw new Error(
        "This image is too detailed. Choose a smaller image (under 300 KB after resizing).",
      );
    return data;
  } finally {
    bitmap.close();
  }
}
export function CommunitySection() {
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [category, setCategory] = useState("");
  const [page, setPage] = useState(0);
  const [revision, setRevision] = useState(0);
  const [data, setData] = useState<Listing>();
  const [loading, setLoading] = useState(true);
  const [post, setPost] = useState<Post>();
  const [saved, setSaved] = useState("");
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const dirty = !!post && JSON.stringify(post) !== saved;
  useEffect(() => {
    const timer = setTimeout(() => {
      setQuery(search.trim());
      setPage(0);
    }, 250);
    return () => clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    let active = true;
    setLoading(true);
    const params = new URLSearchParams({
      search: query,
      status,
      category,
      take: "20",
      skip: String(page * 20),
    });
    void apiGet<Listing>(`/admin/community?${params}`)
      .then((next) => {
        if (active) setData(next);
      })
      .catch((cause) => {
        if (active) setError(errorText(cause));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [query, status, category, page, revision]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    const guardNavigation = (event: MouseEvent) => {
      const target = event.target as Element;
      if (
        target.closest(".admin-sidebar .nav-item:not(.is-active)") &&
        !window.confirm("Discard unsaved changes to this post?")
      ) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener("beforeunload", warn);
    document.addEventListener("click", guardNavigation, true);
    return () => {
      window.removeEventListener("beforeunload", warn);
      document.removeEventListener("click", guardNavigation, true);
    };
  }, [dirty]);
  function edit(next: Post) {
    setPost(next);
    setSaved(JSON.stringify(next));
    setPreview(false);
    setError("");
    setNotice("");
  }
  function change<K extends keyof Post>(key: K, value: Post[K]) {
    setPost((current) => (current ? { ...current, [key]: value } : current));
  }
  async function open(id: string) {
    setBusy(true);
    setError("");
    try {
      edit(await apiGet<Post>(`/admin/community/${id}`));
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }
  function close() {
    if (dirty && !window.confirm("Discard unsaved changes to this post?"))
      return;
    setPost(undefined);
    setError("");
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!post) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const body = {
        ...post,
        sections: post.sections.map((s) => ({
          ...s,
          paragraphs: s.paragraphs.map((p) => p.trim()).filter(Boolean),
        })),
        checklist: post.checklist.map((c) => c.trim()).filter(Boolean),
      };
      if (
        body.status === "PUBLISHED" &&
        (!body.publishedAt ||
          !body.description.trim() ||
          !body.answer.trim() ||
          !body.sections.length)
      )
        throw new Error(
          "Publishing requires a date, summary, short answer and at least one section.",
        );
      if (body.coverImage && !body.coverAlt.trim())
        throw new Error("Add a description for the cover image.");
      const result = await apiSend<Post>(
        post.id ? `/admin/community/${post.id}` : "/admin/community",
        post.id ? "PATCH" : "POST",
        body,
      );
      edit(result);
      setNotice(`Post saved · ${publication(result)}.`);
      setRevision((r) => r + 1);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }
  async function remove(row: Row) {
    if (
      !window.confirm(
        `Permanently delete “${row.title}”? It will also disappear from the public website, RSS and sitemap.`,
      )
    )
      return;
    setBusy(true);
    setError("");
    try {
      await apiSend(`/admin/community/${row.id}`, "DELETE", {
        version: row.version,
      });
      setNotice("Post deleted.");
      setPage(0);
      setRevision((r) => r + 1);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }
  async function upload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setBusy(true);
    setError("");
    try {
      change("coverImage", await readCover(file));
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
      event.target.value = "";
    }
  }
  function move(index: number, direction: number) {
    if (!post) return;
    const next = [...post.sections];
    [next[index], next[index + direction]] = [
      next[index + direction],
      next[index],
    ];
    change("sections", next);
  }
  return (
    <div className="cms adm-stack">
      {error && (
        <div className="cms-message cms-error" role="alert">
          {error}
          <button
            type="button"
            aria-label="Dismiss error"
            onClick={() => setError("")}
          >
            <X size={16} />
          </button>
        </div>
      )}
      {notice && (
        <div className="cms-message" role="status">
          {notice}
          <button
            type="button"
            aria-label="Dismiss notification"
            onClick={() => setNotice("")}
          >
            <X size={16} />
          </button>
        </div>
      )}
      {!post ? (
        <>
          <div className="cms-toolbar">
            <div>
              <h2>Community posts</h2>
              <p>Write, schedule and maintain your public guides.</p>
            </div>
            <div className="cms-actions">
              <button
                type="button"
                disabled={busy || loading}
                onClick={() => {
                  setError("");
                  setRevision((r) => r + 1);
                }}
                aria-label="Refresh posts"
              >
                <RefreshCw size={17} />
              </button>
              <button
                className="primary-button"
                type="button"
                disabled={busy}
                onClick={() => edit(blank())}
              >
                <Plus size={17} /> New post
              </button>
            </div>
          </div>
          <div className="cms-filters">
            <label>
              Search
              <input
                type="search"
                placeholder="Title, slug or summary"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </label>
            <label>
              Status
              <select
                value={status}
                onChange={(e) => {
                  setStatus(e.target.value);
                  setPage(0);
                }}
              >
                <option value="all">All posts</option>
                <option value="draft">Draft</option>
                <option value="scheduled">Scheduled</option>
                <option value="published">Published</option>
              </select>
            </label>
            <label>
              Category
              <select
                value={category}
                onChange={(e) => {
                  setCategory(e.target.value);
                  setPage(0);
                }}
              >
                <option value="">All categories</option>
                {data?.categories.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </label>
          </div>
          <div className="cms-table-wrap" aria-busy={loading}>
            <table className="adm-table" data-table-id="community-posts">
              <thead>
                <tr>
                  <th>Title</th>
                  <th>Category</th>
                  <th>Status</th>
                  <th>Publication</th>
                  <th>Author</th>
                  <th>Updated</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {data?.posts.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <strong>{row.title}</strong>
                      <small>/{row.slug}</small>
                    </td>
                    <td>{row.category}</td>
                    <td>
                      <span className={`cms-status is-${publication(row)}`}>
                        {publication(row)}
                      </span>
                    </td>
                    <td>{formatDateTime(row.publishedAt)}</td>
                    <td>{row.authorName}</td>
                    <td>{formatDateTime(row.updatedAt)}</td>
                    <td>
                      <div className="cms-actions">
                        <button
                          disabled={busy}
                          title="Edit post"
                          aria-label={`Edit ${row.title}`}
                          onClick={() => void open(row.id!)}
                        >
                          <Pencil size={16} />
                        </button>
                        {publication(row) === "published" && (
                          <a
                            href={`/community/${row.slug}`}
                            target="_blank"
                            rel="noreferrer"
                            title="Open published post"
                            aria-label={`Open ${row.title}`}
                          >
                            <Eye size={16} />
                          </a>
                        )}
                        <button
                          disabled={busy}
                          title="Delete post"
                          aria-label={`Delete ${row.title}`}
                          onClick={() => void remove(row)}
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!loading && !data?.posts.length && (
            <div className="cms-empty">
              <BookOpen size={28} />
              <h3>No posts found</h3>
              <p>Create a post or adjust the filters.</p>
            </div>
          )}
          <div className="cms-pagination">
            <span>
              {loading ? "Loading…" : `${data?.total ?? 0} posts`} · Dates shown
              in your local timezone
            </span>
            <div className="cms-actions">
              <button
                disabled={loading || page === 0}
                onClick={() => setPage((p) => p - 1)}
              >
                Previous
              </button>
              <span>Page {page + 1}</span>
              <button
                disabled={loading || (page + 1) * 20 >= (data?.total ?? 0)}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </button>
            </div>
          </div>
        </>
      ) : (
        <form onSubmit={save}>
          <div className="cms-toolbar">
            <div className="cms-actions">
              <button type="button" disabled={busy} onClick={close}>
                <ArrowLeft size={16} /> Posts
              </button>
              <div>
                <h2>{post.id ? "Edit post" : "New post"}</h2>
                <p>{dirty ? "Unsaved changes" : "All changes saved"}</p>
              </div>
            </div>
            <div className="cms-actions">
              <button type="button" onClick={() => setPreview((p) => !p)}>
                <Eye size={16} /> {preview ? "Editor" : "Preview"}
              </button>
              <button className="primary-button" disabled={busy} type="submit">
                <Save size={16} /> {busy ? "Saving…" : "Save post"}
              </button>
            </div>
          </div>
          {preview ? (
            <article className="cms-preview">
              <span>PRIVATE PREVIEW · {publication(post)}</span>
              <h1>{post.title || "Untitled post"}</h1>
              <p>{post.description}</p>
              <small>By {post.authorName}</small>
              {post.coverImage && (
                <img src={post.coverImage} alt={post.coverAlt} />
              )}
              <blockquote>{post.answer}</blockquote>
              {post.sections.map((s, i) => (
                <section key={i}>
                  <h2>{s.heading}</h2>
                  {s.paragraphs.map((p, j) => (
                    <p key={j}>{p}</p>
                  ))}
                </section>
              ))}
              {!!post.checklist.length && (
                <>
                  <h2>Your next steps</h2>
                  <ul>
                    {post.checklist.map((p, i) => (
                      <li key={i}>{p}</li>
                    ))}
                  </ul>
                </>
              )}
            </article>
          ) : (
            <fieldset disabled={busy} className="cms-editor">
              <div className="cms-main">
                <section className="cms-panel">
                  <h3>Content</h3>
                  <label>
                    Title
                    <input
                      required
                      maxLength={180}
                      value={post.title}
                      onChange={(e) => change("title", e.target.value)}
                    />
                  </label>
                  <label>
                    URL slug
                    <input
                      required
                      pattern="[a-z0-9]+(-[a-z0-9]+)*"
                      minLength={2}
                      maxLength={150}
                      value={post.slug}
                      onChange={(e) => change("slug", e.target.value)}
                    />
                    <small>
                      Keep published URLs stable. Lowercase words separated by
                      hyphens.
                    </small>
                  </label>
                  <label>
                    Summary
                    <textarea
                      maxLength={350}
                      rows={3}
                      value={post.description}
                      onChange={(e) => change("description", e.target.value)}
                    />
                  </label>
                  <label>
                    Short answer
                    <textarea
                      rows={4}
                      maxLength={5000}
                      value={post.answer}
                      onChange={(e) => change("answer", e.target.value)}
                    />
                  </label>
                </section>
                <section className="cms-panel">
                  <div className="cms-toolbar">
                    <h3>Article sections</h3>
                    <button
                      type="button"
                      disabled={post.sections.length >= 40}
                      onClick={() =>
                        change("sections", [
                          ...post.sections,
                          { heading: "", paragraphs: [""] },
                        ])
                      }
                    >
                      <Plus size={16} /> Add section
                    </button>
                  </div>
                  <p>
                    Write plain text. Separate paragraphs with a blank line.
                  </p>
                  {post.sections.map((section, index) => (
                    <div className="cms-section" key={index}>
                      <div className="cms-toolbar">
                        <strong>Section {index + 1}</strong>
                        <div className="cms-actions">
                          <button
                            type="button"
                            aria-label={`Move section ${index + 1} up`}
                            disabled={index === 0}
                            onClick={() => move(index, -1)}
                          >
                            <ArrowUp size={15} />
                          </button>
                          <button
                            type="button"
                            aria-label={`Move section ${index + 1} down`}
                            disabled={index === post.sections.length - 1}
                            onClick={() => move(index, 1)}
                          >
                            <ArrowDown size={15} />
                          </button>
                          <button
                            type="button"
                            aria-label={`Remove section ${index + 1}`}
                            onClick={() =>
                              change(
                                "sections",
                                post.sections.filter((_, i) => i !== index),
                              )
                            }
                          >
                            <Trash2 size={15} />
                          </button>
                        </div>
                      </div>
                      <label>
                        Heading
                        <input
                          required
                          maxLength={180}
                          value={section.heading}
                          onChange={(e) =>
                            change(
                              "sections",
                              post.sections.map((s, i) =>
                                i === index
                                  ? { ...s, heading: e.target.value }
                                  : s,
                              ),
                            )
                          }
                        />
                      </label>
                      <label>
                        Paragraphs
                        <textarea
                          required
                          rows={7}
                          value={section.paragraphs.join("\n\n")}
                          onChange={(e) =>
                            change(
                              "sections",
                              post.sections.map((s, i) =>
                                i === index
                                  ? {
                                      ...s,
                                      paragraphs: e.target.value.split("\n\n"),
                                    }
                                  : s,
                              ),
                            )
                          }
                        />
                      </label>
                    </div>
                  ))}
                </section>
                <section className="cms-panel">
                  <h3>Reader next steps</h3>
                  <label>
                    Checklist
                    <textarea
                      rows={4}
                      value={post.checklist.join("\n")}
                      onChange={(e) =>
                        change("checklist", e.target.value.split("\n"))
                      }
                    />
                    <small>One item per line, up to 20 items.</small>
                  </label>
                  <label>
                    Product link
                    <input
                      required
                        maxLength={190}
                      value={post.productLink}
                      onChange={(e) => change("productLink", e.target.value)}
                    />
                    <small>
                      Internal path, for example /desktop or /contact.
                    </small>
                  </label>
                </section>
              </div>
              <aside className="cms-side">
                <section className="cms-panel">
                  <h3>Publication</h3>
                  <label>
                    Status
                    <select
                      value={publication(post)}
                      onChange={(e) => {
                        const value = e.target.value;
                        setPost({
                          ...post,
                          status: value === "draft" ? "DRAFT" : "PUBLISHED",
                          publishedAt:
                            value === "draft"
                              ? post.publishedAt
                              : value === "published"
                                ? new Date().toISOString()
                                : new Date(Date.now() + 86400000).toISOString(),
                        });
                      }}
                    >
                      <option value="draft">Draft — private</option>
                      <option value="scheduled">Scheduled</option>
                      <option value="published">Published — visible now</option>
                    </select>
                  </label>
                  {post.status === "PUBLISHED" && (
                    <label>
                      Publication time (Bangladesh, UTC+06:00)
                      <input
                        required
                        type="datetime-local"
                        value={bangladeshDate(post.publishedAt)}
                        onChange={(e) =>
                          change(
                            "publishedAt",
                            e.target.value
                              ? new Date(
                                  `${e.target.value}:00+06:00`,
                                ).toISOString()
                              : null,
                          )
                        }
                      />
                      <small>
                        Future dates publish automatically. Past dates are
                        visible immediately after saving.
                      </small>
                    </label>
                  )}
                  <label>
                    Category
                    <input
                      required
                      list="cms-categories"
                      maxLength={80}
                      value={post.category}
                      onChange={(e) => change("category", e.target.value)}
                    />
                    <datalist id="cms-categories">
                      {data?.categories.map((c) => (
                        <option key={c} value={c} />
                      ))}
                    </datalist>
                    <small>
                      Select an existing category or type a new one.
                    </small>
                  </label>
                  <label>
                    Author name
                    <input
                      required
                      maxLength={120}
                      value={post.authorName}
                      onChange={(e) => change("authorName", e.target.value)}
                    />
                  </label>
                </section>
                <section className="cms-panel">
                  <h3>Cover image</h3>
                  {post.coverImage && (
                    <>
                      <img
                        className="cms-cover"
                        src={post.coverImage}
                        alt={post.coverAlt || "Cover preview"}
                      />
                      <button
                        type="button"
                        onClick={() => {
                          change("coverImage", null);
                          change("coverAlt", "");
                        }}
                      >
                        Remove image
                      </button>
                    </>
                  )}
                  <label>
                    Upload cover
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      onChange={(e) => void upload(e)}
                    />
                    <small>
                      PNG, JPEG or WebP up to 5 MB. Resized to fit 1200 pixels.
                    </small>
                  </label>
                  <label>
                    Image description
                    <input
                      maxLength={180}
                      required={!!post.coverImage}
                      value={post.coverAlt}
                      onChange={(e) => change("coverAlt", e.target.value)}
                    />
                  </label>
                </section>
                <section className="cms-panel">
                  <h3>Search appearance</h3>
                  <label>
                    SEO title
                    <input
                      maxLength={180}
                      value={post.seoTitle}
                      placeholder={post.title || "Uses article title"}
                      onChange={(e) => change("seoTitle", e.target.value)}
                    />
                    <small>
                      {(post.seoTitle || post.title).length} characters · aim
                      for a concise, descriptive title.
                    </small>
                  </label>
                  <label>
                    SEO description
                    <textarea
                      maxLength={350}
                      rows={4}
                      value={post.seoDescription}
                      placeholder={post.description || "Uses summary"}
                      onChange={(e) => change("seoDescription", e.target.value)}
                    />
                  </label>
                  <div className="cms-search-preview">
                    <small>
                      onshell.cloud/community/{post.slug || "your-post"}
                    </small>
                    <strong>
                      {post.seoTitle || post.title || "Your article title"}
                    </strong>
                    <p>
                      {post.seoDescription ||
                        post.description ||
                        "Your summary appears here."}
                    </p>
                  </div>
                  <p>
                    Canonical URL, structured data, social image, RSS and
                    sitemap update automatically.
                  </p>
                </section>
              </aside>
            </fieldset>
          )}
        </form>
      )}
    </div>
  );
}

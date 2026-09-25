import { ImageResponse } from "next/og";
import { publishedPost } from "../../../../lib/community";
export const dynamic = "force-dynamic";
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const post = publishedPost((await params).slug);
  if (!post)
    return new Response("Not found", {
      status: 404,
      headers: { "Cache-Control": "no-store" },
    });
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        background: "#10121c",
        color: "#f2f2f8",
        padding: "64px",
        borderTop: "12px solid #a5b4fc",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontSize: 24,
          color: "#a5b4fc",
        }}
      >
        <span>ONSHELL / COMMUNITY</span>
        <span>{post.category}</span>
      </div>
      <div
        style={{
          display: "flex",
          fontSize: 58,
          fontWeight: 700,
          lineHeight: 1.15,
        }}
      >
        {post.title}
      </div>
      <div style={{ display: "flex", fontSize: 24, color: "#b4b7ce" }}>
        Practical guides for better days at the terminal.
      </div>
    </div>,
    { width: 1200, height: 630, headers: { "Cache-Control": "no-store" } },
  );
}

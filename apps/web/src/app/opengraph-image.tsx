import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ImageResponse } from "next/og";

export const alt = "Onshell.cloud — the best browser-based SSH client for teams";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// Inlined as a data URI, not fetched over HTTP: this renders during `next build`
// as well as at request time, and at build time there is no server running to
// serve /brand/onshell-logo.png to itself. Read once at module scope so a burst
// of crawler requests does not re-read the file per response.
const logoDataUri = `data:image/png;base64,${readFileSync(
  join(process.cwd(), "public", "brand", "onshell-logo.png")
).toString("base64")}`;

// Branded social-share card, generated at build/request time. Kept font-free so
// it renders with the built-in default font and needs no external assets.
export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "72px 80px",
          backgroundColor: "#0a0b12",
          backgroundImage:
            "radial-gradient(700px circle at 82% -5%, rgba(236,72,153,0.28), transparent 55%), radial-gradient(760px circle at 12% 108%, rgba(99,102,241,0.32), transparent 55%), radial-gradient(620px circle at 55% 20%, rgba(168,85,247,0.22), transparent 60%)",
          color: "#f2f2f8"
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img alt="" height={64} src={logoDataUri} width={64} />
          <div style={{ display: "flex", fontSize: 32, fontWeight: 700, letterSpacing: -0.5 }}>
            Onshell.cloud
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              fontSize: 76,
              fontWeight: 800,
              lineHeight: 1.05,
              letterSpacing: -2,
              maxWidth: 980
            }}
          >
            The best browser-based SSH client for teams.
          </div>
          <div style={{ display: "flex", fontSize: 30, color: "#a6a8c0", maxWidth: 900 }}>
            Audited terminals, SFTP, and RDP from any browser tab. Encrypted vault, full audit
            trail, free for one user.
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          {["SSH", "SFTP", "RDP", "Vault", "Audit"].map((tag) => (
            <div
              key={tag}
              style={{
                display: "flex",
                padding: "10px 22px",
                borderRadius: 999,
                fontSize: 26,
                fontWeight: 600,
                color: "#c7cbf5",
                border: "1px solid rgba(129,140,248,0.4)",
                backgroundColor: "rgba(129,140,248,0.12)"
              }}
            >
              {tag}
            </div>
          ))}
        </div>
      </div>
    ),
    { ...size }
  );
}

"use client";
export default function CommunityError({ reset }: { reset: () => void }) {
  return (
    <main style={{ maxWidth: 640, margin: "80px auto", padding: 24 }}>
      <h1>Guides are temporarily unavailable.</h1>
      <p>We could not load the latest community content. Please try again.</p>
      <button className="primary-button" onClick={reset}>
        Try again
      </button>{" "}
      <a href="/">Back to home</a>
    </main>
  );
}

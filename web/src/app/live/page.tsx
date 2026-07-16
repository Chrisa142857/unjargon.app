import LiveStream from "./stream";

// Client-side data fetching (via /api/bootstrap) so this page works both
// server-rendered (Space) and as a static export on GitHub Pages.
export default function LivePage() {
  return <LiveStream />;
}

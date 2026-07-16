import Wiki from "./wiki";

// Client-side data fetching (via /api/wiki) so this page works both
// server-rendered (Space) and as a static export on GitHub Pages.
export default function WikiPage() {
  return <Wiki />;
}

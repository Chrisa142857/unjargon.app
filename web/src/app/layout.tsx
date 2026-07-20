import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "unjargon — jargon for your agents",
  description:
    "Zero-AI jargon detection and opt-in explanations for AI agent sessions.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className="h-full antialiased"
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}

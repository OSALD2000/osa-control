import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "OSA Control — Agent Logbook",
  description: "Local dashboard for Codex and Claude Code sessions",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

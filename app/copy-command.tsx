"use client";

import { useState } from "react";

export function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
    } catch {
      window.prompt("Copy resume command:", command);
    }
  }

  return (
    <button
      className="copy-command"
      type="button"
      onClick={copy}
      title={command}
    >
      {copied ? "Copied" : "Copy resume command"}
    </button>
  );
}

"use client";

import { useState } from "react";

export function CopyTextButton({
  text,
  label = "Copy",
  copiedLabel = "Copied!"
}: {
  text: string;
  label?: string;
  copiedLabel?: string;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="button"
      style={{ textDecoration: "none" }}
    >
      {copied ? copiedLabel : label}
    </button>
  );
}

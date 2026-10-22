"use server";

import { refresh } from "next/cache";
import { headers } from "next/headers";
import { saveWorkState } from "../lib/work-state";

function text(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value : "";
}

export async function updateWorkState(formData: FormData): Promise<void> {
  const host = (await headers()).get("host") || "";
  if (!/^(localhost|127\.0\.0\.1)(:\d+)?$|^\[::1\](:\d+)?$/.test(host)) {
    throw new Error("Status changes are only allowed locally");
  }

  await saveWorkState(
    text(formData.get("key")),
    text(formData.get("status")),
    text(formData.get("note")),
  );
  refresh();
}

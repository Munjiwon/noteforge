"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "db";
import { auth } from "@/lib/auth";

async function currentUserId(): Promise<string> {
  const session = await auth();
  if (!session?.user) throw new Error("unauth");
  return (session.user as { id: string }).id;
}

export async function setMyName(name: string) {
  const id = await currentUserId();
  const clean = name.trim().slice(0, 60);
  if (!clean) throw new Error("name required");
  await prisma.user.update({ where: { id }, data: { name: clean } });
  revalidatePath("/", "layout");
}

const HEX = /^#[0-9a-fA-F]{6}$/;

export async function setMyColor(color: string) {
  const id = await currentUserId();
  if (!HEX.test(color)) throw new Error("invalid color");
  await prisma.user.update({ where: { id }, data: { color } });
  revalidatePath("/", "layout");
}

export async function setMyAvatar(url: string | null) {
  const id = await currentUserId();
  // Only allow our own /api/files/* URLs to avoid embedding random external trackers.
  const safe = url && url.startsWith("/api/files/") ? url : null;
  await prisma.user.update({
    where: { id },
    data: { avatarUrl: safe },
  });
  revalidatePath("/", "layout");
}

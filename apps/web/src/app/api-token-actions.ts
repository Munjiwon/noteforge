"use server";

import { revalidatePath } from "next/cache";
import { randomBytes } from "crypto";
import { prisma } from "db";
import { auth } from "@/lib/auth";

async function currentUserId(): Promise<string> {
  const session = await auth();
  if (!session?.user) throw new Error("unauth");
  return (session.user as { id: string }).id;
}

export async function createApiToken(name: string): Promise<string> {
  const userId = await currentUserId();
  const trimmed = name.trim() || "Untitled token";
  const token = "cn_" + randomBytes(24).toString("base64url");
  await prisma.apiToken.create({
    data: { userId, name: trimmed, token },
  });
  revalidatePath("/", "layout");
  return token; // return the secret to the caller exactly once
}

export async function deleteApiToken(id: string) {
  const userId = await currentUserId();
  await prisma.apiToken.deleteMany({ where: { id, userId } });
  revalidatePath("/", "layout");
}

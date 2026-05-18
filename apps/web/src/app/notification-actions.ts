"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "db";
import { auth } from "@/lib/auth";

async function currentUserId(): Promise<string> {
  const session = await auth();
  if (!session?.user) throw new Error("unauth");
  return (session.user as { id: string }).id;
}

export async function updateUserProfile(name: string, color: string) {
  const userId = await currentUserId();
  const trimmedName = name.trim();
  const trimmedColor = color.trim();
  if (!trimmedName) throw new Error("name required");
  if (!/^#[0-9a-fA-F]{6}$/.test(trimmedColor)) throw new Error("invalid color");
  await prisma.user.update({
    where: { id: userId },
    data: { name: trimmedName, color: trimmedColor },
  });
  revalidatePath("/", "layout");
}

export async function markNotificationRead(id: string) {
  const userId = await currentUserId();
  await prisma.notification.updateMany({
    where: { id, recipientId: userId },
    data: { read: true },
  });
  revalidatePath("/");
}

export async function markAllNotificationsRead() {
  const userId = await currentUserId();
  await prisma.notification.updateMany({
    where: { recipientId: userId, read: false },
    data: { read: true },
  });
  revalidatePath("/");
}

export async function clearReadNotifications() {
  const userId = await currentUserId();
  await prisma.notification.deleteMany({
    where: { recipientId: userId, read: true },
  });
  revalidatePath("/");
}

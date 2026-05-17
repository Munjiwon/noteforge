"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "db";
import { auth } from "@/lib/auth";

async function currentUserId(): Promise<string> {
  const session = await auth();
  if (!session?.user) throw new Error("unauth");
  return (session.user as { id: string }).id;
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

"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "db";
import { requireWorkspaceMember } from "@/lib/workspace";

async function assertEditor(slug: string) {
  const ctx = await requireWorkspaceMember(slug);
  if (ctx.role === "viewer") throw new Error("forbidden");
  return ctx;
}

export async function createTeamspace(
  slug: string,
  name: string,
  options?: { icon?: string | null; description?: string | null; access?: "open" | "closed" | "private" },
) {
  const ctx = await assertEditor(slug);
  const trimmed = name.trim() || "Untitled teamspace";
  const max = await prisma.teamspace.aggregate({
    where: { workspaceId: ctx.workspace.id },
    _max: { position: true },
  });
  const ts = await prisma.teamspace.create({
    data: {
      workspaceId: ctx.workspace.id,
      name: trimmed,
      icon: options?.icon ?? null,
      description: options?.description ?? null,
      access: options?.access ?? "open",
      position: (max._max.position ?? 0) + 1,
      members: {
        create: { userId: ctx.user.id, role: "owner" },
      },
    },
  });
  // Seed a welcome page so the teamspace doesn't show up empty.
  const welcomeContent = [
    {
      id: "h1",
      type: "heading",
      props: { level: 1, textColor: "default", backgroundColor: "default", textAlignment: "left" },
      content: [{ type: "text", text: `${trimmed} 시작하기`, styles: {} }],
      children: [],
    },
    {
      id: "p1",
      type: "paragraph",
      props: { textColor: "default", backgroundColor: "default", textAlignment: "left" },
      content: [
        {
          type: "text",
          text: "이 페이지는 팀스페이스 멤버 모두가 함께 보는 환영 페이지입니다. 멤버 소개, 주요 링크, 공지를 여기에 적어보세요.",
          styles: {},
        },
      ],
      children: [],
    },
    {
      id: "h2a",
      type: "heading",
      props: { level: 2, textColor: "default", backgroundColor: "default", textAlignment: "left" },
      content: [{ type: "text", text: "📌 주요 링크", styles: {} }],
      children: [],
    },
    {
      id: "li1",
      type: "bulletListItem",
      props: { textColor: "default", backgroundColor: "default", textAlignment: "left" },
      content: [{ type: "text", text: "회의록 모음", styles: {} }],
      children: [],
    },
    {
      id: "li2",
      type: "bulletListItem",
      props: { textColor: "default", backgroundColor: "default", textAlignment: "left" },
      content: [{ type: "text", text: "프로젝트 보드", styles: {} }],
      children: [],
    },
    {
      id: "h2b",
      type: "heading",
      props: { level: 2, textColor: "default", backgroundColor: "default", textAlignment: "left" },
      content: [{ type: "text", text: "👥 멤버", styles: {} }],
      children: [],
    },
    {
      id: "p2",
      type: "paragraph",
      props: { textColor: "default", backgroundColor: "default", textAlignment: "left" },
      content: [
        {
          type: "text",
          text: "팀스페이스 헤더의 ⋯ 메뉴 → 멤버 관리에서 워크스페이스 멤버를 초대할 수 있습니다.",
          styles: {},
        },
      ],
      children: [],
    },
  ];
  await prisma.page.create({
    data: {
      workspaceId: ctx.workspace.id,
      teamspaceId: ts.id,
      title: `${trimmed} home`,
      icon: options?.icon ?? "👋",
      content: JSON.stringify(welcomeContent),
      position: 0,
      authorId: ctx.user.id,
    },
  });
  revalidatePath(`/w/${slug}`);
  return ts.id;
}

export async function renameTeamspace(slug: string, teamspaceId: string, name: string) {
  const ctx = await assertEditor(slug);
  const ts = await prisma.teamspace.findFirst({
    where: { id: teamspaceId, workspaceId: ctx.workspace.id },
  });
  if (!ts) throw new Error("not found");
  await prisma.teamspace.update({
    where: { id: teamspaceId },
    data: { name: name.trim() || ts.name },
  });
  revalidatePath(`/w/${slug}`);
}

export async function setTeamspaceIcon(slug: string, teamspaceId: string, icon: string | null) {
  const ctx = await assertEditor(slug);
  const ts = await prisma.teamspace.findFirst({
    where: { id: teamspaceId, workspaceId: ctx.workspace.id },
  });
  if (!ts) throw new Error("not found");
  await prisma.teamspace.update({
    where: { id: teamspaceId },
    data: { icon },
  });
  revalidatePath(`/w/${slug}`);
}

export async function setTeamspaceDescription(
  slug: string,
  teamspaceId: string,
  description: string,
) {
  const ctx = await assertEditor(slug);
  const ts = await prisma.teamspace.findFirst({
    where: { id: teamspaceId, workspaceId: ctx.workspace.id },
  });
  if (!ts) throw new Error("not found");
  const t = description.trim();
  await prisma.teamspace.update({
    where: { id: teamspaceId },
    data: { description: t ? t : null },
  });
  revalidatePath(`/w/${slug}`);
}

export async function setTeamspaceAccess(
  slug: string,
  teamspaceId: string,
  access: "open" | "closed" | "private",
) {
  const ctx = await assertEditor(slug);
  const ts = await prisma.teamspace.findFirst({
    where: { id: teamspaceId, workspaceId: ctx.workspace.id },
  });
  if (!ts) throw new Error("not found");
  await prisma.teamspace.update({
    where: { id: teamspaceId },
    data: { access },
  });
  revalidatePath(`/w/${slug}`);
}

export async function archiveTeamspace(slug: string, teamspaceId: string) {
  const ctx = await assertEditor(slug);
  const ts = await prisma.teamspace.findFirst({
    where: { id: teamspaceId, workspaceId: ctx.workspace.id },
  });
  if (!ts) throw new Error("not found");
  await prisma.teamspace.update({
    where: { id: teamspaceId },
    data: { archivedAt: new Date() },
  });
  revalidatePath(`/w/${slug}`);
}

export async function restoreTeamspace(slug: string, teamspaceId: string) {
  const ctx = await assertEditor(slug);
  const ts = await prisma.teamspace.findFirst({
    where: { id: teamspaceId, workspaceId: ctx.workspace.id },
  });
  if (!ts) throw new Error("not found");
  await prisma.teamspace.update({
    where: { id: teamspaceId },
    data: { archivedAt: null },
  });
  revalidatePath(`/w/${slug}`);
}

export async function deleteTeamspace(slug: string, teamspaceId: string) {
  const ctx = await assertEditor(slug);
  const ts = await prisma.teamspace.findFirst({
    where: { id: teamspaceId, workspaceId: ctx.workspace.id },
  });
  if (!ts) throw new Error("not found");
  // Detach pages from this teamspace (move them back to workspace root scope)
  await prisma.page.updateMany({
    where: { teamspaceId, workspaceId: ctx.workspace.id },
    data: { teamspaceId: null },
  });
  await prisma.teamspace.delete({ where: { id: teamspaceId } });
  revalidatePath(`/w/${slug}`);
}

export async function addTeamspaceMember(
  slug: string,
  teamspaceId: string,
  userId: string,
  role: "owner" | "member" = "member",
) {
  const ctx = await assertEditor(slug);
  const ts = await prisma.teamspace.findFirst({
    where: { id: teamspaceId, workspaceId: ctx.workspace.id },
  });
  if (!ts) throw new Error("not found");
  // Confirm the user is actually a workspace member.
  const wsMember = await prisma.workspaceMember.findFirst({
    where: { workspaceId: ctx.workspace.id, userId },
  });
  if (!wsMember) throw new Error("not a workspace member");
  await prisma.teamspaceMember.upsert({
    where: { teamspaceId_userId: { teamspaceId, userId } },
    update: { role },
    create: { teamspaceId, userId, role },
  });
  revalidatePath(`/w/${slug}`);
}

export async function removeTeamspaceMember(
  slug: string,
  teamspaceId: string,
  userId: string,
) {
  const ctx = await assertEditor(slug);
  const ts = await prisma.teamspace.findFirst({
    where: { id: teamspaceId, workspaceId: ctx.workspace.id },
  });
  if (!ts) throw new Error("not found");
  await prisma.teamspaceMember
    .delete({
      where: { teamspaceId_userId: { teamspaceId, userId } },
    })
    .catch(() => undefined);
  revalidatePath(`/w/${slug}`);
}

// Self-service join: any workspace member (including viewers) may add
// themselves to an OPEN teamspace. Closed teamspaces are invite-only and
// private ones are invisible, so neither is joinable this way.
export async function joinTeamspace(slug: string, teamspaceId: string) {
  const ctx = await requireWorkspaceMember(slug);
  const ts = await prisma.teamspace.findFirst({
    where: { id: teamspaceId, workspaceId: ctx.workspace.id },
    select: { access: true },
  });
  if (!ts) throw new Error("not found");
  if (ts.access !== "open") throw new Error("This teamspace is invite-only");
  await prisma.teamspaceMember.upsert({
    where: { teamspaceId_userId: { teamspaceId, userId: ctx.user.id } },
    update: {},
    create: { teamspaceId, userId: ctx.user.id, role: "member" },
  });
  revalidatePath(`/w/${slug}`);
  revalidatePath(`/w/${slug}/teamspace/${teamspaceId}`);
}

// Self-service leave: anyone may remove themselves from a teamspace.
export async function leaveTeamspace(slug: string, teamspaceId: string) {
  const ctx = await requireWorkspaceMember(slug);
  await prisma.teamspaceMember
    .delete({
      where: { teamspaceId_userId: { teamspaceId, userId: ctx.user.id } },
    })
    .catch(() => undefined);
  revalidatePath(`/w/${slug}`);
  revalidatePath(`/w/${slug}/teamspace/${teamspaceId}`);
}

export async function setTeamspaceMemberRole(
  slug: string,
  teamspaceId: string,
  userId: string,
  role: "owner" | "member",
) {
  const ctx = await assertEditor(slug);
  const ts = await prisma.teamspace.findFirst({
    where: { id: teamspaceId, workspaceId: ctx.workspace.id },
  });
  if (!ts) throw new Error("not found");
  // Never leave a teamspace ownerless: block demoting the last remaining owner.
  if (role === "member") {
    const owners = await prisma.teamspaceMember.count({
      where: { teamspaceId, role: "owner" },
    });
    const target = await prisma.teamspaceMember.findUnique({
      where: { teamspaceId_userId: { teamspaceId, userId } },
      select: { role: true },
    });
    if (target?.role === "owner" && owners <= 1) {
      throw new Error("A teamspace must keep at least one owner");
    }
  }
  await prisma.teamspaceMember
    .update({
      where: { teamspaceId_userId: { teamspaceId, userId } },
      data: { role },
    })
    .catch(() => undefined);
  revalidatePath(`/w/${slug}`);
  revalidatePath(`/w/${slug}/teamspace/${teamspaceId}`);
}

export async function movePageToTeamspace(
  slug: string,
  pageId: string,
  teamspaceId: string | null,
) {
  const ctx = await assertEditor(slug);
  const page = await prisma.page.findFirst({
    where: { id: pageId, workspaceId: ctx.workspace.id },
  });
  if (!page) throw new Error("not found");
  if (teamspaceId) {
    const ts = await prisma.teamspace.findFirst({
      where: { id: teamspaceId, workspaceId: ctx.workspace.id },
    });
    if (!ts) throw new Error("teamspace not found");
  }
  // Move the page and all descendants to the same teamspace.
  const descendantIds = new Set<string>([pageId]);
  let frontier = [pageId];
  while (frontier.length > 0) {
    const kids = await prisma.page.findMany({
      where: { parentId: { in: frontier }, workspaceId: ctx.workspace.id },
      select: { id: true },
    });
    frontier = [];
    for (const k of kids) {
      if (!descendantIds.has(k.id)) {
        descendantIds.add(k.id);
        frontier.push(k.id);
      }
    }
  }
  await prisma.page.updateMany({
    where: { id: { in: Array.from(descendantIds) } },
    data: { teamspaceId, parentId: null },
  });
  revalidatePath(`/w/${slug}`);
}

export async function createPageInTeamspace(
  slug: string,
  teamspaceId: string,
  kind: "doc" | "database" = "doc",
) {
  const ctx = await assertEditor(slug);
  const ts = await prisma.teamspace.findFirst({
    where: { id: teamspaceId, workspaceId: ctx.workspace.id },
  });
  if (!ts) throw new Error("teamspace not found");
  const max = await prisma.page.aggregate({
    where: { workspaceId: ctx.workspace.id, parentId: null, teamspaceId },
    _max: { position: true },
  });
  const page = await prisma.page.create({
    data: {
      workspaceId: ctx.workspace.id,
      teamspaceId,
      parentId: null,
      kind,
      title: "Untitled",
      ...(kind === "database" ? { dbSchema: '{"props":[{"id":"p_title","name":"Name","type":"text"}]}' } : {}),
      position: (max._max.position ?? 0) + 1,
      authorId: ctx.user.id,
    },
  });
  await prisma.pageActivity.create({
    data: { pageId: page.id, userId: ctx.user.id, action: "created" },
  });
  revalidatePath(`/w/${slug}`, "layout");
  redirect(`/w/${slug}/p/${page.id}`);
}

export async function reorderTeamspace(
  slug: string,
  teamspaceId: string,
  position: number,
) {
  const ctx = await assertEditor(slug);
  const ts = await prisma.teamspace.findFirst({
    where: { id: teamspaceId, workspaceId: ctx.workspace.id },
  });
  if (!ts) throw new Error("not found");
  await prisma.teamspace.update({
    where: { id: teamspaceId },
    data: { position },
  });
  revalidatePath(`/w/${slug}`);
}

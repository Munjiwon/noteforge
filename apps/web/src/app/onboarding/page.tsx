import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { prisma } from "db";

function slugify(s: string) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32) || "workspace";
}

export default async function OnboardingPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");

  async function create(formData: FormData) {
    "use server";
    const s = await auth();
    if (!s?.user) redirect("/login");
    const name = String(formData.get("name") ?? "My workspace").trim() || "My workspace";
    let slug = slugify(name);
    while (await prisma.workspace.findUnique({ where: { slug } })) {
      slug = `${slugify(name)}-${Math.random().toString(36).slice(2, 6)}`;
    }
    const ws = await prisma.workspace.create({
      data: {
        name,
        slug,
        members: {
          create: { userId: (s.user as any).id, role: "owner" },
        },
        pages: {
          create: {
            title: "Getting started",
            icon: "👋",
            position: 0,
            authorId: (s.user as any).id,
          },
        },
      },
    });
    redirect(`/w/${ws.slug}`);
  }

  return (
    <main className="min-h-screen grid place-items-center bg-sidebar">
      <form action={create} className="w-full max-w-sm bg-white rounded-lg shadow p-8 space-y-4">
        <h1 className="text-2xl font-semibold">Create a workspace</h1>
        <p className="text-sm text-gray-600">A workspace is where your team's pages live.</p>
        <label className="block">
          <span className="text-sm text-gray-600">Workspace name</span>
          <input
            name="name"
            defaultValue={`${session.user?.name ?? "My"}'s workspace`}
            className="mt-1 w-full border rounded px-3 py-2"
            required
          />
        </label>
        <button className="w-full bg-accent text-white rounded py-2 hover:opacity-90">Create</button>
      </form>
    </main>
  );
}

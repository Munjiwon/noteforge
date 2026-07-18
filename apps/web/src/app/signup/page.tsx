import Link from "next/link";
import { redirect } from "next/navigation";
import bcrypt from "bcryptjs";
import { prisma } from "db";
import { signIn } from "@/lib/auth";

const COLORS = ["#ef4444", "#f97316", "#eab308", "#22c55e", "#14b8a6", "#3b82f6", "#8b5cf6", "#ec4899"];

export default function SignupPage({
  searchParams,
}: {
  searchParams: { error?: string };
}) {
  async function register(formData: FormData) {
    "use server";
    const email = String(formData.get("email") ?? "").toLowerCase().trim();
    const username = String(formData.get("username") ?? "").toLowerCase().trim();
    const name = String(formData.get("name") ?? "").trim();
    const password = String(formData.get("password") ?? "");
    if (!email || !name || password.length < 6) redirect("/signup?error=invalid");
    // Username: 3-20 chars, letters/numbers/._-
    if (!/^[a-z0-9._-]{3,20}$/.test(username)) redirect("/signup?error=username");

    const existing = await prisma.user.findFirst({
      where: { OR: [{ email }, { username }] },
    });
    if (existing) redirect("/signup?error=exists");

    const hash = await bcrypt.hash(password, 10);
    await prisma.user.create({
      data: {
        email,
        username,
        name,
        passwordHash: hash,
        color: COLORS[Math.floor(Math.random() * COLORS.length)],
      },
    });
    await signIn("credentials", { identifier: username, password, redirect: false });
    redirect("/");
  }

  return (
    <main className="min-h-screen grid place-items-center bg-sidebar">
      <form
        action={register}
        className="w-full max-w-sm bg-white rounded-lg shadow p-8 space-y-4"
      >
        <h1 className="text-2xl font-semibold">Create account</h1>
        {searchParams.error === "exists" && (
          <p className="text-red-600 text-sm">An account with that email already exists.</p>
        )}
        {searchParams.error === "invalid" && (
          <p className="text-red-600 text-sm">Please fill all fields (password ≥ 6 chars).</p>
        )}
        {searchParams.error === "username" && (
          <p className="text-red-600 text-sm">아이디는 영문/숫자/._- 3~20자여야 합니다.</p>
        )}
        <label className="block">
          <span className="text-sm text-gray-600">Name</span>
          <input name="name" required className="mt-1 w-full border rounded px-3 py-2" />
        </label>
        <label className="block">
          <span className="text-sm text-gray-600">아이디 (Username)</span>
          <input
            name="username"
            required
            autoCapitalize="none"
            autoComplete="username"
            placeholder="예: jiwon"
            pattern="[A-Za-z0-9._\-]{3,20}"
            title="영문/숫자/._- 3~20자"
            className="mt-1 w-full border rounded px-3 py-2"
          />
        </label>
        <label className="block">
          <span className="text-sm text-gray-600">Email</span>
          <input name="email" type="email" required className="mt-1 w-full border rounded px-3 py-2" />
        </label>
        <label className="block">
          <span className="text-sm text-gray-600">Password</span>
          <input
            name="password"
            type="password"
            required
            minLength={6}
            className="mt-1 w-full border rounded px-3 py-2"
          />
        </label>
        <button className="w-full bg-accent text-white rounded py-2 hover:opacity-90">
          Sign up
        </button>
        <p className="text-sm text-gray-600">
          Have an account?{" "}
          <Link href="/login" className="text-accent hover:underline">
            Sign in
          </Link>
        </p>
      </form>
    </main>
  );
}

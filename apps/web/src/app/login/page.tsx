import Link from "next/link";
import { redirect } from "next/navigation";
import { signIn } from "@/lib/auth";

export default function LoginPage({
  searchParams,
}: {
  searchParams: { error?: string };
}) {
  async function login(formData: FormData) {
    "use server";
    const identifier = String(formData.get("identifier") ?? "").toLowerCase().trim();
    const password = String(formData.get("password") ?? "");
    try {
      await signIn("credentials", { identifier, password, redirect: false });
    } catch {
      redirect("/login?error=1");
    }
    redirect("/");
  }

  return (
    <main className="min-h-screen grid place-items-center bg-sidebar p-4">
      <div className="w-full max-w-sm bg-white rounded-lg shadow p-8 space-y-4">
        <div className="text-center space-y-1">
          <div className="text-3xl">📒</div>
          <h1 className="text-2xl font-semibold">Welcome back</h1>
          <p className="text-xs text-gray-500">Sign in to continue to your workspace.</p>
        </div>
        {searchParams.error && (
          <p className="text-red-600 text-sm text-center">아이디(또는 이메일) 또는 비밀번호가 올바르지 않습니다.</p>
        )}
        <form action={login} className="space-y-3">
          <label className="block">
            <span className="text-xs text-gray-600">아이디 또는 이메일</span>
            <input
              name="identifier"
              type="text"
              autoCapitalize="none"
              autoComplete="username"
              required
              className="mt-1 w-full border rounded px-3 py-2 text-sm outline-none focus:border-gray-400 bg-white text-gray-900 placeholder-gray-400"
            />
          </label>
          <label className="block">
            <span className="text-xs text-gray-600">Password</span>
            <input
              name="password"
              type="password"
              required
              minLength={6}
              className="mt-1 w-full border rounded px-3 py-2 text-sm outline-none focus:border-gray-400 bg-white text-gray-900 placeholder-gray-400"
            />
          </label>
          <button className="w-full bg-accent text-white rounded py-2 text-sm hover:opacity-90">
            Sign in
          </button>
        </form>
        <p className="text-xs text-gray-600 text-center">
          No account?{" "}
          <Link href="/signup" className="text-accent hover:underline">
            Create one
          </Link>
        </p>
      </div>
    </main>
  );
}

import Link from "next/link";
import { redirect } from "next/navigation";
import { isGoogleEnabled, signIn } from "@/lib/auth";

export default function LoginPage({
  searchParams,
}: {
  searchParams: { error?: string };
}) {
  async function login(formData: FormData) {
    "use server";
    const email = String(formData.get("email") ?? "");
    const password = String(formData.get("password") ?? "");
    try {
      await signIn("credentials", { email, password, redirect: false });
    } catch {
      redirect("/login?error=1");
    }
    redirect("/");
  }

  async function googleLogin() {
    "use server";
    await signIn("google", { redirectTo: "/" });
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
          <p className="text-red-600 text-sm text-center">Invalid email or password.</p>
        )}
        {isGoogleEnabled && (
          <>
            <form action={googleLogin}>
              <button className="w-full border border-gray-200 rounded py-2 text-sm hover:bg-black/5">
                Continue with Google
              </button>
            </form>
            <div className="flex items-center gap-2 text-[10px] uppercase text-gray-400">
              <span className="flex-1 h-px bg-gray-200" />
              or
              <span className="flex-1 h-px bg-gray-200" />
            </div>
          </>
        )}
        <form action={login} className="space-y-3">
          <label className="block">
            <span className="text-xs text-gray-600">Email</span>
            <input
              name="email"
              type="email"
              required
              className="mt-1 w-full border rounded px-3 py-2 text-sm outline-none focus:border-gray-400"
            />
          </label>
          <label className="block">
            <span className="text-xs text-gray-600">Password</span>
            <input
              name="password"
              type="password"
              required
              minLength={6}
              className="mt-1 w-full border rounded px-3 py-2 text-sm outline-none focus:border-gray-400"
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

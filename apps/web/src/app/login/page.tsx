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
    const email = String(formData.get("email") ?? "");
    const password = String(formData.get("password") ?? "");
    try {
      await signIn("credentials", { email, password, redirect: false });
    } catch {
      redirect("/login?error=1");
    }
    redirect("/");
  }

  return (
    <main className="min-h-screen grid place-items-center bg-sidebar">
      <form
        action={login}
        className="w-full max-w-sm bg-white rounded-lg shadow p-8 space-y-4"
      >
        <h1 className="text-2xl font-semibold">Sign in</h1>
        {searchParams.error && (
          <p className="text-red-600 text-sm">Invalid email or password.</p>
        )}
        <label className="block">
          <span className="text-sm text-gray-600">Email</span>
          <input
            name="email"
            type="email"
            required
            className="mt-1 w-full border rounded px-3 py-2"
          />
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
          Sign in
        </button>
        <p className="text-sm text-gray-600">
          No account?{" "}
          <Link href="/signup" className="text-accent hover:underline">
            Create one
          </Link>
        </p>
      </form>
    </main>
  );
}

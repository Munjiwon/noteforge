import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { prisma } from "db";
import { z } from "zod";

const loginSchema = z.object({
  // Accepts either a username (id) or an email address.
  identifier: z.string().min(1),
  password: z.string().min(6),
});

export const { handlers, signIn, signOut, auth } = NextAuth({
  session: { strategy: "jwt" },
  secret: process.env.AUTH_SECRET,
  trustHost: true,
  pages: { signIn: "/login" },
  providers: [
    Credentials({
      credentials: { identifier: {}, password: {} },
      async authorize(creds) {
        const parsed = loginSchema.safeParse(creds);
        if (!parsed.success) return null;
        const id = parsed.data.identifier.toLowerCase().trim();
        const user = await prisma.user.findFirst({
          where: { OR: [{ username: id }, { email: id }] },
        });
        if (!user) return null;
        const ok = await bcrypt.compare(parsed.data.password, user.passwordHash);
        if (!ok) return null;
        return {
          id: user.id,
          email: user.email,
          name: user.name,
          color: user.color,
        } as any;
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.id = (user as any).id;
        token.color = (user as any).color;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        (session.user as any).id = token.id;
        (session.user as any).color = token.color;
      }
      return session;
    },
  },
});

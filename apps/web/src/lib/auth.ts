import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import Google from "next-auth/providers/google";
import bcrypt from "bcryptjs";
import { randomBytes } from "crypto";
import { prisma } from "db";
import { z } from "zod";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
});

export const isGoogleEnabled =
  !!process.env.AUTH_GOOGLE_ID && !!process.env.AUTH_GOOGLE_SECRET;

const providers = [
  Credentials({
    credentials: { email: {}, password: {} },
    async authorize(creds) {
      const parsed = loginSchema.safeParse(creds);
      if (!parsed.success) return null;
      const user = await prisma.user.findUnique({
        where: { email: parsed.data.email },
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
  ...(isGoogleEnabled
    ? [
        Google({
          clientId: process.env.AUTH_GOOGLE_ID!,
          clientSecret: process.env.AUTH_GOOGLE_SECRET!,
        }),
      ]
    : []),
];

export const { handlers, signIn, signOut, auth } = NextAuth({
  session: { strategy: "jwt" },
  secret: process.env.AUTH_SECRET,
  trustHost: true,
  pages: { signIn: "/login" },
  providers,
  callbacks: {
    async signIn({ user, account }) {
      // For OAuth providers, ensure a local User row exists so the rest of
      // the app (workspaces, comments, etc.) can refer to it.
      if (account?.provider === "google" && user.email) {
        const existing = await prisma.user.findUnique({
          where: { email: user.email },
        });
        if (!existing) {
          await prisma.user.create({
            data: {
              email: user.email,
              name: user.name ?? user.email.split("@")[0],
              passwordHash: randomBytes(32).toString("hex"), // unused but required
              color: "#3b82f6",
            },
          });
        }
      }
      return true;
    },
    async jwt({ token, user }) {
      if (user) {
        token.id = (user as any).id;
        token.color = (user as any).color;
      }
      // For OAuth flows, user.id may be the provider id rather than our DB id.
      // Reconcile by email on first JWT pass.
      if (!token.id && token.email) {
        const local = await prisma.user.findUnique({
          where: { email: token.email as string },
        });
        if (local) {
          token.id = local.id;
          token.color = local.color;
        }
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

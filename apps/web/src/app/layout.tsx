import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "./providers";

export const metadata: Metadata = {
  title: "Collab Notion",
  description: "Self-hosted collaborative workspace",
};

const themeBootstrap = `
(function(){
  try {
    var k = "collab-notion-theme";
    var v = localStorage.getItem(k) || "auto";
    var dark = v === "dark" || (v === "auto" && matchMedia("(prefers-color-scheme: dark)").matches);
    if (dark) document.documentElement.classList.add("dark");
  } catch(e) {}
})();
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
      </head>
      <body className="font-sans antialiased text-ink dark:text-gray-200">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}

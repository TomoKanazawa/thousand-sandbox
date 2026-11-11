import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitepress";

const REPO = "https://github.com/TomoKanazawa/thousand-sandbox";
const docs = join(dirname(fileURLToPath(import.meta.url)), "..");

// AGENTS.md lives at the repository root, where coding agents look for it. The site shows the same text:
// a copy is made here on every build, with its links pointed at the pages of this site.
writeFileSync(
  join(docs, "agents.md"),
  readFileSync(join(docs, "..", "AGENTS.md"), "utf8").replace(/\]\(docs\//g, "](./"),
);
copyFileSync(join(docs, "..", "LICENSE"), join(docs, "public", "LICENSE.txt"));

export default defineConfig({
  title: "Thousand Sandbox",
  description: "An exact working copy of any web app, as a sandbox for testing AI agents.",
  lang: "en",
  cleanUrls: true,
  appearance: "dark",
  // The files keep their upper-case names so links on GitHub work; the site uses lower-case addresses.
  rewrites: {
    "TUTORIAL.md": "tutorial.md",
    "GUIDE.md": "guide.md",
    "STATUS.md": "status.md",
    "CONTRACT.md": "contract.md",
    "FORMATS.md": "formats.md",
  },
  head: [
    [
      "link",
      {
        rel: "icon",
        type: "image/svg+xml",
        href: "/logo.svg",
      },
    ],
    ["link", { rel: "preconnect", href: "https://fonts.googleapis.com" }],
    ["link", { rel: "preconnect", href: "https://fonts.gstatic.com", crossorigin: "" }],
    [
      "link",
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap",
      },
    ],
    ["meta", { name: "theme-color", content: "#0B0A09" }],
  ],
  markdown: {
    // Heading anchors the way GitHub makes them, so a link such as GUIDE.md#3-install works in both places.
    anchor: {
      slugify: (text: string) =>
        text
          .trim()
          .toLowerCase()
          .replace(/[^\p{L}\p{N}\s_-]/gu, "")
          .replace(/\s/g, "-"),
    },
    config(md) {
      // Links that leave the docs folder (example scripts, the test app) go to the file on GitHub.
      const base = md.renderer.rules.link_open ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
      md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
        const token = tokens[idx];
        const href = token?.attrGet("href") ?? "";
        const page = /^(?:\.\/)?(TUTORIAL|GUIDE|STATUS|CONTRACT|FORMATS)\.md(#.*)?$/.exec(href);
        if (page) token?.attrSet("href", `/${page[1]!.toLowerCase()}${page[2] ?? ""}`);
        else if (href === "../AGENTS.md" || href === "agents.md") token?.attrSet("href", "/agents");
        else if (href.startsWith("../")) {
          const path = href.slice(3);
          token?.attrSet("href", `${REPO}/${/\.[a-z]+$/.test(path) ? "blob" : "tree"}/main/${path}`);
        }
        return base(tokens, idx, options, env, self);
      };
    },
  },
  themeConfig: {
    logo: "/logo.svg",
    siteTitle: "Thousand Sandbox",
    nav: [
      { text: "Tutorial", link: "/tutorial" },
      { text: "Guide", link: "/guide" },
      { text: "For agents", link: "/agents" },
      { text: "Status", link: "/status" },
    ],
    sidebar: [
      {
        text: "Start",
        items: [
          { text: "Introduction", link: "/" },
          { text: "Tutorial: the whole tool in 15 minutes", link: "/tutorial" },
        ],
      },
      {
        text: "Use it",
        items: [
          { text: "Guide: your own app", link: "/guide" },
          { text: "For AI agents", link: "/agents" },
        ],
      },
      {
        text: "Reference",
        items: [
          { text: "File formats", link: "/formats" },
          { text: "Handler contract", link: "/contract" },
          { text: "Status: built and missing", link: "/status" },
        ],
      },
    ],
    outline: { level: [2, 3], label: "On this page" },
    search: { provider: "local" },
    socialLinks: [{ icon: "github", link: REPO }],
    editLink: {
      // This function is sent to the browser as text, so it cannot use the constants above.
      pattern: ({ filePath }) =>
        filePath === "agents.md"
          ? "https://github.com/TomoKanazawa/thousand-sandbox/edit/main/AGENTS.md"
          : `https://github.com/TomoKanazawa/thousand-sandbox/edit/main/docs/${filePath}`,
      text: "Edit this page on GitHub",
    },
    footer: {
      message: 'Apache-2.0. <a href="/LICENSE.txt">Licence</a>',
      copyright: "© Thousand, 2026",
    },
  },
});

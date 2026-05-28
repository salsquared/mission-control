// =========================================================================
// doc.js — shared behavior for Mission Control HTML documentation.
//
//   1. Renders Mermaid diagrams (dark/cyan theme to match doc.css).
//   2. Adds hover anchor links to <h2 id> / <h3 id> headings.
//   3. Scroll-spy: highlights the current section in the .toc sidebar.
//
// Loaded as an ES module so it can import Mermaid from a CDN:
//   <script type="module" src="assets/doc.js"></script>
// =========================================================================

import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";

// --- 1. Mermaid -----------------------------------------------------------
mermaid.initialize({
  startOnLoad: true,
  theme: "dark",
  securityLevel: "loose", // allow <br/> + HTML labels (repo convention)
  fontFamily: 'ui-monospace, "JetBrains Mono", Menlo, monospace',
  themeVariables: {
    primaryColor: "#11151a",
    primaryBorderColor: "#22d3ee",
    primaryTextColor: "#d6dde5",
    lineColor: "#5c6773",
    secondaryColor: "#0d1117",
    tertiaryColor: "#0a0c0f",
    clusterBkg: "rgba(34,211,238,0.05)",
    clusterBorder: "rgba(34,211,238,0.25)",
    edgeLabelBackground: "#0d1117",
  },
});

// --- 2. Heading anchors ---------------------------------------------------
document.querySelectorAll("h2[id], h3[id]").forEach((h) => {
  const a = document.createElement("a");
  a.className = "anchor";
  a.href = "#" + h.id;
  a.textContent = "#";
  a.setAttribute("aria-hidden", "true");
  h.appendChild(a);
});

// --- 3. Scroll-spy --------------------------------------------------------
const links = Array.from(document.querySelectorAll(".toc a[href^='#']"));
const byId = new Map(
  links.map((a) => [a.getAttribute("href").slice(1), a])
);
const targets = links
  .map((a) => document.getElementById(a.getAttribute("href").slice(1)))
  .filter(Boolean);

if (targets.length) {
  const spy = new IntersectionObserver(
    (entries) => {
      entries
        .filter((e) => e.isIntersecting)
        .forEach((e) => {
          links.forEach((l) => l.classList.remove("active"));
          const active = byId.get(e.target.id);
          if (active) active.classList.add("active");
        });
    },
    { rootMargin: "0px 0px -75% 0px", threshold: 0 }
  );
  targets.forEach((t) => spy.observe(t));
}

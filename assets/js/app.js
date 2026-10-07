// If you want to use Phoenix channels, run `mix help phx.gen.channel`
// to get started and then uncomment the line below.
// import "./user_socket.js"

// You can include dependencies in two ways.
//
// The simplest option is to put them in assets/vendor and
// import them using relative paths:
//
//     import "../vendor/some-package.js"
//
// Alternatively, you can `bun add some-package --prefix assets` and import
// them using a path starting with the package name:
//
//     import "some-package"
//
// If you have dependencies that try to import CSS, esbuild will generate a separate `app.css` file.
// To load it, simply add a second `<link>` to your `root.html.heex` file.

// Include phoenix_html to handle method=PUT/DELETE in forms and buttons.
import { createIcons, ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Bell, Bold, BookText, CaseSensitive, ChartNoAxesColumn, Check, ChevronDown, ChevronLeft, ChevronRight, CircleCheck, CornerDownLeft, CircleX, CloudUpload, Command, Download, Eye, File, FileInput, FileText, Folder, FolderClosed, FolderOpen, GitBranch, GraduationCap, Heading, History, Image, Info, Italic, Link2, List, LogOut, Minus, Moon, NotebookPen, PenLine, Pin, PinOff, Play, Plus, ReceiptText, RefreshCw, Regex, Replace, ReplaceAll, Search, Settings, Share2, Sigma, Sparkles, SquareTerminal, Star, Sun, Table, Trash2, TriangleAlert, Type, Upload, Users, WholeWord, X as XIcon, Zap } from "lucide"
import { siGithub, siGoogle } from "simple-icons"
import "phoenix_html"
// Establish Phoenix Socket and LiveView configuration.
import {Socket} from "phoenix"
import {LiveSocket} from "phoenix_live_view"
import {hooks as colocatedHooks} from "phoenix-colocated/typster"
import topbar from "../vendor/topbar"
import * as Hooks from "./hooks"
import { bootEmbed } from "./embed_boot"

// Tag the document with the OS family so shortcut hints can show ⌘ on Apple
// platforms and Ctrl everywhere else (CSS toggles `.ts-mac` / `.ts-other`).
// Prefer the modern UA-Client-Hints API, fall back to the (deprecated)
// navigator.platform, then the UA string.
const platformHint =
  navigator.userAgentData?.platform || navigator.platform || navigator.userAgent || ""
document.documentElement.classList.toggle("is-mac", /mac/i.test(platformHint))

const csrfToken = document.querySelector("meta[name='csrf-token']").getAttribute("content")
const liveSocket = new LiveSocket("/live", Socket, {
  longPollFallbackMs: 2500,
  params: {_csrf_token: csrfToken},
  hooks: {
    ...colocatedHooks,
    CodeMirror: Hooks.CodeMirror,
    Preview: Hooks.Preview,
    SaveStatus: Hooks.SaveStatus,
    PreviewZoom: Hooks.PreviewZoom,
    CommandPalette: Hooks.CommandPalette,
    Palette: Hooks.Palette,
    SlashFocus: Hooks.SlashFocus,
    SelectOnMount: Hooks.SelectOnMount,
    LucideIcons: Hooks.LucideIcons,
    Clipboard: Hooks.Clipboard,
    CompileDelay: Hooks.CompileDelay,
    FileTreeDnD: Hooks.FileTreeDnD,
    AssetDrag: Hooks.AssetDrag
  },
})

// Show progress bar on live navigation and form submits
topbar.config({barColors: {0: "#29d"}, shadowColor: "rgba(0, 0, 0, .3)"})
window.addEventListener("phx:page-loading-start", _info => topbar.show(300))
window.addEventListener("phx:page-loading-stop", () => { topbar.hide(); mkIcons(); })

// The embed page (/embed/:token) is framed cross-site, where its SameSite=Lax
// session cookie is blocked — a LiveView socket would never join and the client
// would reload-loop. Boot it standalone (read-only editor + WASM preview, no
// socket). Every other page connects LiveView normally.
if (!bootEmbed()) {
  liveSocket.connect()
}

// expose liveSocket on window for web console debug logs and latency simulation:
// >> liveSocket.enableDebug()
// >> liveSocket.enableLatencySim(1000)  // enabled for duration of browser session
// >> liveSocket.disableLatencySim()
window.liveSocket = liveSocket

const Github = [["path", { d: siGithub.path, fill: "currentColor", stroke: "none" }]]
const Google = [["path", { d: siGoogle.path, fill: "currentColor", stroke: "none" }]]
const mkIconSet = { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Bell, Bold, BookText, CaseSensitive, ChartNoAxesColumn, Check, ChevronDown, ChevronLeft, ChevronRight, CircleCheck, CornerDownLeft, CircleX, CloudUpload, Command, Download, Eye, File, FileInput, FileText, Folder, FolderClosed, FolderOpen, GitBranch, GraduationCap, Heading, History, Image, Info, Italic, Link2, List, LogOut, Minus, Moon, NotebookPen, PenLine, Pin, PinOff, Play, Plus, ReceiptText, RefreshCw, Regex, Replace, ReplaceAll, Search, Settings, Share2, Sigma, Sparkles, SquareTerminal, Star, Sun, Table, Trash2, TriangleAlert, Type, Upload, Users, WholeWord, X: XIcon, Zap, Github, Google }
const mkIcons = (root = document) => {
  createIcons({ icons: mkIconSet, root })
  root.querySelectorAll("svg[data-lucide]").forEach((svg) => svg.removeAttribute("data-lucide"))
}
window.mkIcons = mkIcons
mkIcons()

// ── Set theme explicitly (account-menu appearance segments) ───────────────
// Mirrors toggleMkTheme's persistence ("phx:theme" + data-theme on <html>).
// "system" clears the override so the OS preference wins.
window.setMkTheme = (theme) => {
  if (theme === "system") {
    localStorage.removeItem("phx:theme");
    document.documentElement.removeAttribute("data-theme");
  } else {
    localStorage.setItem("phx:theme", theme);
    document.documentElement.setAttribute("data-theme", theme);
  }
};

// ── Theme toggle (view-transition pour reveal) ────────────────────────────
// The button "pours" the next theme into the page: a round-shaped clip-path
// reveal grows from the toggle's center and drifts a touch downward so it
// reads as liquid spreading by gravity. The outgoing layer is gently lifted
// to feel displaced. While the pour is in flight, the button gains
// `.is-pouring` and tilts like a teapot (CSS keyframes in `_nav.css`).
window.toggleMkTheme = (btn) => {
  const cur = document.documentElement.getAttribute("data-theme")
    ?? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const next = cur === "dark" ? "light" : "dark";

  const apply = () => {
    localStorage.setItem("phx:theme", next);
    document.documentElement.setAttribute("data-theme", next);
  };

  if (!document.startViewTransition || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    apply(); return;
  }
  if (window.__mkPouring) return;
  window.__mkPouring = true;

  const r = btn.getBoundingClientRect();
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  const endRadius = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));

  btn.style.setProperty("--mk-pour-x", `${r.width / 2}px`);
  btn.classList.add("is-pouring");
  setTimeout(() => btn.classList.remove("is-pouring"), 900);

  const t = document.startViewTransition(apply);
  t.ready.then(() => {
    // New theme pours in: round-shaped reveal anchored on the toggle, drifting
    // downward through three keyframes for an organic spread.
    //
    // We deliberately do NOT animate the old layer (no scale/translate/fade):
    // any transform on `::view-transition-old(root)` exposes the new layer
    // beneath at the viewport edges, producing a visible opposite-color
    // border during the transition.
    document.documentElement.animate(
      {
        clipPath: [
          `circle(0px at ${x}px ${y}px)`,
          `circle(${endRadius * 0.18}px at ${x}px ${y + 4}px)`,
          `circle(${endRadius}px at ${x}px ${y + 14}px)`,
        ],
        offset: [0, 0.22, 1],
      },
      { duration: 760, easing: "cubic-bezier(.65, 0, .15, 1)", pseudoElement: "::view-transition-new(root)" }
    );
  });
  t.finished.finally(() => { window.__mkPouring = false; });
};

// ── Nav scroll state ─────────────────────────────────────────────────────
(function initNav() {
  const nav = document.querySelector('.mk-nav');
  if (!nav) return;
  const update = () => nav.classList.toggle('is-scrolled', window.scrollY > 16);
  window.addEventListener('scroll', update, { passive: true });
  update();
})();

// ── Marketing page animations ────────────────────────────────────────────
(function initMotion() {
  if (!('IntersectionObserver' in window)) return;

  // Enable motion styles only when JS is available (progressive enhancement)
  document.body.classList.add('js-motion');

  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('is-visible');
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });

  // Observe individual reveal elements
  document.querySelectorAll('.mk-reveal').forEach(el => observer.observe(el));

  // Observe staggered groups
  document.querySelectorAll('.mk-reveal-group').forEach(el => {
    // Assign --i CSS variable to each child for stagger delay
    Array.from(el.children).forEach((child, i) => {
      child.style.setProperty('--i', i);
    });
    observer.observe(el);
  });
})();

// ── Floating notifications (toast) ───────────────────────────────────────
(function initToasts() {
  const ICONS = {
    success: "circle-check",
    error: "circle-x",
    warning: "triangle-alert",
    info: "info",
    default: "bell",
  };

  let stack = null;
  const getStack = () => {
    if (!stack) {
      stack = document.getElementById('mk-toast-stack');
    }
    if (!stack) {
      stack = document.createElement('div');
      stack.id = 'mk-toast-stack';
      stack.className = 'mk-toast-stack';
      stack.setAttribute('aria-live', 'polite');
      stack.setAttribute('aria-atomic', 'false');
      document.body.appendChild(stack);
    }
    return stack;
  };

  const dismiss = (toast) => {
    if (toast.dataset.dismissed) return;
    toast.dataset.dismissed = '1';
    toast.classList.add('is-leaving');
    setTimeout(() => toast.remove(), 240);
  };

  window.mkToast = (message, { type = 'default', title, duration = 4000 } = {}) => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const icon = ICONS[type] ?? ICONS.default;
    const titleHtml = title ? `<span class="mk-toast-title">${title}</span>` : '';
    const progressHtml = (!reduced && duration > 0)
      ? `<span class="mk-toast-progress" style="animation-duration:${duration}ms"></span>`
      : '';

    const el = document.createElement('div');
    el.className = `mk-toast mk-toast-${type}`;
    el.setAttribute('role', 'status');
    el.innerHTML = `
      <span class="mk-toast-icon"><i data-lucide="${icon}" aria-hidden="true"></i></span>
      <div class="mk-toast-body">${titleHtml}<p class="mk-toast-msg">${message}</p></div>
      <button class="mk-toast-close" aria-label="Dismiss"><i data-lucide="x" aria-hidden="true"></i></button>
      ${progressHtml}
    `;
    mkIcons(el);

    el.querySelector('.mk-toast-close').addEventListener('click', () => dismiss(el));
    getStack().appendChild(el);

    if (duration > 0) setTimeout(() => dismiss(el), duration);
    return () => dismiss(el);
  };
})();

// ── Dialog helpers ────────────────────────────────────────────────────────
window.mkDialogOpen = (backdropEl) => {
  if (!backdropEl) return;
  backdropEl.classList.remove('is-leaving');
  backdropEl.style.display = 'flex';
  const focusable = backdropEl.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
  if (focusable.length) setTimeout(() => focusable[0].focus(), 50);

  if (backdropEl.hasAttribute('data-dismiss-on-backdrop')) {
    backdropEl.addEventListener('click', (e) => {
      if (e.target === backdropEl) window.mkDialogClose(backdropEl);
    }, { once: true });
  }
};

window.mkDialogClose = (backdropEl) => {
  if (!backdropEl) return;
  backdropEl.classList.add('is-leaving');
  backdropEl.addEventListener('animationend', () => {
    backdropEl.style.display = 'none';
    backdropEl.classList.remove('is-leaving');
  }, { once: true });
};

// The lines below enable quality of life phoenix_live_reload
// development features:
//
//     1. stream server logs to the browser console
//     2. click on elements to jump to their definitions in your code editor
//
if (process.env.NODE_ENV === "development") {
  window.addEventListener("phx:live_reload:attached", ({detail: reloader}) => {
    // Enable server log streaming to client.
    // Disable with reloader.disableServerLogs()
    reloader.enableServerLogs()

    // Open configured PLUG_EDITOR at file:line of the clicked element's HEEx component
    //
    //   * click with "c" key pressed to open at caller location
    //   * click with "d" key pressed to open at function component definition location
    let keyDown
    window.addEventListener("keydown", e => keyDown = e.key)
    window.addEventListener("keyup", e => keyDown = null)
    window.addEventListener("click", e => {
      if(keyDown === "c"){
        e.preventDefault()
        e.stopImmediatePropagation()
        reloader.openEditorAtCaller(e.target)
      } else if(keyDown === "d"){
        e.preventDefault()
        e.stopImmediatePropagation()
        reloader.openEditorAtDef(e.target)
      }
    }, true)

    window.liveReloader = reloader
  })
}

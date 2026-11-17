// One domain per process (ego-browser nodejs -e). The wrapper replaces
// __DOMAIN__ / __MODE__ with JSON literals: ego-browser nodejs does not
// inherit the shell env, so values must be inlined.
//
// Gotchas baked in (measured on ego lite):
// - snapshot anchor rows carry a loc=href: field before url=, hence the
//   lazy `[^\]]*?url=` in the regex;
// - the toolbar Delete button is unnamed in the snapshot, so it is clicked
//   by text through shadow DOM;
// - console.log lands on stderr; the wrapper greps the BHP_RESULT line.
const DOMAIN = __DOMAIN__;
const MODE = __MODE__; // "dry-run" | "apply"
const DELETE_LABELS = ["删除", "Delete"];
const CONFIRM_LABELS = ["删除", "移除", "Delete", "Remove"];

const task = await taskSpace(`清理 ego 历史记录：${DOMAIN}`);
const page = task.page("p1");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hostOf = (u) => { try { return new URL(u).hostname.toLowerCase(); } catch { return ""; } };

const deepClick = (labels, inDialog) => page.evaluate(({ labels, inDialog }) => {
  const found = [];
  const walk = (root) => {
    for (const el of root.querySelectorAll("*")) {
      if (/^(CR-BUTTON|BUTTON)$/.test(el.tagName) && labels.includes((el.textContent || "").trim())) found.push(el);
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  };
  walk(document);
  const vis = found.filter((el) => el.offsetParent !== null || el.getClientRects().length);
  const inDlg = (el) => { let n = el; while (n) { if (n.tagName === "CR-DIALOG" || n.tagName === "DIALOG") return true; n = n.parentNode || n.host; } return false; };
  const pick = inDialog ? vis.find(inDlg) : vis.find((el) => !inDlg(el));
  if (!pick) return false;
  pick.click();
  return true;
}, { labels, inDialog });

const search = async () => {
  try { await page.goto(`chrome://history/?q=${encodeURIComponent(DOMAIN)}`, { waitUntil: "load" }); } catch {}
  await sleep(1500);
  const snap = String(await page.snapshot({ scope: "full_page" }));
  const rows = [...snap.matchAll(/checkbox \[ref=(\d+)\][\s\S]*?anchor \[ref=\d+[^\]]*?url=([^\]\s]+)\]/g)];
  return rows.filter((m) => hostOf(m[2]) === DOMAIN);
};

const result = { domain: DOMAIN, mode: MODE, found: 0, deleted: 0, remaining: null, rounds: 0 };
try {
  let hits = await search();
  result.found = hits.length; // first page only; history lazy-loads more on scroll
  if (MODE === "apply") {
    while (hits.length && result.rounds < 20) {
      result.rounds++;
      const batch = hits.slice(0, 60);
      for (const m of batch) await page.click(`ref=${m[1]}`);
      await sleep(400);
      if (!(await deepClick(DELETE_LABELS, false))) { result.error = "delete-button-not-found"; break; }
      await sleep(800);
      if (!(await deepClick(CONFIRM_LABELS, true))) { result.error = "confirm-button-not-found"; break; }
      await sleep(1200);
      result.deleted += batch.length;
      hits = await search();
    }
    // Read back: a fresh search must come back empty.
    result.remaining = (await search()).length;
  }
} catch (e) {
  result.error = String(e && e.message || e);
}
console.log("BHP_RESULT " + JSON.stringify(result));

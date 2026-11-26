# Google Tasks on the agenda tile

Google Tasks has no iCal link, so a tiny Google Apps Script publishes your open tasks as JSON. It
runs as you inside Google; the dashboard only needs its private URL and a token. Read-only: tick
tasks off in Google as usual.

## 1. Create the script

1. Open <https://script.google.com> → **New project**. Rename it (top left), e.g. "Dashboard tasks".
2. Replace the contents of `Code.gs` with [`google-tasks.gs`](google-tasks.gs), and put your token in
   `const TOKEN = "…"` (any long random string; the dashboard needs the same one).
3. Left sidebar: **Services** (the +) → **Google Tasks API** → **Add**.
4. Choose the function **`test`** in the toolbar → **Run**. Google asks for permission:
   **Review permissions** → your account → "Google hasn't verified this app" → **Advanced** →
   **Go to Dashboard tasks (unsafe)** → **Allow**. (It's your own script; the warning is normal.)
   The execution log then lists your open tasks.

## 2. Publish it

5. **Deploy** → **New deployment** → gear icon → **Web app**.
   - Execute as: **Me**
   - Who has access: **Anyone**
6. **Deploy** → copy the **Web app URL** (`https://script.google.com/macros/s/…/exec`).

"Anyone" means anyone with the URL *and* the token can read your open tasks: keep both private.
To stop it, archive the deployment (Deploy → Manage deployments).

## 3. Tell the dashboard

In `~/.config/dashboard/config.toml` on asus-arch:

```toml
[tasks]
url = "https://script.google.com/macros/s/…/exec"
token = "…"            # the same as TOKEN in the script
name = "Tasks"         # how it's listed on the agenda's back (show/hide)
color = "#ffb900"
```

then `systemctl --user restart dashboard`.

If you edit the script later, redeploy with **Deploy → Manage deployments → edit (pencil) →
Version: New version**, which keeps the same URL.

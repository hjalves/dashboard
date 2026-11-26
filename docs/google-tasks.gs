/**
 * Google Tasks → JSON, for the dashboard's agenda tile (read-only).
 *
 * Runs in Google Apps Script as you, published as a web app; the dashboard fetches
 *   <web app URL>?token=<TOKEN>
 * and gets your open tasks. Setup steps: docs/google-tasks.md.
 *
 * Needs the "Google Tasks API" advanced service (Services → + → Google Tasks API).
 */

// Any long random string; the dashboard sends the same one. Replace before deploying.
const TOKEN = "PASTE-THE-TOKEN-HERE";

function doGet(e) {
  if (!e || !e.parameter || e.parameter.token !== TOKEN) {
    return json({ error: "forbidden" });
  }
  return json(openTasks());
}

/** All open (not completed) tasks from every task list. */
function openTasks() {
  const out = [];
  let pageToken;
  do {
    const lists = Tasks.Tasklists.list({ maxResults: 100, pageToken: pageToken });
    for (const list of lists.items || []) {
      let tp;
      do {
        const page = Tasks.Tasks.list(list.id, {
          showCompleted: false, showHidden: false, maxResults: 100, pageToken: tp,
        });
        for (const t of page.items || []) {
          if (!t.title || t.status === "completed") continue;
          out.push({
            title: t.title,
            notes: t.notes || null,
            due: t.due ? t.due.slice(0, 10) : null,  // Tasks keeps only the date of "due"
            list: list.title,
            parent: t.parent || null,
            position: t.position,
            updated: t.updated,
          });
        }
        tp = page.nextPageToken;
      } while (tp);
    }
    pageToken = lists.nextPageToken;
  } while (pageToken);
  return { tasks: out, generated: new Date().toISOString() };
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/** Run this once from the editor to grant access and see your tasks in the log. */
function test() {
  Logger.log(JSON.stringify(openTasks(), null, 2));
}

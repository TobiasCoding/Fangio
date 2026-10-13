# Privacy

Fangio runs entirely on your computer.

- **What it stores**: URL, title, icon, source window and group, and the opened, last
  accessed and archived dates of your tabs, plus whatever you add (notes, tags, projects,
  to-do or protected marks), as well as the action log and the settings.
- **Where**: in the extension's IndexedDB database, inside your browser profile. It is not
  synced with any account. Exports (JSON and HTML) are files you download and keep wherever
  you want.
- **What it doesn't do**: it has no servers, accounts, analytics, advertising or telemetry.
  It doesn't read page content (it has no content scripts) and doesn't record incognito
  tabs.
- **Suggested topics**: the analysis that groups your tabs by topic uses only titles, URLs
  and dates already in the database, and is computed on your computer.
- **Thumbnails (optional, off by default)**: if you enable them, Fangio saves a reduced
  (320 px) capture of the page you are looking at. They stay in the local database, are
  **not** included in JSON backups and are deleted when the record is deleted or with
  "Borrar todas las miniaturas" (Delete all thumbnails). Incognito tabs, excluded sites and
  login, account or payment pages are never captured. To capture automatically, Chrome asks
  for the optional "Read and change all your data on all websites" permission: Fangio only
  uses it to capture the visible tab and gives it back when you turn the option off. Without
  that permission, captures are only taken when you open the popup or archive with the
  keyboard shortcut (`activeTab` permission).
- **Local AI (optional)**: "Nombrar con IA local" (Name with local AI) uses Chrome's
  built-in model (Gemini Nano), which runs on your device; titles are not sent to any
  server. If the model is not installed, Chrome downloads it once (from Google) after you
  confirm; that download is made by the browser, not by Fangio, and includes none of your
  data.
- **The only network connection**: if the check-for-updates option is on (it is by
  default), once a day it queries
  `https://api.github.com/repos/TobiasCoding/Fangio/releases/latest`. The request includes
  no data about you or your tabs; as with any connection, GitHub sees your IP address and
  browser. It can be turned off in the panel settings.
- **Site icons**: they are read from the browser's own cache (`favicon` permission); Fangio
  doesn't visit the sites to get them.
- **Install and update scripts**: they only connect to GitHub (releases API and release
  file downloads) and only write to the extension folder and a temporary folder.
- **Deletion**: deleting records from the trash removes them from the database. Removing
  the extension deletes the whole database. Backups you have exported are not affected.

GitHub's privacy statement: <https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement>.

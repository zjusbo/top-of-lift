# Email alerts backend (Google Apps Script)

GitHub Pages can only serve static files, so sign-ups, the hourly forecast check and the emails run
in a free Google Apps Script attached to a Google Sheet:

- **Subscribers** live in the Sheet (`subscribers` tab), private to your Google account.
- **Sign-up is double opt-in.** The page posts the address, and the script emails a confirmation
  link. Nothing else is sent until that link's button is pressed.
- **Every hour,** the script fetches the HRRR forecast for each site that has subscribers. If a daylight
  hour has top of lift at least 500 ft above launch and launch wind from S, SW or W under 10 mph,
  it emails those subscribers.
- **If an alerted day stops looking flyable** before its flyable window ends, the script sends a
  "Cancelled" email to the people it alerted, with the best remaining hour's numbers. If that day
  turns flyable again, one "Back on" email follows. That's at most 3 emails per site per day.
- Emails go out only between 06:00 and 21:00 local time, and each has an unsubscribe link. The
  `alerts` tab tracks each site and day: status (`sent` or `cancelled`), how many emails went out,
  the end of the flyable window, and who was told.
- **Mail goes out from your Gmail** via `MailApp`, which allows 100 recipients a day on a free
  account.

## One-time setup (about 5 minutes)

1. **Make the Sheet.** Signed in as the account that should send the alerts, open <https://sheets.new>
   and name it "Top of Lift alerts".
2. **Add the script.** In the Sheet, choose **Extensions → Apps Script**. Replace the editor's
   contents with [`Code.gs`](Code.gs), then press **Save**.
3. **Authorize and create the trigger.** In the function menu at the top, pick **`setup`** and click
   **Run**. Google asks for permission to manage the Sheet, send email, call Open-Meteo and run
   triggers. Choose your account. If you see "Google hasn't verified this app", click
   **Advanced → Go to (project) → Allow**. That's normal for your own script.
4. **Publish the sign-up endpoint.** Click **Deploy → New deployment**, then the gear → **Web app**.
   Set **Execute as: Me** and **Who has access: Anyone**, then **Deploy**. Copy the **Web app URL**
   (it ends in `/exec`).
5. **Connect the page.** Put that URL in [`../js/config.js`](../js/config.js) as `ALERTS_ENDPOINT`,
   then commit and push. GitHub Pages redeploys in about a minute.
6. **Test.** Subscribe on the site with your own address, then press the button in the
   confirmation email. You can run `checkAndAlert` from the editor to try an alert right away
   (between 06:00 and 21:00).

## Changing the script later

Edit `Code.gs` in the Apps Script editor, then **Deploy → Manage deployments → Edit (pencil) →
Version: New version → Deploy**. The URL stays the same. Keep `SITES` and the thermal constants in
`CONFIG` in sync with `DEFAULT_SITES` and `THERMAL` in `js/app.js`.

## Updating the deployed script

Paste the new `Code.gs` into the editor and save. The hourly trigger always runs the saved code.
Then update the web app (sign-up and confirm pages) via **Deploy → Manage deployments → Edit →
Version: New version → Deploy**.

## Tests

`node test/alerts.test.mjs` runs this script against mocked Apps Script services. It also checks that
its top of lift and launch wind match the web app on the live HRRR forecast.

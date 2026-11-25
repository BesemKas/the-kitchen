# Kitchen Budget

A small web app for two people to share a shopping list, compare prices between shops, scan barcodes, cost recipes, plan meals for the week and keep groceries inside a monthly budget.

Plain PHP 8.2 + MySQL, no framework, no build step, no Composer.

## Install on cPanel (about 10 minutes)

1. **Create the database.** cPanel → *MySQL® Databases*:
   - Create a database, e.g. `kitchen`, which cPanel names `cpaneluser_kitchen`.
   - Create a user with a strong password.
   - Add the user to the database with **All Privileges**.
2. **Upload the files.** cPanel → *File Manager*. Upload the zip to where the app should live and extract it there. Either:
   - a subdomain, e.g. `kitchen.yourdomain.co.za` (cleanest), or
   - a folder, e.g. `public_html/kitchen`.
3. **Configure.** In `app/`, copy `config.sample.php` to `config.php` and fill in the database name, user and password from step 1.
4. **HTTPS.** Make sure the domain or subdomain has a certificate (cPanel → *SSL/TLS Status* → Run AutoSSL). **The camera, and with it barcode scanning, only works over HTTPS.** The included `.htaccess` redirects HTTP to HTTPS.
5. **PHP version.** cPanel → *MultiPHP Manager*: set PHP 8.2 for that domain. It needs the `pdo_mysql`, `curl` and `mbstring` extensions, which are on by default on almost every host.
6. **Run setup.** Open `https://your-site/setup.php`. Create both logins, set the monthly grocery budget and list your shops (e.g. `Checkers, Shoprite, Pick n Pay`).
7. **Delete `setup.php`** from the server.
8. **Add it to your phones.**
   - iPhone: open it in Safari → Share → *Add to Home Screen*.
   - Android: Chrome → ⋮ → *Install app*.

## How it works

- **Products** are the base of everything. Each has a pack size and unit (e.g. 2000 g, 1 kg, 18 each), an optional barcode and a price **per pack, per shop**. Every time either of you enters a price it is saved to the price history, so the app learns current prices.
- **Scanning.** Tap 📷 on the List or Products tab.
  - A barcode it already knows: you update the price at the shop you're in and add it to the list.
  - A new barcode: it checks Open Food Facts for the name, pack size and nutrition, then asks you to confirm and add a price. Open Food Facts coverage of South African products is patchy, so expect to type some products in yourself.
  - If the camera doesn't work, type the barcode in.
- **List.** Pick the shop you're in at the top. Prices shown are for that shop. If an item has no price there, it shows the price from another shop with an orange tag, and a green tag tells you when another shop is cheaper.
  - *Compare shops* totals the whole list per shop.
  - Tap a price to change it. That teaches the product its price at the current shop.
  - Tick items as they go into the trolley, then **Finish shop**: enter the till-slip total and it is logged against the month's budget.
- **Recipes.** Ingredients are products plus an amount in the product's unit (e.g. 800 g chicken, 0.5 kg rice, 3 eggs). The app works out cost per recipe and per serving using the cheapest known prices, plus nutrition per serving where products have it.
- **Recipes** are the heart of it. Each one has ingredients (a product, an amount in its unit, and a note like "diced"), numbered steps with optional timers, prep and cook time, and how many portions a batch makes.
  - **Servings scaler:** change the portions and every amount, the cost per portion and the packs to buy update.
  - **Portion weights:** weigh the cooked batch and it tells you the grams for each container.
  - **Cook mode:** step-by-step, full screen, with running timers that beep and vibrate, and the screen kept awake. It ends with "Put N portions in the fridge".
  - **Add to list** puts the packs a scaled batch needs on the shopping list.
- **Meals ready (fridge):** each cooked batch is tracked with its date. "Ate one" counts down, and batches turn orange at 3 days old and red at 4. The home screen shows how many meals are ready.
- **Prep day:** on the Plan tab, the app works out portions to cook as planned meals minus what's already in the fridge. *Start prep day* lets you adjust those numbers, then shows one combined gather list. It then runs cook mode for each recipe in turn, and every batch goes into the fridge.
- **Plan my week:** pick the days, how many people are eating, a breakfast, and one or more recipes to rotate for lunch and dinner. The app spreads them out in runs of 2 days (adjustable) so one batch covers several meals. It shows the week's cost against your weekly share of the budget, and protein per person against your target, before you save. It can fill only empty meals or replace the week.
- **Targets:** each of you sets a daily protein and kJ target on the Budget tab. The Plan tab shows each person's day against them.
- **Eating:** tick a planned meal (on the Plan tab or under *Today* on the home screen). Its portions come out of the oldest fridge batch first, and ticking it again puts them back.
- **Takeaways:** a weekly allowance (default R100). One tap logs a takeaway, and it never counts against the grocery budget.
- **Plan.** Tap a day in the strip to see and edit its meals. The *Prep for this week* card adds up everything the week's recipes need, so you know what to cook on prep day.
- Add recipes to days and meals with a number of servings. The week shows total cost against your weekly share of the budget.
  - **Shop for this week** replaces the plan items on the list with the packs the week needs, rounded up to whole packs.
  - **Repeat next week** copies the plan forward.
- **Budget.** Monthly budget, spent, what's left and a per-day / per-week allowance. You can also log spend that didn't come from the list (e.g. a bread-and-milk run).

## Nutrition

Stored per 100 g / 100 ml, or per item for products with unit `each`. Fill it in from Open Food Facts using the button in the product editor (needs a barcode), or type it from the label. Products without nutrition are flagged on recipes rather than counted as zero.

## Backups

`tools/backup.php` is deployed to `~/kitchen-tools/`, outside public_html. It writes `~/kitchen-backups/kitchen-YYYYMMDD-HHMMSS.sql.gz` and keeps the newest 14.

Set it up once in cPanel → **Cron Jobs**, for example daily at 02:15:

```
15 2 * * * /usr/local/bin/php /home1/tru645/kitchen-tools/backup.php >/dev/null 2>&1
```

(If `/usr/local/bin/php` isn't PHP 8.x on your host, use `/opt/alt/php82/usr/bin/php`.)

**Restore:** phpMyAdmin → select the database → Import → choose the `.sql.gz`. Or over SSH: `gunzip < file.sql.gz | mysql -u USER -p DATABASE`.

## Database changes

`app/schema.sql` is version 1. Later changes live in `app/migrations.php`, and they run automatically on the next page load after a deploy. Each one runs once, in order, and the version is recorded in `settings.schema_version`. To change the database, add a new numbered entry. Never edit one that has shipped.

## Updating

Merge to `main`, then in cPanel → Git Version Control → Manage → Pull or Deploy: **Update from Remote**, then **Deploy HEAD Commit**. `app/config.php` is never touched.

## Files

```
index.php            login + app shell
api.php              JSON API (all actions are POST with a CSRF header)
setup.php            one-time installer. Delete after use
app/bootstrap.php    DB, sessions, remember-me, helpers
app/schema.sql       tables (version 1)
app/migrations.php   numbered schema changes, applied automatically
tools/backup.php     nightly backup (CLI only, deployed outside public_html)
app/config.php       your DB details (not in the zip)
assets/app.js        the whole front end (vanilla JS)
assets/app.css       styles ("Night kitchen" dark theme)
assets/fonts/        Inter + Space Grotesk (SIL OFL), self-hosted
assets/zxing-browser.min.js   barcode scanner library (MIT), served locally
```

## Security notes

- Passwords are hashed with `password_hash`.
- Sessions use secure, HTTP-only cookies.
- "Keep me logged in" uses a 60-day hashed token, revoked on log out or password change.
- Every API call needs the session's CSRF token.
- All SQL uses prepared statements.
- `app/` is blocked from the web by its own `.htaccess`.
- A strict Content-Security-Policy blocks inline scripts.

## Offline

The app works with no signal, for example inside a shop:

- `sw.js` (a service worker) keeps the app page, styles, scripts, fonts and the scanner on the phone.
- The last data each screen loaded is kept on the phone, so the list, products, plan and recipes still open.
- Shopping-list changes made offline (add, tick, quantities, prices, finish shop) are saved on the phone and sent when the connection comes back. A bar at the top shows how many are waiting.
- Each offline change has an id, and the server remembers ids for 14 days (`op_log` table), so a change sent twice is only applied once.
- Logging out clears the copy on the phone.

## Accounts

Each login is its own app: shopping list, shops, prices, meal plan, fridge, pantry, budget, takeaways and shopping history all belong to one person.
Shared between everyone:

- **recipes**
- **product facts** that recipes are built from: name, brand, barcode, pack size, nutrition and aisle

A shared recipe is costed with the prices of the person looking at it.

## Health info and label photos

- **Nutri-Score (A–E), processing level (NOVA 1–4) and additives** come from Open Food Facts when it has the product. Products → "Get health ratings" checks every scanned product. Additives are also picked up from E-numbers in a typed ingredient list.
- **Protein per rand** ("R per 10 g protein") shows on products and recipes. Products → "Cheapest protein" ranks protein-rich foods first: those that get at least 20% of their energy from protein.
- **Label form:** type the per 100 g column in the label's order. The app warns when energy doesn't match protein, carbs and fat, which catches per-serving numbers. "Standard values" fills approximate USDA numbers for loose and butchery food (raw or uncooked weight).
- **Label photos** are saved with the product (shrunk to about 150 KB) and only shown to logged-in users.
- **Reading labels from photos (optional):** add `'anthropic_key' => 'sk-ant-…'` to `app/config.php`. Each photo is then read by Claude (`claude-haiku-5-5`, about a cent per label) and the form is filled in for you to check. Leave the key out and photos are only kept for reference.
- **Weighed meat and deli barcodes** (13 digits starting with 2) are shop labels holding a price, not a product, so the app asks which product it is.

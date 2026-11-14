# WhatsApp AI receptionist (trial version)

When someone writes to the WhatsApp number, this server asks Claude for an answer and sends it back.
The company has a private page (`/admin`) to set prices, open hours and how the AI should answer.

## What is inside

- `api/webhook.js`: receives WhatsApp messages, asks Claude, replies, books hours.
- `api/admin.js` and `public/admin.html`: the company's private page, protected by a password.
- `lib/store.js`: saves prices, hours and bookings in a small database.

## Setup for the trial (about 30 to 45 minutes)

Button names on Meta and Vercel change often. If a name below is different, look for the closest one.

### 1. Put the code online (Vercel)

1. Create a new GitHub repository and upload every file in this folder.
2. In Vercel, import that repository as a new project and deploy it.
3. In the project, open Storage and add an Upstash Redis database. Connect it to the project.
   This adds the database keys for you.

### 2. Get a Claude API key

1. Open console.anthropic.com and create an API key.
2. Add a few dollars of credit. Each reply costs a fraction of a cent.

### 3. Get the WhatsApp test number (Meta)

1. Open developers.facebook.com, create an app and add the WhatsApp product.
2. On the API Setup page, copy the temporary access token and the Phone number ID.
3. On the same page, add your own phone to the list of allowed recipients (up to 5 phones).

### 4. Add the settings in Vercel

In the Vercel project, open Settings, then Environment Variables, and add:

| Name | Value |
| --- | --- |
| `ANTHROPIC_API_KEY` | Your Claude API key |
| `WHATSAPP_TOKEN` | The temporary access token from Meta |
| `WHATSAPP_PHONE_NUMBER_ID` | The Phone number ID from Meta |
| `VERIFY_TOKEN` | Optional. A secret word for Meta's check. If you skip it, the admin password is used. |
| `ADMIN_PASSWORD` | Password for the company page (8 characters or more) |
| `OWNER_NUMBERS` | The owner's phone with country code, for example `50760000000`. Separate several with commas. |

Then redeploy the project so it reads the new settings.

### 5. Connect Meta to your server

1. In the Meta app, open WhatsApp, then Configuration.
2. Callback URL: `https://YOUR-PROJECT.vercel.app/api/webhook`
3. Verify token: the same word you used for `VERIFY_TOKEN`, or the admin password if you skipped it.
4. Save, then subscribe to the `messages` field.

### 6. Train the AI

1. Open `https://YOUR-PROJECT.vercel.app/admin` and enter the password.
2. Fill in the open hours, the prices, and how it should answer. Save.

### 7. Try it

From your phone, send a WhatsApp message to the Meta test number. The AI should answer in a few seconds.

The owner can also set hours by WhatsApp. From a phone listed in `OWNER_NUMBERS`, send:

- `Mañana: 9, 12 y 1`
- `Hoy: 3 y 4`

## Limits of the trial

- The temporary Meta token stops working after 24 hours. Generate a new one and update `WHATSAPP_TOKEN`.
- The test number only talks to the phones on your allowed list.
- The server does not yet check Meta's signature on incoming messages. Add that before using a real client's number.
- A real client's number needs Meta business verification, and Coexistence if they want to keep using the WhatsApp Business app.

## Optional settings

| Name | Default | What it does |
| --- | --- | --- |
| `RESEND_API_KEY` | none | Key from resend.com. With it, booking and cancellation alerts go by email to the business email set on the company page. |
| `EMAIL_FROM` | `Recepcionista <onboarding@resend.dev>` | Sender address. The default only delivers to the email of the Resend account; use a verified domain for real clients. |
| `ALWAYS_ANSWER` | none | Set to `1` to answer at any hour, ignoring the closed-only mode. |
| `CLAUDE_MODEL` | `claude-haiku-5-5` | Which Claude model answers |
| `GRAPH_VERSION` | `v25.0` | Meta API version |
| `TIMEZONE` | `America/Panama` | Time zone for hours and dates |
